const express = require('express');
const cors = require('cors');

const app = express();

const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
    formatResponse: (data) => data,
    authHeader: (key) => `Bearer ${key}`,
    supportsVision: false
  },
  groqVision: {
    keys: parseKeyPool(process.env.GROQ_API_KEYS),
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    model: process.env.GROQ_VISION_MODEL || 'llama-3.2-11b-vision-preview',
    formatRequest: (body) => body,
    formatResponse: (data) => data,
    authHeader: (key) => `Bearer ${key}`,
    supportsVision: true
  },
  gemini: {
    keys: parseKeyPool(process.env.GEMINI_API_KEYS),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    formatRequest: (body) => ({
      contents: body.messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(m.content) ? m.content : [{ text: m.content }]
      })),
      generationConfig: {
        temperature: body.temperature ?? 0,
        maxOutputTokens: body.max_tokens || 650
      }
    }),
    formatResponse: (data) => ({
      choices: [{
        message: {
          role: 'assistant',
          content: data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        }
      }]
    }),
    authHeader: (key) => `${key}`, // passed as query param
    supportsVision: true
  },
  openai: {
    keys: parseKeyPool(process.env.OPENAI_API_KEYS),
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    formatRequest: (body) => body,
    formatResponse: (data) => data,
    authHeader: (key) => `Bearer ${key}`,
    supportsVision: true
  },
  azure: {
    keys: parseAzurePool(process.env.AZURE_OPENAI_KEYS),
    baseUrl: null, // per-key endpoint
    model: null,   // per-key deployment
    formatRequest: (body) => body,
    formatResponse: (data) => data,
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
    formatResponse: (data) => ({
      choices: [{
        message: {
          role: 'assistant',
          content: data.content?.[0]?.text || ''
        }
      }]
    }),
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

// ============================================================
// Vision & Text Provider Helpers
// ============================================================

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

async function askVisionProvider(provider, userKey, images) {
  // Build the prompt for vision parsing
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

  // Format images for the provider
  const imageParts = images.map(img => {
    if (provider === 'gemini') {
      return { inline_data: { mime_type: img.mimeType, data: img.base64 } };
    }
    // OpenAI/Groq/Azure format
    return { type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } };
  });

  const userContent = [
    { type: 'text', text: 'Extract schedule information from these image(s).' },
    ...imageParts
  ];

  const body = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ],
    temperature: 0.1,
    max_tokens: 1500
  };

  const result = await callProvider(provider, userKey, body);
  return result.data;
}

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

app.post('/parse-schedule', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    const images = Array.isArray(req.body?.images) ? req.body.images : [];

    if (!text && images.length === 0) return res.status(400).json({ error: 'Missing text or images.' });
    if (text.length > 8000) {
      return res.status(400).json({ error: 'Schedule text is too long. Keep it under 8,000 characters.' });
    }

    // Read provider and key from headers
    const userProvider = req.headers['x-user-provider'] || 'groq';
    const userKey = req.headers['x-user-api-key'] || null;

    let rawResponse;
    let keySource = 'pool';

    // Smart model selection: auto-detect if vision is needed
    const needsVision = images.length > 0;
    let effectiveProvider = userProvider;

    if (needsVision) {
      // Vision parsing - select a vision-capable provider
      const visionProviders = ['gemini', 'groqVision', 'openai', 'azure', 'anthropic'];
      effectiveProvider = visionProviders.includes(userProvider) ? userProvider : 'gemini';

      if (!PROVIDER_POOLS[effectiveProvider]?.supportsVision) {
        return res.status(400).json({ error: `Provider ${effectiveProvider} does not support vision.` });
      }

      rawResponse = await askVisionProvider(effectiveProvider, userKey, images);
    } else {
      // Text parsing - use the requested provider (or default to groq)
      const textProviders = ['groq', 'gemini', 'openai', 'azure', 'anthropic'];
      effectiveProvider = textProviders.includes(userProvider) ? userProvider : 'groq';

      rawResponse = await askProvider(effectiveProvider, userKey, text);
    }

    // For key source, we infer from whether user provided key
    keySource = userKey ? 'user' : 'pool';

    const parsed = cleanJson(rawResponse);

    if (!parsed) {
      return res.status(502).json({ error: 'The model did not return valid schedule JSON.' });
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
    return res.status(500).json({
      error: 'Schedule parsing failed.',
      details: error?.message || 'Unknown server error.'
    });
  }
});

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

app.listen(PORT, () => {
  console.log(`LuxShift proxy running at http://localhost:${PORT}`);
  console.log('Configured providers:', Object.entries(PROVIDER_POOLS)
    .filter(([, p]) => p.keys.length > 0)
    .map(([name, p]) => `${name} (${p.keys.length} keys)`).join(', ') || 'none');
});