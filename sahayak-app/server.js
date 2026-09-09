// Sahayak backend — serves the frontend and proxies AI calls to Gemini
// so the API key never reaches the browser. Gemini has a free tier that
// doesn't require a credit card.
//
// Includes automatic model fallback: if the primary model is rate-limited
// (429), overloaded (503), or returns broken JSON when JSON was requested,
// the server quietly retries with the next model in the list instead of
// failing the request.

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Tried in order. Each entry is a real Gemini model id.
const MODEL_FALLBACK_ORDER = [
  'gemini-3.6-flash',       // primary
  'gemini-3.5-flash-lite',  // faster, higher rate limits
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];

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

function stripFences(text) {
  return text.replace(/```json|```/g, '').trim();
}

// Calls one specific Gemini model. Returns { ok, status, text, retriable }.
// retriable=true means "worth trying the next model in the list".
async function callGeminiModel(model, { contents, system, cappedTokens, wantsJson }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

  let response, data;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
          maxOutputTokens: cappedTokens,
          ...(wantsJson ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });
    data = await response.json();
  } catch (networkErr) {
    // Network hiccup talking to Google — worth trying the next model.
    return { ok: false, retriable: true, status: 502, message: networkErr.message };
  }

  if (!response.ok) {
    const status = response.status;
    // 429 = rate limited, 503 = overloaded. Both are worth falling back on.
    const retriable = status === 429 || status === 503;
    return { ok: false, retriable, status, message: (data.error && data.error.message) || 'Gemini API error' };
  }

  let text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  text = stripFences(text);

  if (wantsJson) {
    try {
      JSON.parse(text);
    } catch (parseErr) {
      // Model returned something that isn't valid JSON — try the next model.
      return { ok: false, retriable: true, status: 200, message: 'invalid JSON from model' };
    }
  }

  return { ok: true, text };
}

// Converts our Claude-style {system, messages:[{role,content}]} request into
// Gemini's format, tries each model in MODEL_FALLBACK_ORDER until one
// succeeds, and converts the reply back into the shape our frontend expects:
// { content: [{ type: "text", text: "..." }] }
app.post('/api/message', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: { message: 'Too many requests. Try again in a while.' } });
    }

    const { system, messages, max_tokens, json } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages array is required' } });
    }
    const cappedTokens = Math.min(Number(max_tokens) || 1000, 2000);

    const geminiContents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    // When JSON is expected, reinforce it at the very end of the system
    // prompt — this matters most for Telugu/Hindi requests, where the model
    // is more likely to add a conversational aside around the JSON.
    const effectiveSystem = json
      ? `${system || ''}\n\nIMPORTANT: Reply with strictly valid JSON only. No markdown code fences, no explanation, no text before or after the JSON — regardless of what language the content inside the JSON is written in.`
      : system;

    let lastFailure = null;
    for (const model of MODEL_FALLBACK_ORDER) {
      const result = await callGeminiModel(model, {
        contents: geminiContents,
        system: effectiveSystem,
        cappedTokens,
        wantsJson: !!json,
      });

      if (result.ok) {
        if (model !== MODEL_FALLBACK_ORDER[0]) {
          console.log(`Served via fallback model: ${model}`);
        }
        return res.json({ content: [{ type: 'text', text: result.text }] });
      }

      lastFailure = result;
      if (!result.retriable) {
        // Non-retriable error (bad request, auth issue, etc) — stop early.
        console.error(`Gemini error on ${model} (not retrying):`, result.message);
        return res.status(result.status || 500).json({ error: { message: result.message } });
      }
      console.warn(`Model ${model} failed (${result.message}), trying next fallback...`);
    }

    // Every model in the fallback list failed with a retriable error.
    console.error('All fallback models exhausted:', lastFailure);
    return res.status(503).json({
      error: { message: 'All models are currently busy, please wait 30 seconds and try again.' },
    });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: { message: 'Internal server error' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sahayak running on port ${PORT}`));
