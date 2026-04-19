module.exports = async function handler(req, res) {
  const token = process.env.CHRONOS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  if (!token) {
    return res.status(500).json({ ok: false, message: 'Server token not configured. Set CHRONOS_GITHUB_TOKEN or GITHUB_TOKEN in Vercel env.' });
  }

  const target = req.query.url;
  if (!target || typeof target !== 'string') {
    return res.status(400).json({ ok: false, message: 'Missing url query parameter' });
  }

  if (!target.startsWith('https://api.github.com/')) {
    return res.status(400).json({ ok: false, message: 'Only https://api.github.com/* is allowed' });
  }

  try {
    const upstream = await fetch(target, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ChronOS-Vercel-Proxy',
        Authorization: `Bearer ${token}`
      }
    });

    const bodyText = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);

    return res.send(bodyText || '{}');
  } catch (error) {
    return res.status(500).json({ ok: false, message: error && error.message ? error.message : 'Upstream request failed' });
  }
};
