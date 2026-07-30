const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

// Custom error class for structured error handling
class ErrorWithCode extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'ErrorWithCode';
  }
}

// Add sharp for image validation
let sharp;
try {
  sharp = require('sharp');
  console.log('[Server] Sharp available for image validation');
} catch (e) {
  console.warn('[Server] Sharp not available, using basic image validation');
  sharp = null;
}

const app = express();

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per windowMs
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    details: 'Too many requests. Please try again later.'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  keyGenerator: (req) => {
    return req.ip; // Use client IP address
  }
});

// CORS Configuration
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : (origin, callback) => callback(null, true), // Allow all origins in local dev (including Electron file:// = null origin)
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-user-provider', 'x-user-api-key']
}));

app.use(express.json({ limit: '10mb' }));

// Surface body-parser errors (e.g. payload too large, malformed JSON) as a
// clear response instead of Express's default bare 500 — and log them so
// we can actually see this class of failure in Render logs.
app.use((err, req, res, next) => {
  if (err) {
    console.error('[Server] Body parsing error:', err.type || err.name, err.message);
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'PAYLOAD_TOO_LARGE',
        details: 'Request body too large. Try a smaller image.'
      });
    }
    return res.status(400).json({
      error: 'BAD_REQUEST',
      details: 'Malformed request body.'
    });
  }
  next();
});

require('dotenv').config(); // Load .env variables if present

// Provider configurations from env vars
function parseKeyPool(envVar) {
  if (!envVar) return [];
  return envVar.split(',').map(k => k.trim()).filter(Boolean);
}

function parseAzurePool(envVar) {
  if (!envVar) return [];
  try {
    const parsed = JSON.parse(envVar);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const PROVIDER_POOLS = {
  groq: {
    keys: parseKeyPool(process.env.GROQ_API_KEYS),
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
    formatRequest: (body) => body,
    formatResponse: (data) => data.choices?.[0]?.message?.content || '',
    authHeader: (key) => `Bearer ${key}`,
    supportsVision: false
  },
  groqVision: {
    // Reuse the same Groq API keys for vision — groqVision is just a different model on the same API
    keys: parseKeyPool(process.env.GROQ_API_KEYS),
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
    formatRequest: (body) => body,
    formatResponse: (data) => data.choices?.[0]?.message?.content || '',
    authHeader: (key) => `Bearer ${key}`,
    supportsVision: true
  },
  gemini: {
    keys: parseKeyPool(process.env.GEMINI_API_KEYS),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    formatRequest: (body) => body,
    formatResponse: (data) => data.candidates?.[0]?.content?.parts?.[0]?.text || '',
    authHeader: (key) => `${key}`, // passed as query param
    supportsVision: true
  },
  openai: {
    keys: parseKeyPool(process.env.OPENAI_API_KEYS),
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    formatRequest: (body) => body,
    formatResponse: (data) => data.choices?.[0]?.message?.content || '',
    authHeader: (key) => `Bearer ${key}`,
    supportsVision: true
  },
  azure: {
    keys: parseAzurePool(process.env.AZURE_OPENAI_KEYS),
    baseUrl: null, // per-key endpoint
    model: null,   // per-key deployment
    formatRequest: (body) => body,
    formatResponse: (data) => data.choices?.[0]?.message?.content || '',
    authHeader: (key) => `Bearer ${key.key}`,
    supportsVision: true
  },
  anthropic: {
    keys: parseKeyPool(process.env.ANTHROPIC_API_KEYS),
    baseUrl: 'https://api.anthropic.com/v1/messages',
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    formatRequest: (body) => ({
      model: body.model,
      messages: body.messages,
      max_tokens: body.max_tokens || 4096,
      temperature: body.temperature ?? 0
    }),
    formatResponse: (data) => data.content?.[0]?.text || '',
    authHeader: (key) => `Bearer ${key}`,
    supportsVision: true
  }
};

const allowedTypes = new Set([
  'work', 'study', 'break', 'meal', 'sleep',
  'exercise', 'personal', 'commute', 'other'
]);

const poolIndices = { groq: 0, groqVision: 0, gemini: 0, openai: 0, azure: 0, anthropic: 0 };
const keyCooldowns = {}; // key -> timestamp when 429 cooldown ends

function getNextKey(provider, userKey) {
  const pool = PROVIDER_POOLS[provider];
  if (!pool || !pool.keys.length) return null;

  // User provided their own key
  if (userKey) {
    return { key: userKey, isUserKey: true };
  }

  const now = Date.now();
  const keys = pool.keys;
  const startIdx = poolIndices[provider] || 0;

  for (let i = 0; i < keys.length; i++) {
    const idx = (startIdx + i) % keys.length;
    const key = keys[idx];
    const cooldownKey = `${provider}:${typeof key === 'object' ? key.key : key}`;

    if (!keyCooldowns[cooldownKey] || keyCooldowns[cooldownKey] < now) {
      poolIndices[provider] = (idx + 1) % keys.length;
      return { key, isUserKey: false };
    }
  }

  // All keys in cooldown, return first anyway (will retry)
  poolIndices[provider] = (startIdx + 1) % keys.length;
  return { key: keys[startIdx], isUserKey: false };
}

function markKeyCooldown(provider, key) {
  const keyStr = typeof key === 'object' ? key.key : key;
  keyCooldowns[`${provider}:${keyStr}`] = Date.now() + 60000; // 60s cooldown
}

// ============================================================
// Validation Helpers
// ============================================================

async function validateBase64(base64) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    // Validate base64 padding
    if (base64.length % 4 !== 0) return false;
    // Validate base64 format
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;

    // Validate image content if sharp is available
    if (sharp) {
      try {
        await sharp(buffer).metadata();
        return true;
      } catch {
        return false;
      }
    }

    // Fallback: validate buffer size
    return buffer.length > 0;
  } catch {
    return false;
  }
}

