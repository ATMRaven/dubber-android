async function addToArchive() {
  const payload = {
    title: 'Dubber',
    description: "Ultra-fast real-time speech translation and live video audio dubbing utility. Powered by Deepgram Aura-2 neural voices, Cloudflare edge proxy, sub-second streaming audio synthesis, and mobile background capture.",
    url: 'https://dubber.atmr.workers.dev',
    category: 'tool',
    hidden: false
  };

  console.log('Sending Dubber project to Cloudflare project-archive endpoint...');
  const res = await fetch('https://project-archive.atmr.workers.dev/api/projects', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  console.log(`HTTP ${res.status}:`, text);
}

addToArchive();
