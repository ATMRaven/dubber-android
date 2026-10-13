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