function getImageSize(base64) {
  return Buffer.from(base64, 'base64').length;
}

// ============================================================
// Vision & Text Provider Helpers
// ============================================================

async function callProvider(provider, userKey, body) {
  const pool = PROVIDER_POOLS[provider];
  if (!pool) throw new Error(`Unknown provider: ${provider}`);

  const keyInfo = getNextKey(provider, userKey);
  if (!keyInfo) throw new Error(`No API keys configured for ${provider}`);

  const key = keyInfo.key;
  const isUserKey = keyInfo.isUserKey;
  const authHeader = pool.authHeader(key);
  const baseUrl = pool.baseUrl || (typeof key === 'object' ? key.endpoint : '');
  const model = pool.model || (typeof key === 'object' ? key.deployment : '');

  if (provider === 'azure' && !baseUrl) {
    throw new Error('Azure endpoint not configured');
  }

  const requestBody = pool.formatRequest({ ...body, model: model || body.model });

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const currentKeyInfo = attempt === 0 ? keyInfo : getNextKey(provider, userKey);
    if (!currentKeyInfo) break;

    const currentKey = currentKeyInfo.key;
    const currentAuth = pool.authHeader(currentKey);
    let url;

    if (provider === 'gemini') {
      url = `${baseUrl}/${model}:generateContent?key=${currentKey}`;
    } else if (provider === 'azure') {
      url = `${baseUrl}/openai/deployments/${model}/chat/completions?api-version=${typeof currentKey === 'object' ? currentKey.apiVersion : '2024-08-01-preview'}`;
    } else {
      url = pool.baseUrl;
    }

    try {
      const headers = {
        'Content-Type': 'application/json'
      };
      if (provider !== 'gemini') {
        headers['Authorization'] = currentAuth;
      } else {
        // For Gemini, auth is in query param, but we still need the key for the request
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      if (response.status === 429) {
        markKeyCooldown(provider, currentKey);
        lastError = new Error('Rate limited');
        continue;
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `Provider error: ${response.status}`);
      }

      const data = await response.json();
      return { data: pool.formatResponse(data), keySource: isUserKey ? 'user' : 'pool' };
    } catch (err) {
      lastError = err;
      if (err.message === 'Rate limited') continue;
      break;
    }
  }

  throw lastError || new Error('All provider keys exhausted');
}

async function askProvider(provider, userKey, text) {
  // Build the prompt for text-only parsing
  const systemPrompt = `You are LuxShift, an AI parser for night schedule planning. Convert a user's natural-language day or night description into structured schedule blocks. If the input is only a preference, opinion, identity statement, or generic interest, return empty blocks. If the input contains a planned activity, intended action, time reference, or clear day-plan context, return blocks. Respond ONLY with a valid JSON object — no markdown, no code fences, no explanation. Use this exact structure:
{
  "summary": "short summary of the plan",
  "confidence": 0.85,
  "reasons": ["reason one", "reason two"],
  "blocks": [
    {
      "id": "block_1",
      "type": "work",
      "title": "Block title",
      "note": "Short note",
      "timeLabel": "10 PM – 1 AM",
      "start": "22:00",
      "end": "01:00",
      "certainty": 0.9
    }
  ]
}
Types allowed: work, unwind, leisure, sleep, wake, break, general. Use 24-hour HH:MM for start/end, or null if unknown. Confidence and certainty are numbers 0–1.`;

  const body = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text }
    ],
    temperature: 0.1,
    max_tokens: 1500
  };

  const result = await callProvider(provider, userKey, body);
  return result.data;
}

