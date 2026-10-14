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
        openrouter_enabled: !!env.OPENROUTER_API_KEY,
        groq_enabled: !!env.GROQ_API_KEY,
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
        const engine = (url.searchParams.get('engine') || 'mistral').toLowerCase();

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

        // 3. Synthesize Speech (Mistral Voxtral for FR/EN or Deepgram Aura-2)
        let audioBlob = null;
        let contentType = 'audio/mpeg';

        if (engine === 'mistral' && (targetLang === 'fr' || targetLang === 'en') && env.MISTRAL_API_KEY) {
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

        // Voice mapping for Deepgram Aura-2
        const tCode = targetLang.split('-')[0].toLowerCase();
        if (tCode === 'ar' && !voiceModel) {
          return new Response(JSON.stringify({ error: 'Deepgram does not support Arabic Aura-2 voices yet. Please use SpeechSynthesis or OpenRouter.' }), {
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

    // Fast AI Translation endpoint (Integrated OpenRouter + Cloudflare Edge AI fallback)
    if (url.pathname === '/api/translate') {
      try {
        let text = '';
        let source = 'en';
        let target = 'fr';
        let model = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';

        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
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

        const langNames = {
          en: 'English', fr: 'French', ar: 'Arabic', es: 'Spanish',
          de: 'German', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
          ru: 'Russian', it: 'Italian', pt: 'Portuguese', hi: 'Hindi',
          tr: 'Turkish', nl: 'Dutch', pl: 'Polish', id: 'Indonesian', vi: 'Vietnamese'
        };
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
