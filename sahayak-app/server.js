// Sahayak backend — serves the frontend and proxies AI calls to Gemini
// so the API key never reaches the browser. Gemini has a free tier that
// doesn't require a credit card.

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';

if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set. Set it in your host\'s environment variables.');
}

// Simple in-memory rate limiter per IP (resets every hour) — keeps usage predictable.
const REQUESTS_PER_HOUR = 30;
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > REQUESTS_PER_HOUR;
}

// Converts our Claude-style {system, messages:[{role,content}]} request into
// Gemini's format, and converts Gemini's reply back into the same shape our
// frontend already expects: { content: [{ type: "text", text: "..." }] }
app.post('/api/message', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: { message: 'Too many requests. Try again in a while.' } });
    }

    const { system, messages, max_tokens } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages array is required' } });
    }
    const cappedTokens = Math.min(Number(max_tokens) || 1000, 1200);

    const geminiContents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: geminiContents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: { maxOutputTokens: cappedTokens },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Gemini API error:', data);
      return res.status(response.status).json({ error: { message: (data.error && data.error.message) || 'Gemini API error' } });
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    res.json({ content: [{ type: 'text', text }] });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: { message: 'Internal server error' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sahayak running on port ${PORT}`));

