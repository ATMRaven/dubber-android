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
        timestamp: new Date().toISOString()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
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

    // Fast AI Translation endpoint
    if (url.pathname === '/api/translate') {
      try {
        const text = url.searchParams.get('text') || '';
        const source = (url.searchParams.get('source') || 'en').split('-')[0].toLowerCase();
        const target = (url.searchParams.get('target') || 'fr').split('-')[0].toLowerCase();

        if (!text || !text.trim()) {
          return new Response(JSON.stringify({ translatedText: '' }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        let translated = '';
        if (env.AI) {
          try {
            // Use Llama 3.2 3B for high-fidelity translation
            const langNames = {
              en: 'English', fr: 'French', ar: 'Arabic', es: 'Spanish',
              de: 'German', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
              ru: 'Russian', it: 'Italian', pt: 'Portuguese', hi: 'Hindi'
            };
            const sName = langNames[source] || source;
            const tName = langNames[target] || target;

            const res = await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
              messages: [
                { role: 'system', content: `You are an ultra-fast real-time translator. Translate the text from ${sName} into natural, accurate ${tName}. Return ONLY the direct translation text. Never add quotes, notes, explanations, or extra words.` },
                { role: 'user', content: text.trim() }
              ],
              max_tokens: 200
            });

            if (res && res.response) {
              translated = res.response.trim().replace(/^["']|["']$/g, '');
            }
          } catch (aiErr) {
            console.warn('Worker AI translation failed:', aiErr);
          }
        }

        return new Response(JSON.stringify({ translatedText: translated }), {
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
              const dgData = await dgRes.json();
              transcribedText = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
            }
          } catch (dgErr) {
            console.warn('Deepgram Nova-2 error, falling back to Whisper:', dgErr);
          }
        }

        // 2. Cloudflare Workers AI Whisper fallback
        if (!transcribedText && env.AI) {
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