async function askVisionProvider(_provider, userKey, images) {
  const keys = PROVIDER_POOLS.gemini?.keys || [];
  if (!keys.length) {
    throw new ErrorWithCode('No Gemini API keys configured. Add GEMINI_API_KEYS to Render environment variables.', 'NO_API_KEYS');
  }

  const key = userKey || keys[poolIndices.gemini % keys.length];
  poolIndices.gemini = (poolIndices.gemini + 1) % keys.length;
  const model = PROVIDER_POOLS.gemini.model;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const systemPrompt = `You are LuxShift, an AI parser for night schedule planning. Analyze the provided image(s) which may contain a timetable, calendar screenshot, message, email, or handwritten schedule. Extract any schedule information and convert it into structured schedule blocks. Respond ONLY with a valid JSON object — no markdown, no code fences, no explanation. Use this exact structure:
{
  "summary": "short summary of the plan",
  "confidence": 0.85,
  "reasons": ["reason one", "reason two"],
  "blocks": [
    {
      "id": "block_1",
      "type": "work",
      "title": "Block title",
      "note": "Short note",
      "timeLabel": "10 PM – 1 AM",
      "start": "22:00",
      "end": "01:00",
      "certainty": 0.9
    }
  ]
}
Types allowed: work, unwind, leisure, sleep, wake, break, general. Use 24-hour HH:MM for start/end, or null if unknown. Confidence and certainty are numbers 0–1.`;

  const parts = [
    { text: systemPrompt + '\n\nExtract schedule information from the provided image(s).' },
    ...images.map(img => ({
      inlineData: {
        mimeType: img.mimeType || 'image/jpeg',
        data: img.base64
      }
    }))
  ];

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1500,
      responseMimeType: 'text/plain'
    },
    safetySettings: [
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      },
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE"
      }
    ]
  };

  // Retry logic for transient failures
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err?.error?.message || `Gemini vision request failed (${response.status})`;
        throw new Error(msg);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!text) {
        throw new Error('Gemini returned an empty response. The image may be unclear or unsupported.');
      }

      return { choices: [{ message: { role: 'assistant', content: text } }] };
    } catch (err) {
      lastError = err;
      if (attempt < 2) { // Retry twice (3 attempts total)
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

function cleanJson(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function normalizeSchedule(parsed) {
  if (!parsed) return { summary: '', confidence: 0, reasons: [], blocks: [] };

  const blocks = Array.isArray(parsed.blocks) ? parsed.blocks.map((block, index) => ({
    id: block.id || `block_${index + 1}`,
    type: allowedTypes.has(block.type) ? block.type : 'general',
    title: block.title || 'Schedule Block',
    note: block.note || 'Parsed from your day description.',
    timeLabel: block.timeLabel || 'Unspecified',
    start: /^\d{2}:\d{2}$/.test(block.start) ? block.start : null,
    end: /^\d{2}:\d{2}$/.test(block.end) ? block.end : null,
    certainty: Math.max(0, Math.min(1, Number(block.certainty) || 0.7))
  })) : [];

  return {
    summary: parsed.summary || '',
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || (blocks.length ? 0.72 : 0.18))),
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter(r => typeof r === 'string').slice(0, 8) : [],
    blocks
  };
}

// Parse schedule endpoint
app.post('/parse-schedule', apiLimiter, async (req, res) => {
  try {
    // Validate API key if provided
    const apiKey = req.headers['x-api-key'];
    if (process.env.REQUIRE_API_KEY && apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: 'UNAUTHORIZED', details: 'Invalid API key.' });
    }

    const text = String(req.body?.text || '').trim();
    const images = Array.isArray(req.body?.images) ? req.body.images : [];

    if (!text && images.length === 0) return res.status(400).json({ error: 'MISSING_INPUT', details: 'Missing text or images.' });
    if (text.length > 8000) {
      return res.status(400).json({ error: 'TEXT_TOO_LONG', details: 'Schedule text is too long. Keep it under 8,000 characters.' });
    }

    // Validate images
    const MAX_IMAGES = 2;
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
    const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

    if (images.length > MAX_IMAGES) {
      return res.status(400).json({
        error: 'IMAGE_LIMIT_EXCEEDED',
        details: `Maximum ${MAX_IMAGES} images allowed.`
      });
    }

    for (const img of images) {
      // Validate base64 format
      if (!img.base64) {
        return res.status(400).json({
          error: 'MISSING_IMAGE_DATA',
          details: 'No image data provided.'
        });
      }
      if (typeof img.base64 !== 'string') {
        return res.status(400).json({
          error: 'INVALID_IMAGE_TYPE',
          details: 'Image data must be a string.'
        });
      }

      // Validate base64 integrity
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(img.base64)) {
        return res.status(400).json({
          error: 'INVALID_BASE64_FORMAT',
          details: 'Image data is not valid base64.'
        });
      }
      if (img.base64.length % 4 !== 0) {
        return res.status(400).json({
          error: 'INVALID_BASE64_PADDING',
          details: 'Image data has incorrect base64 padding.'
        });
      }

      // Validate MIME type
      if (!ALLOWED_MIME_TYPES.includes(img.mimeType)) {
        return res.status(400).json({
          error: 'UNSUPPORTED_IMAGE_TYPE',
          details: `Unsupported image type: ${img.mimeType}. Use PNG, JPG, or WebP.`
        });
      }

      // Validate size
      const size = getImageSize(img.base64);
      if (size > MAX_IMAGE_SIZE) {
        return res.status(400).json({
          error: 'IMAGE_TOO_LARGE',
          details: `Image too large. Maximum ${MAX_IMAGE_SIZE/1024/1024}MB per image.`
        });
      }
    }

    // Read provider and key from headers
    const userProvider = req.headers['x-user-provider'] || 'gemini';
    const userKey = req.headers['x-user-api-key'] || null;

    let rawResponse;
    let keySource = 'pool';
    let effectiveProvider = userProvider;

    // Smart model selection: auto-detect if vision is needed
    const needsVision = images.length > 0;

    if (needsVision) {
      // Always use Gemini for vision
      if (!PROVIDER_POOLS.gemini?.keys.length) {
        return res.status(400).json({
          error: 'VISION_NOT_CONFIGURED',
          details: 'Image parsing requires Gemini API keys. Add GEMINI_API_KEYS to your environment variables.'
        });
      }

      try {
        rawResponse = await askVisionProvider('gemini', userKey, images);
        effectiveProvider = 'gemini';
      } catch (visionError) {
        console.error('[Vision] Vision processing failed:', visionError);

        // If there's no text to fall back on, there's nothing useful we can do —
        // surface the real vision error instead of masking it with a second failure.
        if (!text) {
          return res.status(502).json({
            error: 'VISION_FAILED',
            details: `Image parsing failed: ${visionError.message}`
          });
        }

        // Fallback to text-only parsing with a warning. Always use gemini here —
        // it's the only provider we've already confirmed has configured keys
        // (we wouldn't have reached this branch otherwise), whereas userProvider
        // (e.g. 'groq') may have zero keys configured and would throw again,
        // masking the original vision error behind an unrelated 500.
        try {
          const fallbackText = `${text}\n\n[Note: Image processing failed - ${visionError.message}]`;
          rawResponse = await askProvider('gemini', userKey, fallbackText);
          effectiveProvider = 'gemini';
        } catch (fallbackError) {
          console.error('[Vision] Text fallback also failed:', fallbackError);
          return res.status(502).json({
            error: 'VISION_FAILED',
            details: `Image parsing failed: ${visionError.message}`
          });
        }
      }
    } else {
      // Text parsing - use the requested provider (or default to gemini)
      const textProviders = ['gemini', 'groq', 'openai', 'azure', 'anthropic'];
      effectiveProvider = textProviders.includes(userProvider) ? userProvider : 'gemini';

      rawResponse = await askProvider(effectiveProvider, userKey, text);
    }

    // For key source, we infer from whether user provided key
    keySource = userKey ? 'user' : 'pool';

    // Extract text content from provider response object
    let responseText = rawResponse;
    if (rawResponse && typeof rawResponse === 'object') {
      // Handle OpenAI-compatible response format: { choices: [{ message: { content: "..." } }] }
      if (rawResponse.choices?.[0]?.message?.content) {
        responseText = rawResponse.choices[0].message.content;
      }
      // Handle Anthropic response format: { content: [{ text: "..." }] }
      else if (rawResponse.content?.[0]?.text) {
        responseText = rawResponse.content[0].text;
      }
      // Handle Gemini response format: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
      else if (rawResponse.candidates?.[0]?.content?.parts?.[0]?.text) {
        responseText = rawResponse.candidates[0].content.parts[0].text;
      }
      // Fallback: stringify if we can't find standard fields
      else {
        responseText = JSON.stringify(rawResponse);
      }
    }

    const parsed = cleanJson(responseText);

    if (!parsed) {
      return res.status(502).json({
        error: 'INVALID_RESPONSE',
        details: 'The model did not return valid schedule JSON.'
      });
    }

    const schedule = normalizeSchedule(parsed);

    if (!schedule.blocks.length) {
      schedule.confidence = Math.min(schedule.confidence, 0.3);
      schedule.reasons = schedule.reasons.length
        ? schedule.reasons
        : ['Add clearer times and an ending time to build a timeline.'];
    }

    res.set('x-key-source', keySource);
    return res.json(schedule);
  } catch (error) {
    console.error('[Server] Parsing error:', error);

    // Handle specific error types
    if (error instanceof ErrorWithCode) {
      let statusCode = 500;
      let errorDetails = error.message;

      switch (error.code) {
        case 'INVALID_API_KEY':
        case 'PERMISSION_DENIED':
          statusCode = 401;
          break;
        case 'QUOTA_EXCEEDED':
        case 'RESOURCES_EXHAUSTED':
          statusCode = 429;
          break;
        case 'TIMEOUT_ERROR':
        case 'NETWORK_ERROR':
          statusCode = 504;
          break;
        case 'UNSUPPORTED_IMAGE_FORMAT':
        case 'INVALID_IMAGE_CONTENT':
          statusCode = 400;
          break;
        case 'NO_API_KEYS':
          statusCode = 400;
          break;
        default:
          statusCode = 500;
      }

      return res.status(statusCode).json({
        error: error.code,
        details: errorDetails
      });
    }

    // Handle generic errors
    if (error.message.includes('fetch failed') || error.message.includes('Failed to fetch')) {
      return res.status(504).json({
        error: 'NETWORK_ERROR',
        details: 'Could not connect to the parsing service. Please check your internet connection.'
      });
    }

    return res.status(500).json({
      error: 'SCHEDULE_PARSING_FAILED',
      details: 'Failed to parse schedule.',
      providerError: error.message
    });
  }
});

