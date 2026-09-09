# Sahayak — deploy guide

This folder is a complete, deployable app: a small backend (`server.js`) that
keeps your Gemini API key secret, plus the frontend (`public/index.html`)
that talks to it.

## What you need first
1. A **free** Gemini API key: go to https://aistudio.google.com/apikey,
   sign in with any Google account, click "Create API key" — no card needed
2. A free account on **Render.com** (easiest for beginners) or Railway.app

## Deploy on Render (free tier)
1. Push this whole `sahayak-app` folder to a new GitHub repo
2. On Render.com → **New +** → **Web Service** → connect that repo
3. Settings:
   - Build command: `npm install`
   - Start command: `npm start`
4. Under **Environment**, add a variable:
   - Key: `GEMINI_API_KEY`
   - Value: your key from Google AI Studio
5. Deploy. Render gives you a live URL like `https://sahayak-xyz.onrender.com`
   — that's your app, live on the internet, at zero cost.

## Run it on your own laptop first (recommended before deploying)
```
cd sahayak-app
npm install
export GEMINI_API_KEY=your-key-here
npm start
```
Then open `http://localhost:3000` in your browser.

## Cost control built in
- Server caps every request at 1200 output tokens
- Each visitor is limited to 30 requests/hour (resets hourly) — adjust
  `REQUESTS_PER_HOUR` in `server.js` if you want it looser or tighter
- Gemini's free tier has its own daily limits too — if you outgrow them
  later (real traffic, paying users), that's a good problem to have and
  worth revisiting a paid plan then

## Next steps once it's live
- Wrap it as an Android app with **Capacitor** so it can go on the Play Store
- Add a usage cap or ₹ paywall (e.g. 5 free summaries/quizzes a day, then a
  small subscription) once you have real users

