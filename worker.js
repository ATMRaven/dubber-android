export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Health / Status endpoint
    if (url.pathname === '/api/status') {
      return new Response(JSON.stringify({
        status: 'ok',
        platform: 'Cloudflare Workers Edge',
        ai_enabled: !!env.AI,
        deepgram_enabled: !!env.DEEPGRAM_API_KEY,
        mistral_enabled: !!env.MISTRAL_API_KEY,
        elevenlabs_enabled: !!env.ELEVENLABS_API_KEY,
        openrouter_enabled: !!env.OPENROUTER_API_KEY,
        groq_enabled: !!env.GROQ_API_KEY,
        groq_tts_enabled: !!env.GROQ_API_KEY,
        timestamp: new Date().toISOString()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // =========================================================================
    // One-Shot Background Edge Dubbing Pipeline (WAV -> Transcribe -> Translate -> TTS -> MP3)
    // =========================================================================
    if (url.pathname === '/api/dub' && request.method === 'POST') {
      try {
        const audioBuffer = await request.arrayBuffer();
        if (!audioBuffer || audioBuffer.byteLength < 500) {
          return new Response(null, { status: 204 });
        }

        const srcLang = (url.searchParams.get('src') || 'en').split('-')[0].toLowerCase();
        const targetLang = (url.searchParams.get('target') || 'fr').split('-')[0].toLowerCase();
        const voice = url.searchParams.get('voice') || '';
        const engineParam = url.searchParams.get('engine');
        const engine = (engineParam || (targetLang === 'fr' ? 'mistral' : 'deepgram')).toLowerCase();

        const reqContentType = request.headers.get('Content-Type') || 'audio/wav';

        // 1. Transcribe Audio (Deepgram Nova-2 <200ms or Groq / Cloudflare fallback)
        let transcribedText = '';
        let deepgramEvaluated = false;
        if (env.DEEPGRAM_API_KEY) {
          try {
            const dgRes = await fetch(`https://api.deepgram.com/v1/listen?model=nova-2&language=${srcLang}&smart_format=true`, {
              method: 'POST',
              headers: {
                'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
                'Content-Type': reqContentType
              },
              body: audioBuffer
            });
            if (dgRes.ok) {
              deepgramEvaluated = true;
              const dgData = await dgRes.json();
              transcribedText = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
            }
          } catch (dgErr) {
            console.warn('Deepgram transcribe error in /api/dub:', dgErr);
          }
        }

        // Fast Groq Whisper fallback if Deepgram had a network failure
        if (!transcribedText && !deepgramEvaluated && env.GROQ_API_KEY) {
          try {
            const formData = new FormData();
            formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
            formData.append('model', 'whisper-large-v3-turbo');
            formData.append('language', srcLang);
            formData.append('temperature', '0.0');

            const groqSttRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}` },
              body: formData
            });
            if (groqSttRes.ok) {
              const groqSttData = await groqSttRes.json();
              transcribedText = groqSttData.text?.trim() || '';
            }
          } catch (groqSttErr) {
            console.warn('Groq Whisper fallback error in /api/dub:', groqSttErr);
          }
        }

        const HALLUCINATIONS = [
          /^\s*thank you[\s.!,]*$/i,
          /^\s*thanks for watching[\s.!,]*$/i,
          /^\s*thank you for watching[\s.!,]*$/i,
          /^\s*please subscribe[\s.!,]*$/i,
          /^\s*subscribe to (my|the) channel[\s.!,]*$/i,
          /^\s*bye[\s.!,]*$/i,
          /^\s*you[\s.!,]*$/i,
          /^\s*subtitles by[\s.!,]*$/i,
          /^\s*\[.*\]\s*$/i,
          /^\s*\(.*\)\s*$/i
        ];

        if (!transcribedText || HALLUCINATIONS.some(rx => rx.test(transcribedText))) {
          if (url.searchParams.get('debug') === '1') {
            return new Response(JSON.stringify({ step: 'transcribe', text: transcribedText, bufferLen: audioBuffer.byteLength, contentType: reqContentType }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return new Response(null, { status: 204 });
        }

        // 2. Translate Text (Groq LPU Tier-1 ~250ms or OpenRouter)
        const langNames = {
          en: 'English', fr: 'French', ar: 'Arabic', es: 'Spanish',
          de: 'German', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
          ru: 'Russian', it: 'Italian', pt: 'Portuguese', hi: 'Hindi',
          tr: 'Turkish', nl: 'Dutch', pl: 'Polish', id: 'Indonesian', vi: 'Vietnamese'
        };
        const srcName = langNames[srcLang] || srcLang;
        const tgtName = langNames[targetLang] || targetLang;

        let translatedText = '';
        if (srcLang === targetLang) {
          translatedText = transcribedText;
        } else if (env.GROQ_API_KEY) {
          try {
            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.GROQ_API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
              },
              body: JSON.stringify({
                model: 'qwen/qwen3.8-27b',
                messages: [
                  {
                    role: 'system',
                    content: `You are an ultra-fast speech dubbing translator. Translate directly from ${srcName} to ${tgtName}. Output ONLY the translated speech. Never provide explanations, alternatives, or quotes.`
                  },
                  { role: 'user', content: transcribedText }
                ],
                temperature: 0.1,
                max_tokens: 150
              })
            });
            if (groqRes.ok) {
              const groqData = await groqRes.json();
              const content = groqData.choices?.[0]?.message?.content?.trim();
              if (content) translatedText = content.replace(/^["']|["']$/g, '').trim();
            } else {
              const errBody = await groqRes.text();
              console.warn('Groq error status in /api/dub:', groqRes.status, errBody);
            }
          } catch (groqErr) {
            console.warn('Groq translate error in /api/dub:', groqErr);
          }
        }

        if (!translatedText && env.OPENROUTER_API_KEY && srcLang !== targetLang) {
          try {
            const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                model: 'meta-llama/llama-3.3-70b-instruct:free',
                messages: [
                  {
                    role: 'system',
                    content: `Translate directly from ${srcName} to ${tgtName}. Output ONLY the translated speech.`
                  },
                  { role: 'user', content: transcribedText }
                ],
                temperature: 0.1,
                max_tokens: 150
              })
            });
            if (orRes.ok) {
              const orData = await orRes.json();
              const content = orData.choices?.[0]?.message?.content?.trim();
              if (content) translatedText = content.replace(/^["']|["']$/g, '').trim();
            }
          } catch (orErr) {
            console.warn('OpenRouter translate error in /api/dub:', orErr);
          }
        }

        if (!translatedText || !translatedText.trim()) {
          if (url.searchParams.get('debug') === '1') {
            return new Response(JSON.stringify({ step: 'translate', original: transcribedText }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return new Response(null, { status: 204 });
        }

        // Sound Artifact & Hallucination Filter:
        // When video game sound effects (car engines, gunshots) cause Deepgram to hallucinate non-English tokens
        // (e.g. "Atashivu" -> "Atashivu", "Bacal" -> "Bacal"), Groq leaves them unchanged. Filter them out!
        if (srcLang !== targetLang) {
          const origClean = transcribedText.toLowerCase().replace(/[^a-z0-9]/g, '');
          const transClean = translatedText.toLowerCase().replace(/[^a-z0-9]/g, '');
          const wordCount = transcribedText.trim().split(/\s+/).length;
          if (wordCount <= 2 && origClean === transClean) {
            return new Response(null, { status: 204 });
          }
        }

        // 3. Synthesize Speech (Groq Orpheus for Arabic/English, ElevenLabs for Arabic/Multilingual, Mistral Voxtral for FR/EN, Deepgram Aura-2)
        let audioBlob = null;
        let contentType = 'audio/mpeg';

        const groqKey = env.GROQ_API_KEY ? env.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '') : null;

        // Groq Canopy Orpheus synthesis (Default for Arabic, high-speed ~200ms speech synthesis for Arabic & English)
        if ((engine === 'groq' || (targetLang === 'ar' && engine !== 'elevenlabs')) && groqKey) {
          try {
            const isArabic = targetLang === 'ar';
            const groqModel = isArabic ? 'canopylabs/orpheus-arabic-saudi' : 'canopylabs/orpheus-v1-english';
            let groqVoice = voice;
            if (!groqVoice || groqVoice.startsWith('aura-') || groqVoice.startsWith('fr_') || groqVoice.length > 20) {
              groqVoice = isArabic ? 'fahad' : 'autumn';
            }
            const groqRes = await fetch('https://api.groq.com/openai/v1/audio/speech', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${groqKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
              },
              body: JSON.stringify({
                model: groqModel,
                voice: groqVoice.toLowerCase(),
                input: translatedText.trim(),
                response_format: 'wav'
              })
            });
            if (groqRes.ok) {
              audioBlob = await groqRes.arrayBuffer();
              contentType = 'audio/wav';
            } else {
              console.warn('Groq TTS error in /api/dub:', await groqRes.text());
            }
          } catch (groqErr) {
            console.warn('Groq TTS fetch error in /api/dub:', groqErr);
          }
        }

        // ElevenLabs Flash v2.5 synthesis (Explicit elevenlabs engine or Arabic fallback)
        if (!audioBlob && (engine === 'elevenlabs' || targetLang === 'ar') && env.ELEVENLABS_API_KEY) {
          try {
            const elVoice = (voice && !voice.startsWith('aura-') && !voice.startsWith('fr_'))
              ? voice
              : 'EXAVITQu4vr4xnSDxMaL'; // Sarah
            const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elVoice)}?output_format=mp3_44100_128`, {
              method: 'POST',
              headers: {
                'xi-api-key': env.ELEVENLABS_API_KEY,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                text: translatedText.trim(),
                model_id: 'eleven_flash_v2_5',
                voice_settings: {
                  stability: 0.5,
                  similarity_boost: 0.75
                }
              })
            });
            if (elRes.ok) {
              audioBlob = await elRes.arrayBuffer();
              contentType = 'audio/mpeg';
            } else {
              console.warn('ElevenLabs TTS error in /api/dub:', await elRes.text());
            }
          } catch (elErr) {
            console.warn('ElevenLabs TTS fetch error in /api/dub:', elErr);
          }
        }

        // Mistral Voxtral route for FR / EN
        if (!audioBlob && engine === 'mistral' && (targetLang === 'fr' || targetLang === 'en') && env.MISTRAL_API_KEY) {
          try {
            const mistralVoice = voice || (targetLang === 'fr' ? 'fr_marie_happy' : 'en_paul_happy');
            const mistralRes = await fetch('https://api.mistral.ai/v1/audio/speech', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.MISTRAL_API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
              },
              body: JSON.stringify({
                model: 'voxtral-mini-tts-latest',
                voice: mistralVoice,
                input: translatedText.trim()
              })
            });
            if (mistralRes.ok) {
              audioBlob = await mistralRes.arrayBuffer();
            }
          } catch (mErr) {
            console.warn('Mistral TTS error in /api/dub:', mErr);
          }
        }

        if (!audioBlob && env.DEEPGRAM_API_KEY) {
          try {
            const voiceMap = {
              fr: 'aura-2-agathe-fr',
              de: 'aura-2-julius-de',
              es: 'aura-2-alvaro-es',
              ja: 'aura-2-ama-ja',
              it: 'aura-2-elio-it',
              nl: 'aura-2-lars-nl',
              en: 'aura-2-thalia-en'
            };
            let dgVoice = voiceMap[targetLang] || 'aura-2-thalia-en';
            if (voice && voice.startsWith('aura-')) {
              dgVoice = voice;
            }
            const dgRes = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(dgVoice)}`, {
              method: 'POST',
              headers: {
                'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ text: translatedText.trim() })
            });
            if (dgRes.ok) {
              audioBlob = await dgRes.arrayBuffer();
            }
          } catch (dgErr) {
            console.warn('Deepgram TTS error in /api/dub:', dgErr);
          }
        }

        if (!audioBlob) {
          if (url.searchParams.get('debug') === '1') {
            return new Response(JSON.stringify({ step: 'tts', original: transcribedText, translated: translatedText, engine, targetLang, mistralKeySet: !!env.MISTRAL_API_KEY }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          return new Response(null, { status: 204 });
        }

        return new Response(audioBlob, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'X-Original-Text': encodeURIComponent(transcribedText),
            'X-Translated-Text': encodeURIComponent(translatedText),
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-Original-Text, X-Translated-Text',
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Deepgram Ultra-Fast TTS Endpoint (Aura-2 French, German, Spanish, English, etc.)
    if (url.pathname === '/api/deepgram/tts') {
      try {
        let text = '';
        let targetLang = 'fr';
        let voiceModel = '';

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          text = body.text || '';
          targetLang = body.target || body.lang || 'fr';
          voiceModel = body.model || '';
        } else {
          text = url.searchParams.get('text') || '';
          targetLang = url.searchParams.get('target') || url.searchParams.get('lang') || 'fr';
          voiceModel = url.searchParams.get('model') || '';
        }

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: 'Missing text' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Voice mapping for Deepgram Aura-2 & Arabic routing
        const tCode = targetLang.split('-')[0].toLowerCase();
        const groqKey = env.GROQ_API_KEY ? env.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '') : null;

        if (tCode === 'ar' && groqKey) {
          try {
            const arVoice = (voiceModel && !voiceModel.startsWith('aura-') && voiceModel.length < 20) ? voiceModel.toLowerCase() : 'fahad';
            const groqRes = await fetch('https://api.groq.com/openai/v1/audio/speech', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${groqKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
              },
              body: JSON.stringify({
                model: 'canopylabs/orpheus-arabic-saudi',
                voice: arVoice,
                input: text.trim(),
                response_format: 'wav'
              })
            });
            if (groqRes.ok) {
              const audioData = await groqRes.arrayBuffer();
              return new Response(audioData, {
                status: 200,
                headers: {
                  'Content-Type': 'audio/wav',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'public, max-age=86400'
                }
              });
            }
          } catch (arErr) {
            console.warn('Groq Arabic TTS error in /api/deepgram/tts:', arErr);
          }
        }

        if (tCode === 'ar' && env.ELEVENLABS_API_KEY) {
          // Seamless ElevenLabs fallback for Arabic
          const elVoice = voiceModel || 'EXAVITQu4vr4xnSDxMaL';
          const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elVoice)}?output_format=mp3_44100_128`, {
            method: 'POST',
            headers: {
              'xi-api-key': env.ELEVENLABS_API_KEY,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              text: text.trim(),
              model_id: 'eleven_flash_v2_5',
              voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
          });
          if (elRes.ok) {
            const audioData = await elRes.arrayBuffer();
            return new Response(audioData, {
              status: 200,
              headers: {
                'Content-Type': 'audio/mpeg',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=86400'
              }
            });
          }
        }
        if (tCode === 'ar' && !voiceModel) {
          return new Response(JSON.stringify({ error: 'Deepgram does not support Arabic Aura-2 voices yet. Please configure Groq or ElevenLabs, or use SpeechSynthesis.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        if (!voiceModel) {
          const voiceMap = {
            fr: 'aura-2-agathe-fr',
            de: 'aura-2-julius-de',
            es: 'aura-2-alvaro-es',
            ja: 'aura-2-ama-ja',
            it: 'aura-2-elio-it',
            nl: 'aura-2-lars-nl',
            en: 'aura-2-thalia-en'
          };
          voiceModel = voiceMap[tCode] || 'aura-2-thalia-en';
        }

        const authHeader = request.headers.get('Authorization');
        const deepgramKey = (authHeader && authHeader.startsWith('Token ')) 
          ? authHeader.slice(6).trim() 
          : (env.DEEPGRAM_API_KEY || '');

        if (!deepgramKey) {
          return new Response(JSON.stringify({ error: 'Deepgram API key not configured' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const dgRes = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voiceModel)}`, {
          method: 'POST',
          headers: {
            'Authorization': `Token ${deepgramKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ text: text.trim() })
        });

        if (!dgRes.ok) {
          const errText = await dgRes.text();
          return new Response(JSON.stringify({ error: `Deepgram TTS failed: ${errText}` }), {
            status: dgRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const audioBlob = await dgRes.arrayBuffer();
        return new Response(audioBlob, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Mistral Voxtral Ultra-Fast Neural TTS Endpoint (English & French)
    if (url.pathname === '/api/mistral/tts') {
      try {
        let text = '';
        let targetLang = 'fr';
        let voice = '';

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          text = body.text || '';
          targetLang = body.target || body.lang || 'fr';
          voice = body.voice || '';
        } else {
          text = url.searchParams.get('text') || '';
          targetLang = url.searchParams.get('target') || url.searchParams.get('lang') || 'fr';
          voice = url.searchParams.get('voice') || '';
        }

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: 'Missing text' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const tCode = targetLang.split('-')[0].toLowerCase();
        if (tCode !== 'fr' && tCode !== 'en') {
          return new Response(JSON.stringify({ error: `Mistral Voxtral TTS supports French and English only. Language '${tCode}' not supported.` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Default voice selection
        if (!voice) {
          voice = tCode === 'fr' ? 'fr_marie_happy' : 'en_paul_happy';
        }

        const authHeader = request.headers.get('Authorization');
        const mistralKey = (authHeader && authHeader.startsWith('Bearer '))
          ? authHeader.slice(7).trim()
          : (env.MISTRAL_API_KEY || '');

        if (!mistralKey) {
          return new Response(JSON.stringify({ error: 'Mistral API key not configured on server' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const mistralRes = await fetch('https://api.mistral.ai/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${mistralKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          },
          body: JSON.stringify({
            model: 'voxtral-mini-tts-latest',
            voice: voice,
            input: text.trim()
          })
        });

        if (!mistralRes.ok) {
          const errText = await mistralRes.text();
          return new Response(JSON.stringify({ error: `Mistral TTS failed: ${errText}` }), {
            status: mistralRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const audioBlob = await mistralRes.arrayBuffer();
        return new Response(audioBlob, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Groq Canopy Orpheus Ultra-Fast Neural TTS Endpoint (Arabic & English High-Speed Synthesis)
    if (url.pathname === '/api/groq/tts') {
      try {
        let text = '';
        let voiceId = '';
        let modelId = '';

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          text = body.text || '';
          if (body.voice) voiceId = body.voice;
          if (body.model) modelId = body.model;
        } else {
          text = url.searchParams.get('text') || '';
          if (url.searchParams.get('voice')) voiceId = url.searchParams.get('voice');
          if (url.searchParams.get('model')) modelId = url.searchParams.get('model');
        }

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: 'Missing text' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const groqKey = env.GROQ_API_KEY ? env.GROQ_API_KEY.trim().replace(/^["']|["']$/g, '') : null;
        if (!groqKey) {
          return new Response(JSON.stringify({ error: 'Groq API key not configured on server' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Auto-detect language / model if not explicitly specified
        const hasArabic = /[\u0600-\u06FF]/.test(text);
        const arVoices = ['fahad', 'sultan', 'noura', 'lulwa', 'aisha'];
        const isArVoice = voiceId && arVoices.includes(voiceId.toLowerCase());

        if (!modelId) {
          if (hasArabic || isArVoice) {
            modelId = 'canopylabs/orpheus-arabic-saudi';
          } else {
            modelId = 'canopylabs/orpheus-v1-english';
          }
        }

        if (!voiceId) {
          voiceId = (modelId.includes('arabic') || hasArabic) ? 'fahad' : 'autumn';
        }

        const groqRes = await fetch('https://api.groq.com/openai/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
          },
          body: JSON.stringify({
            model: modelId,
            voice: voiceId.toLowerCase(),
            input: text.trim(),
            response_format: 'wav'
          })
        });

        if (!groqRes.ok) {
          const errText = await groqRes.text();
          return new Response(errText, {
            status: groqRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const audioBytes = await groqRes.arrayBuffer();
        return new Response(audioBytes, {
          status: 200,
          headers: {
            'Content-Type': 'audio/wav',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ElevenLabs Ultra-Fast Neural TTS Endpoint (Arabic & Multilingual Flash v2.5)
    if (url.pathname === '/api/elevenlabs/tts') {
      try {
        let text = '';
        let voiceId = 'EXAVITQu4vr4xnSDxMaL'; // Sarah - fluent Arabic
        let modelId = 'eleven_flash_v2_5';

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          text = body.text || '';
          if (body.voice) voiceId = body.voice;
          if (body.model) modelId = body.model;
        } else {
          text = url.searchParams.get('text') || '';
          if (url.searchParams.get('voice')) voiceId = url.searchParams.get('voice');
          if (url.searchParams.get('model')) modelId = url.searchParams.get('model');
        }

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ error: 'Missing text' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const elevenKey = env.ELEVENLABS_API_KEY;
        if (!elevenKey) {
          return new Response(JSON.stringify({ error: 'ElevenLabs API key not configured on server' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
          method: 'POST',
          headers: {
            'xi-api-key': elevenKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: text.trim(),
            model_id: modelId,
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          })
        });

        if (!elRes.ok) {
          const errText = await elRes.text();
          return new Response(errText, {
            status: elRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const audioBytes = await elRes.arrayBuffer();
        return new Response(audioBytes, {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // =========================================================================
    // InnerTube YouTube Transcript Pre-Fetch & Chunk Merging API
    // =========================================================================
    if (url.pathname === '/api/youtube/transcript') {
      try {
        let videoId = '';
        let srcLang = 'en';

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          videoId = body.videoId || body.url || '';
          srcLang = body.srcLang || body.source || srcLang;
        } else {
          videoId = url.searchParams.get('videoId') || url.searchParams.get('v') || url.searchParams.get('url') || '';
          srcLang = url.searchParams.get('srcLang') || url.searchParams.get('source') || srcLang;
        }

        // Clean videoId
        const match = videoId.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
        if (match && match[1]) {
          videoId = match[1];
        } else {
          videoId = videoId.trim();
        }

        if (!videoId || videoId.length < 5) {
          return new Response(JSON.stringify({ error: 'Missing or invalid videoId', hasCaptions: false }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        srcLang = srcLang.split('-')[0].toLowerCase();

        // 1. Fetch player response using InnerTube API (WEB client first as specified)
        let captionTracks = [];
        let playerJson = null;

        const webPayload = {
          context: {
            client: {
              hl: 'en',
              gl: 'US',
              clientName: 'WEB',
              clientVersion: '2.20250101.00.00'
            }
          },
          videoId: videoId
        };

        try {
          const ytRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
            },
            body: JSON.stringify(webPayload)
          });
          if (ytRes.ok) {
            playerJson = await ytRes.json();
            captionTracks = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          }
        } catch (webErr) {
          console.warn('InnerTube WEB client failed:', webErr.message);
        }

        // 1b. If no tracks found, fallback to Android VR client spoofing
        if (!captionTracks || captionTracks.length === 0) {
          try {
            const androidPayload = {
              context: {
                client: {
                  clientName: 'ANDROID_VR',
                  clientVersion: '1.60.19',
                  deviceMake: 'Oculus',
                  deviceModel: 'Quest 3',
                  osName: 'Android',
                  osVersion: '12',
                  hl: 'en',
                  gl: 'US'
                }
              },
              videoId: videoId
            };
            const ytAndroidRes = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              body: JSON.stringify(androidPayload)
            });
            if (ytAndroidRes.ok) {
              const aJson = await ytAndroidRes.json();
              captionTracks = aJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            }
          } catch (aErr) {
            console.warn('InnerTube Android client failed:', aErr.message);
          }
        }

        // 1c. If still no tracks, fallback to watch page HTML ytInitialPlayerResponse
        if (!captionTracks || captionTracks.length === 0) {
          try {
            const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
              }
            });
            if (watchRes.ok) {
              const html = await watchRes.text();
              const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});(?:var\s|const\s|let\s|<\/script>)/);
              if (match && match[1]) {
                const wJson = JSON.parse(match[1]);
                captionTracks = wJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
              }
            }
          } catch (wErr) {
            console.warn('Watch page caption parsing failed:', wErr.message);
          }
        }

        // If no caption tracks at all (e.g. live stream or captions disabled) -> Fallback mode!
        if (!captionTracks || captionTracks.length === 0) {
          return new Response(JSON.stringify({
            hasCaptions: false,
            videoId: videoId,
            message: 'No captions available on this video. Fallback to real-time STT required.',
            captionTracks: [],
            mergedChunks: []
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // 2. Select primary language track (prefer manual captions over kind === "asr")
        let selectedTrack = captionTracks.find(t => t.languageCode?.toLowerCase().startsWith(srcLang) && t.kind !== 'asr');
        if (!selectedTrack) {
          selectedTrack = captionTracks.find(t => t.languageCode?.toLowerCase().startsWith(srcLang));
        }
        if (!selectedTrack) {
          selectedTrack = captionTracks.find(t => t.languageCode?.toLowerCase().startsWith('en') && t.kind !== 'asr');
        }
        if (!selectedTrack) {
          selectedTrack = captionTracks.find(t => t.kind !== 'asr');
        }
        if (!selectedTrack) {
          selectedTrack = captionTracks[0];
        }

        const baseUrl = selectedTrack.baseUrl;
        if (!baseUrl) {
          return new Response(JSON.stringify({
            hasCaptions: false,
            videoId: videoId,
            message: 'Caption track baseUrl is empty.',
            captionTracks: [],
            mergedChunks: []
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // 3. Append &fmt=json3 to baseUrl and fetch structured transcript JSON
        const json3Url = baseUrl.includes('fmt=')
          ? baseUrl.replace(/fmt=[^&]+/, 'fmt=json3')
          : `${baseUrl}&fmt=json3`;

        const transcriptRes = await fetch(json3Url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (!transcriptRes.ok) {
          return new Response(JSON.stringify({
            hasCaptions: false,
            videoId: videoId,
            message: `Transcript fetch returned HTTP ${transcriptRes.status}`,
            captionTracks: [],
            mergedChunks: []
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const transcriptJson = await transcriptRes.json().catch(() => null);
        const events = transcriptJson?.events || [];

        // 4. Parse events array into clean array of segments:
        // { startMs: event.tStartMs, durationMs: event.dDurationMs, text: <concatenated segs.utf8> }
        const rawSegments = [];
        for (const ev of events) {
          if (!ev.segs || !Array.isArray(ev.segs)) continue;
          let text = ev.segs.map(s => s.utf8 || '').join('').trim();
          text = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
          if (!text || text === '\n') continue;
          const cleanedText = text.replace(/^[♪♫\s]+|[♪♫\s]+$/g, '').trim();
          if (!cleanedText) continue;

          rawSegments.push({
            startMs: parseInt(ev.tStartMs || 0, 10),
            durationMs: parseInt(ev.dDurationMs || 0, 10),
            text: cleanedText
          });
        }

        if (rawSegments.length === 0) {
          return new Response(JSON.stringify({
            hasCaptions: false,
            videoId: videoId,
            message: 'No transcript dialogue events parsed.',
            captionTracks: [],
            mergedChunks: []
          }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // 5. Sentence Merging & Normalization (targeting 3–8s per chunk, breath groups, startMs & endMs)
        const mergedChunks = mergeSegments(rawSegments, 3000, 8000, 1200);

        return new Response(JSON.stringify({
          hasCaptions: true,
          videoId: videoId,
          selectedTrack: {
            languageCode: selectedTrack.languageCode,
            kind: selectedTrack.kind || 'manual',
            name: selectedTrack.name?.simpleText || selectedTrack.languageCode
          },
          captionTracksCount: captionTracks.length,
          rawSegmentsCount: rawSegments.length,
          mergedChunksCount: mergedChunks.length,
          mergedChunks: mergedChunks
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });

      } catch (err) {
        return new Response(JSON.stringify({
          hasCaptions: false,
          error: err.message,
          mergedChunks: []
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Fast AI Translation endpoint (Integrated OpenRouter + Cloudflare Edge AI fallback)
    if (url.pathname === '/api/translate') {
      try {
        let text = '';
        let source = 'en';
        let target = 'fr';
        let model = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

        const langNames = {
          en: 'English', fr: 'French', ar: 'Arabic', es: 'Spanish',
          de: 'German', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
          ru: 'Russian', it: 'Italian', pt: 'Portuguese', hi: 'Hindi',
          tr: 'Turkish', nl: 'Dutch', pl: 'Polish', id: 'Indonesian', vi: 'Vietnamese'
        };

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));

          // Batch translation of transcript chunks
          if (body.chunks && Array.isArray(body.chunks) && body.chunks.length > 0) {
            const chunks = body.chunks;
            source = (body.source || 'en').split('-')[0].toLowerCase();
            target = (body.target || 'fr').split('-')[0].toLowerCase();
            const sName = langNames[source] || source;
            const tName = langNames[target] || target;

            if (source === target) {
              const direct = chunks.map(c => ({ id: c.id, translatedText: c.text }));
              return new Response(JSON.stringify({ success: true, translations: direct, provider: 'identity' }), {
                headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
              });
            }

            if (env.GROQ_API_KEY) {
              try {
                const systemPrompt = `You are an expert film and video dubbing translator. Translate the following timestamped dialogue chunks from ${sName} into natural, concise spoken ${tName}.\nCRITICAL RULES:\n1. Match the spoken duration of the original chunk closely so it fits the audio window without rushing or dragging.\n2. Output STRICTLY a valid JSON array of objects with the exact schema: [{"id": string, "translatedText": string}].\n3. Preserve the exact chunk IDs.\n4. Do NOT output markdown code blocks, comments, or explanations.`;
                const promptPayload = chunks.map(c => ({
                  id: c.id,
                  text: c.text,
                  durationSec: Math.round((c.durationMs || 4000) / 100) / 10
                }));

                const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                  },
                  body: JSON.stringify({
                    model: 'qwen/qwen3.8-27b',
                    messages: [
                      { role: 'system', content: systemPrompt },
                      { role: 'user', content: JSON.stringify(promptPayload) }
                    ],
                    temperature: 0.2,
                    max_tokens: 1500
                  })
                });

                if (groqRes.ok) {
                  const groqData = await groqRes.json();
                  const rawContent = groqData?.choices?.[0]?.message?.content || '';
                  const cleanedJson = rawContent
                    .replace(/^```json\s*/i, '')
                    .replace(/^```\s*/i, '')
                    .replace(/\s*```$/i, '')
                    .trim();

                  try {
                    const parsed = JSON.parse(cleanedJson);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                      return new Response(JSON.stringify({
                        success: true,
                        translations: parsed,
                        provider: 'groq-batch (qwen/qwen3.8-27b)'
                      }), {
                        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                      });
                    }
                  } catch (pErr) {
                    console.warn('Batch JSON parse error:', pErr.message);
                  }
                }
              } catch (groqErr) {
                console.warn('Groq batch translation error:', groqErr.message);
              }
            }

            // Fallback for batch
            return new Response(JSON.stringify({
              success: true,
              translations: chunks.map(c => ({ id: c.id, translatedText: c.text })),
              provider: 'identity-fallback'
            }), {
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
            });
          }

          text = body.text || '';
          source = (body.source || 'en').split('-')[0].toLowerCase();
          target = (body.target || 'fr').split('-')[0].toLowerCase();
          model = body.model || model;
        } else {
          text = url.searchParams.get('text') || '';
          source = (url.searchParams.get('source') || 'en').split('-')[0].toLowerCase();
          target = (url.searchParams.get('target') || 'fr').split('-')[0].toLowerCase();
          model = url.searchParams.get('model') || model;
        }

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ translatedText: '' }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        const sName = langNames[source] || source;
        const tName = langNames[target] || target;

        let translated = '';
        let usedProvider = '';

        // 1. Tier 1: Groq LPU Ultra-Fast Translation (~250-350ms, Qwen 3.8 27B)
        if (env.GROQ_API_KEY) {
          try {
            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.GROQ_API_KEY}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
              },
              body: JSON.stringify({
                model: 'qwen/qwen3.8-27b',
                messages: [
                  { role: 'system', content: `You are an ultra-fast real-time speech translator. Translate the text from ${sName} into fluent, natural ${tName}. Output ONLY the direct translated phrase with zero explanations, zero quotes, and zero preamble.` },
                  { role: 'user', content: text.trim() }
                ],
                max_tokens: 250,
                temperature: 0.1
              })
            });

            if (groqRes.ok) {
              const groqData = await groqRes.json();
              const content = groqData?.choices?.[0]?.message?.content;
              if (content && content.trim()) {
                translated = content.trim().replace(/^["']|["']$/g, '');
                usedProvider = 'groq (qwen/qwen3.8-27b)';
              }
            }
          } catch (groqErr) {
            console.warn('Groq translation error, trying fallback:', groqErr);
          }
        }

        // 2. Tier 2: Cloudflare Workers AI (@cf/meta/llama-3.2-3b-instruct)
        if (!translated && env.AI) {
          try {
            const res = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
              messages: [
                { role: 'system', content: `You are an ultra-fast real-time translator. Translate the text from ${sName} into natural, accurate ${tName}. Return ONLY the direct translation text. Never add quotes, notes, explanations, or extra words.` },
                { role: 'user', content: text.trim() }
              ],
              max_tokens: 200
            });

            if (res && res.response) {
              translated = res.response.trim().replace(/^["']|["']$/g, '');
              usedProvider = 'cloudflare-workers-ai (llama-3.2-3b)';
            }
          } catch (aiErr) {
            console.warn('Worker AI translation failed:', aiErr);
          }
        }

        // 3. Tier 3: OpenRouter Server-Side Fallback
        if (!translated && env.OPENROUTER_API_KEY) {
          try {
            const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://dubber-web.pages.dev',
                'X-Title': 'Dubber Studio'
              },
              body: JSON.stringify({
                model: model,
                messages: [
                  { role: 'system', content: `You are an ultra-fast real-time speech translator. Translate the text from ${sName} into fluent, natural ${tName}. Output ONLY the direct translated phrase with zero explanations, zero quotes, and zero preamble.` },
                  { role: 'user', content: text.trim() }
                ],
                max_tokens: 250,
                temperature: 0.1
              })
            });

            if (orRes.ok) {
              const orData = await orRes.json();
              const content = orData?.choices?.[0]?.message?.content;
              if (content && content.trim()) {
                translated = content.trim().replace(/^["']|["']$/g, '');
                usedProvider = `openrouter (${model})`;
              }
            }
          } catch (orErr) {
            console.warn('Server OpenRouter translation failed:', orErr);
          }
        }

        return new Response(JSON.stringify({ translatedText: translated, provider: usedProvider }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, translatedText: '' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // Speech-to-Text (Hybrid: Deepgram Nova-2 primary if configured -> Workers AI Whisper backup)
    if (url.pathname === '/api/transcribe' && request.method === 'POST') {
      try {
        const audioBuffer = await request.arrayBuffer();
        if (!audioBuffer || audioBuffer.byteLength < 100) {
          return new Response(JSON.stringify({ text: '' }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        const srcLang = (url.searchParams.get('lang') || 'en').split('-')[0].toLowerCase();
        let transcribedText = '';
        let deepgramSucceeded = false;

        // 1. Deepgram Nova-2 (Ultra-fast <200ms)
        if (env.DEEPGRAM_API_KEY) {
          try {
            const dgRes = await fetch(`https://api.deepgram.com/v1/listen?model=nova-2&language=${srcLang}&smart_format=true`, {
              method: 'POST',
              headers: {
                'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
                'Content-Type': 'audio/wav'
              },
              body: audioBuffer
            });
            if (dgRes.ok) {
              deepgramSucceeded = true;
              const dgData = await dgRes.json();
              transcribedText = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
            }
          } catch (dgErr) {
            console.warn('Deepgram Nova-2 error, falling back to Whisper:', dgErr);
          }
        }

        // 2. Cloudflare Workers AI Whisper fallback (ONLY if Deepgram was unavailable or request failed)
        if (!deepgramSucceeded && env.AI) {
          try {
            const audioArray = [...new Uint8Array(audioBuffer)];
            const aiResponse = await env.AI.run('@cf/openai/whisper', {
              audio: audioArray
            });
            if (aiResponse && aiResponse.text) {
              transcribedText = aiResponse.text.trim();
            }
          } catch (aiErr) {
            console.warn('Workers AI Whisper error:', aiErr);
          }
        }

        // Anti-hallucination filter: discard Whisper/Nova-2 silence artifacts
        const HALLUCINATIONS = [
          /^\s*thank you[\s.!,]*$/i,
          /^\s*thanks for watching[\s.!,]*$/i,
          /^\s*thank you for watching[\s.!,]*$/i,
          /^\s*please subscribe[\s.!,]*$/i,
          /^\s*subscribe to (my|the) channel[\s.!,]*$/i,
          /^\s*bye[\s.!,]*$/i,
          /^\s*you[\s.!,]*$/i,
          /^\s*subtitles by[\s.!,]*$/i,
          /^\s*\[.*\]\s*$/i,
          /^\s*\(.*\)\s*$/i
        ];

        if (HALLUCINATIONS.some(rx => rx.test(transcribedText))) {
          transcribedText = '';
        }

        return new Response(JSON.stringify({ text: transcribedText }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message, text: '' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // Static Assets from Cloudflare edge
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Dubber edge endpoint active', { status: 200 });
  }
};

/**
 * Sentence Merging & Normalization
 * Combines short fragmented caption events into cohesive 3-8s breath/thought groups
 */
function mergeSegments(segments, minDurationMs = 3000, maxDurationMs = 8000, maxGapMs = 1200) {
  if (!segments || segments.length === 0) return [];

  const chunks = [];
  let current = null;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segStart = seg.startMs;
    const segDur = seg.durationMs;
    const segEnd = segStart + segDur;
    const segText = seg.text.trim();
    if (!segText) continue;

    if (!current) {
      current = {
        startMs: segStart,
        endMs: segEnd,
        text: segText,
        segCount: 1
      };
      continue;
    }

    const currentDuration = current.endMs - current.startMs;
    const gapMs = segStart - current.endMs;
    const endsWithPunct = /[.!?؟]$/.test(current.text);

    let shouldClose = false;
    if (gapMs >= maxGapMs) {
      shouldClose = true;
    } else if (currentDuration >= minDurationMs && endsWithPunct) {
      shouldClose = true;
    } else if (currentDuration + segDur > maxDurationMs && currentDuration >= minDurationMs) {
      shouldClose = true;
    }

    if (shouldClose) {
      current.durationMs = current.endMs - current.startMs;
      chunks.push(current);
      current = {
        startMs: segStart,
        endMs: segEnd,
        text: segText,
        segCount: 1
      };
    } else {
      current.text = `${current.text} ${segText}`.replace(/\s+/g, ' ').trim();
      current.endMs = segEnd;
      current.segCount++;
    }
  }

  if (current) {
    current.durationMs = current.endMs - current.startMs;
    chunks.push(current);
  }

  // Calculate targetDurationMs = nextChunk.startMs - currentChunk.startMs
  for (let i = 0; i < chunks.length; i++) {
    chunks[i].id = `chunk_${i}`;
    if (i < chunks.length - 1) {
      chunks[i].targetDurationMs = chunks[i + 1].startMs - chunks[i].startMs;
    } else {
      chunks[i].targetDurationMs = chunks[i].durationMs;
    }
  }

  return chunks;
}
