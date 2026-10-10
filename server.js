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

// 120s of 16kHz mono 16-bit PCM is ~3.8MB. 8MB leaves generous headroom.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const app = express();
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
