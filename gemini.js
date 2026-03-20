// In-memory rate limiter (per serverless instance)
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 1000;
const MAX_IMAGE_SIZE_MB = 4;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: { message: 'Too many requests. Please wait a moment.' } });
  }

  try {
    const { password, payload } = req.body;

    const correctPassword = process.env.APP_PASSWORD;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!correctPassword || !apiKey) {
      return res.status(500).json({ error: { message: 'Server not configured. Set APP_PASSWORD and GEMINI_API_KEY in Vercel env vars.' } });
    }

    if (password !== correctPassword) {
      return res.status(401).json({ error: { message: 'Incorrect password.' } });
    }

    const imageData = payload?.body?.contents?.[0]?.parts?.[0]?.inline_data?.data;
    if (imageData) {
      const sizeMB = (imageData.length * 0.75) / (1024 * 1024);
      if (sizeMB > MAX_IMAGE_SIZE_MB) {
        return res.status(413).json({ error: { message: `Image too large (${sizeMB.toFixed(1)}MB). Max is ${MAX_IMAGE_SIZE_MB}MB.` } });
      }
    }

    const model = payload.model || 'gemini-2.5-flash-lite';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload.body),
      signal: AbortSignal.timeout(30000)
    });

    const data = await response.json();
    res.status(response.status).json(data);

  } catch (err) {
    if (err.name === 'TimeoutError') {
      res.status(504).json({ error: { message: 'Request timed out. Try a smaller image.' } });
    } else {
      res.status(500).json({ error: { message: err.message } });
    }
  }
}
