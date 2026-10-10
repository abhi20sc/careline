import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '.env') });

const API_KEY = process.env.ASSEMBLY_AI_KEY;
const ENDPOINT = 'https://dictation.assemblyai.com/v1/transcribe/live';
const PORT = process.env.PORT || 3000;

// Public demo limits, counted in replies (one full call is about 10). 0 turns a limit off.
const IP_LIMIT = Number(process.env.DEMO_IP_LIMIT ?? 40);        // per visitor, per hour
const DAILY_LIMIT = Number(process.env.DEMO_DAILY_LIMIT ?? 500); // everyone, per UTC day
const HOUR_MS = 60 * 60 * 1000;
const recentByIp = new Map(); // ip → request times in the last hour
let day = '';
let usedToday = 0;

/** Returns an error message when this request is over a limit, otherwise counts it. */
function overLimit(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    usedToday = 0;
  }
  if (DAILY_LIMIT && usedToday >= DAILY_LIMIT) {
    return 'The demo has used up today\'s free calls. Please try again tomorrow, or run it yourself from GitHub.';
  }
  const now = Date.now();
  const recent = (recentByIp.get(ip) || []).filter((t) => now - t < HOUR_MS);
  if (IP_LIMIT && recent.length >= IP_LIMIT) {
    return 'You have reached the demo limit for this hour. Please try again later.';
  }
  recent.push(now);
  recentByIp.set(ip, recent);
  usedToday += 1;
  return null;
}

// Forget visitors with no requests in the last hour, so the map stays small.
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of recentByIp) {
    if (!times.some((t) => now - t < HOUR_MS)) recentByIp.delete(ip);
  }
}, HOUR_MS).unref();

// 120s of 16kHz mono 16-bit PCM is ~3.8MB. 8MB leaves generous headroom.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const app = express();
// Behind a host's proxy (Render, etc.) the visitor's address is in X-Forwarded-For.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
app.use(express.static(path.join(here, 'public'), { index: 'careline.html' }));
app.use('/shared', express.static(path.join(here, 'shared')));

// One patient reply: forwards the WAV and the intake instruction, so the key never reaches the browser.
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'ASSEMBLY_AI_KEY is not set in .env' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'No audio uploaded' });
  }
  const limited = overLimit(req.ip);
  if (limited) {
    return res.status(429).json({ error: limited });
  }

  // Only forward parameters the caller actually set — the API rejects nulls.
  let incoming;
  try {
    incoming = JSON.parse(req.body.config || '{}');
  } catch {
    return res.status(400).json({ error: 'config is not valid JSON' });
  }
  const config = {};
  if (incoming.llm_instruction?.trim()) config.llm_instruction = incoming.llm_instruction.trim();
  if (incoming.stt_prompt?.trim()) config.stt_prompt = incoming.stt_prompt.trim();
  if (Array.isArray(incoming.keyterms_prompt) && incoming.keyterms_prompt.length) {
    config.keyterms_prompt = incoming.keyterms_prompt.slice(0, 100);
  }

  const form = new FormData();
  // Order is load-bearing: the endpoint 400s if `audio` arrives before `config`.
  form.append('config', new Blob([JSON.stringify(config)], { type: 'application/json' }));
  form.append('audio', new Blob([req.file.buffer], { type: 'audio/wav' }), 'audio.wav');

  try {
    const upstream = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: API_KEY },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
    const raw = await upstream.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: `Unparseable upstream response: ${raw.slice(0, 300)}` });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: body.detail || body.error || body.title || 'Request failed',
        status: upstream.status,
      });
    }
    res.json(body);
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'Upstream timed out after 90s' : `Proxy error: ${err.message}`,
    });
  }
});

app.listen(PORT, () => {
  console.log(`CareLine:  http://localhost:${PORT}`);
  if (!API_KEY) console.warn('WARNING: ASSEMBLY_AI_KEY missing from .env, so calls will fail.');
});
