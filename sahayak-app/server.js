// Sahayak backend — serves the frontend, proxies AI calls to Gemini (with
// automatic model fallback), and handles Razorpay subscriptions so premium
// users get unlimited access.

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Gemini setup (unchanged from before — model fallback chain)
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_FALLBACK_ORDER = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
];
if (!GEMINI_API_KEY) {
  console.warn('WARNING: GEMINI_API_KEY is not set.');
}

const REQUESTS_PER_HOUR = 30;
const hits = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const entry = hits.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) { entry.count = 0; entry.start = now; }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > REQUESTS_PER_HOUR;
}

function stripFences(text) {
  return text.replace(/```json|```/g, '').trim();
}

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
    return { ok: false, retriable: true, status: 502, message: networkErr.message };
  }
  if (!response.ok) {
    const status = response.status;
    const retriable = status === 429 || status === 503;
    return { ok: false, retriable, status, message: (data.error && data.error.message) || 'Gemini API error' };
  }
  let text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  text = stripFences(text);
  if (wantsJson) {
    try { JSON.parse(text); }
    catch (parseErr) { return { ok: false, retriable: true, status: 200, message: 'invalid JSON from model' }; }
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Premium status store
//
// NOTE: this is a flat JSON file, good enough to get you running today.
// On free hosting tiers (e.g. Render's free plan) the disk is wiped on every
// restart/redeploy, so paid users could lose their premium status. Before a
// real public launch, swap loadStore/saveStore for a real database (Supabase
// and MongoDB Atlas both have free tiers that persist properly).
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const STORE_PATH = path.join(DATA_DIR, 'subscriptions.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}
function isPremiumUser(userId) {
  if (!userId) return false;
  const store = loadStore();
  return !!(store[userId] && store[userId].isPremium);
}

// ---------------------------------------------------------------------------
// Razorpay setup
// ---------------------------------------------------------------------------
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
const RAZORPAY_PLAN_ID = process.env.RAZORPAY_PLAN_ID; // created once in the Razorpay dashboard

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET || !RAZORPAY_PLAN_ID) {
  console.warn('WARNING: Razorpay env vars missing — subscription endpoints will fail until RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_PLAN_ID are set.');
}

// Creates a Razorpay subscription tied to the plan you set up in the
// dashboard, and hands the frontend just enough info to open Checkout.
app.post('/api/create-subscription', async (req, res) => {
  try {
    const userId = req.header('x-user-id');
    if (!userId) return res.status(400).json({ error: { message: 'missing user id' } });

    const subscription = await razorpay.subscriptions.create({
      plan_id: RAZORPAY_PLAN_ID,
      customer_notify: 1,
      total_count: 12, // renews monthly for up to 12 cycles; Razorpay keeps auto-charging until cancelled
      notes: { sahayak_user_id: userId },
    });

    res.json({
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('create-subscription error:', err);
    res.status(500).json({ error: { message: 'Could not start checkout. Try again in a moment.' } });
  }
});

// Verifies the signature Razorpay Checkout hands back after a successful
// payment, and only then marks the user premium.
app.post('/api/verify-payment', (req, res) => {
  try {
    const userId = req.header('x-user-id');
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;
    if (!userId || !razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ error: { message: 'missing payment details' } });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: { message: 'Payment could not be verified.' } });
    }

    const store = loadStore();
    store[userId] = {
      isPremium: true,
      subscriptionId: razorpay_subscription_id,
      activatedAt: new Date().toISOString(),
    };
    saveStore(store);

    res.json({ success: true });
  } catch (err) {
    console.error('verify-payment error:', err);
    res.status(500).json({ error: { message: 'Could not verify payment.' } });
  }
});

// Frontend calls this on load to know whether to show the free-usage badge
// or the premium badge.
app.get('/api/premium-status', (req, res) => {
  const userId = req.header('x-user-id');
  res.json({ isPremium: isPremiumUser(userId) });
});

// ---------------------------------------------------------------------------
// Main AI proxy endpoint
// ---------------------------------------------------------------------------
app.post('/api/message', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const userId = req.header('x-user-id');
    const premium = isPremiumUser(userId);

    // Premium users skip the IP rate limit too (still generous, just not
    // capped at the free-tier number).
    if (!premium && isRateLimited(ip)) {
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
        return res.json({ content: [{ type: 'text', text: result.text }] });
      }
      lastFailure = result;
      if (!result.retriable) {
        console.error(`Gemini error on ${model} (not retrying):`, result.message);
        return res.status(result.status || 500).json({ error: { message: result.message } });
      }
      console.warn(`Model ${model} failed (${result.message}), trying next fallback...`);
    }

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
