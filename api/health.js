module.exports = async function handler(req, res) {
  const token = process.env.CHRONOS_GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  return res.status(200).json({
    ok: true,
    mode: 'vercel-proxy',
    tokenLoaded: Boolean(token),
    tokenSource: token ? 'vercel-env' : 'missing-env',
    utc: new Date().toISOString()
  });
};