// Health check — also used as keep-alive ping
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    model: 'multi-provider',
    providers: Object.keys(PROVIDER_POOLS).filter(p => PROVIDER_POOLS[p].keys.length > 0),
    keyConfigured: Object.values(PROVIDER_POOLS).some(p => p.keys.length > 0)
  });
});

// Keep-alive endpoint so Render free tier doesn't spin down
app.get('/ping', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Calendar integration endpoints
app.post('/calendar/connect', async (req, res) => {
  const { providers } = req.body;
  if (!providers || !Array.isArray(providers)) {
    return res.status(400).json({ error: 'Providers must be an array.' });
  }
  // In a real implementation you would start OAuth flows here.
  // For now we just acknowledge the request.
  res.json({ success: true, connectedProviders: providers });
});

app.get('/calendar/events', async (req, res) => {
  const { providers } = req.query;
  if (!providers) {
    return res.status(400).json({ error: 'Providers query param required.' });
  }
  // Mock event data for demonstration purposes
  const mockEvents = {
    google: [
      {
        summary: 'Team Sync',
        start: '2024-09-30T10:00:00-04:00',
        end: '2024-09-30T11:00:00-04:00',
        type: 'work'
      },
      {
        summary: 'Lunch Break',
        start: '2024-09-30T12:30:00-04:00',
        end: '2024-09-30T13:00:00-04:00',
        type: 'break'
      }
    ],
    apple: [
      {
        summary: 'Gym Session',
        start: '2024-09-30T18:00:00-04:00',
        end: '2024-09-30T19:00:00-04:00',
        type: 'exercise'
      }
    ],
    notion: [
      {
        summary: 'Project Planning',
        start: '2024-10-01T09:00:00-04:00',
        end: '2024-10-01T10:00:00-04:00',
        type: 'work'
      }
    ]
  };
  const events = {};
  for (const p of providers) {
    if (mockEvents[p]) events[p] = mockEvents[p];
  }
  res.json(events);
});

const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => {
  console.log(`LuxShift proxy running at http://localhost:${PORT}`);
  console.log('Configured providers:', Object.entries(PROVIDER_POOLS)
    .filter(([, p]) => p.keys.length > 0)
    .map(([name, p]) => `${name} (${p.keys.length} keys)`).join(', ') || 'none');
});