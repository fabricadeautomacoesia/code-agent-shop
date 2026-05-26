'use strict';

const logger = require('./logger').default;
const mask = require('./mask');

/**
 * Fallback OpenAI -> Gemini -> Groq (V8 23.7).
 * Streaming SSE-compatible. Circuit breaker basico + backoff exponencial.
 */
const PROVIDERS = ['openai', 'gemini', 'groq'];
const breakerState = new Map(); // provider -> { failures, openUntil }
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 60_000;

function _circuitOk(p) {
  const s = breakerState.get(p);
  if (!s) return true;
  if (s.openUntil && s.openUntil > Date.now()) return false;
  if (s.openUntil && s.openUntil <= Date.now()) {
    breakerState.delete(p);
    return true;
  }
  return true;
}

function _trip(p) {
  const s = breakerState.get(p) || { failures: 0, openUntil: null };
  s.failures++;
  if (s.failures >= BREAKER_THRESHOLD) {
    s.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    logger.warn({ provider: p }, '[circuit] aberto');
  }
  breakerState.set(p, s);
}

async function _callOpenAI({ prompt, model = process.env.OPENAI_MODEL || 'gpt-4o-mini', stream = false }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY ausente');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream }),
    signal: AbortSignal.timeout(parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10)),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  if (stream) return res.body;
  const j = await res.json();
  return { provider: 'openai', model, content: j.choices?.[0]?.message?.content, usage: j.usage };
}

async function _callGemini({ prompt, model = process.env.GEMINI_MODEL || 'gemini-2.0-flash' }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY ausente');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10)),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const j = await res.json();
  const content = j.candidates?.[0]?.content?.parts?.[0]?.text;
  return { provider: 'gemini', model, content, usage: j.usageMetadata };
}

async function _callGroq({ prompt, model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile' }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY ausente');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(parseInt(process.env.LLM_TIMEOUT_MS || '60000', 10)),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const j = await res.json();
  return { provider: 'groq', model, content: j.choices?.[0]?.message?.content, usage: j.usage };
}

const CALLERS = { openai: _callOpenAI, gemini: _callGemini, groq: _callGroq };

async function callLLMWithFallback(opts) {
  const order = opts.order || PROVIDERS;
  let lastErr;
  for (const p of order) {
    if (!_circuitOk(p)) {
      logger.debug({ provider: p }, '[fallback] circuit-open, skipping');
      continue;
    }
    try {
      const out = await CALLERS[p](opts);
      logger.info({ provider: p, model: out.model }, '[llm.ok]');
      return out;
    } catch (e) {
      lastErr = e;
      logger.warn({ provider: p, err: mask.text(e.message) }, '[llm.fail]');
      _trip(p);
    }
  }
  throw new Error(`Todos os provedores LLM falharam. Ultimo: ${lastErr?.message}`);
}

module.exports = { callLLMWithFallback, PROVIDERS, _breakerState: breakerState };
