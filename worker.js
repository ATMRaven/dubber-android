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
        timestamp: new Date().toISOString()
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
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

    // Speech-to-Text via Cloudflare Workers AI Whisper
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

        let transcribedText = '';

        if (env.AI) {
          try {
            const audioArray = [...new Uint8Array(audioBuffer)];
            const aiResponse = await env.AI.run('@cf/openai/whisper', {
              audio: audioArray
            });
            if (aiResponse && aiResponse.text) {
              transcribedText = aiResponse.text.trim();
            }
          } catch (aiErr) {
            console.warn('Workers AI Whisper error, falling back:', aiErr);
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
