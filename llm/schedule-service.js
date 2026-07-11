const { sanitizeSchedulePayload, buildEmptyParseResult } = require('./schema.js');

function redactPrompt(text) {
  return String(text)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b(?:\+?\d[\d\s\-()]{7,}\d)\b/g, '[redacted-phone]');
}

function buildSystemPrompt() {
  return `You are LuxShift, an AI parser for night schedule planning. Convert a user's natural-language day or night description into structured schedule blocks. If the input is only a preference, opinion, identity statement, or generic interest, return empty blocks. If the input contains a planned activity, intended action, time reference, or clear day-plan context, return blocks. Respond ONLY with a valid JSON object — no markdown, no code fences, no explanation. Use this exact structure:
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
}

async function parseScheduleWithLLM({ text }) {
  const cleanedText = redactPrompt(text).trim();

  if (!cleanedText) {
    return {
      source: 'ai',
      unavailable: false,
      ...buildEmptyParseResult('Please enter your plan before parsing.')
    };
  }

  try {
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.1',
        messages: [
          { role: 'system', content: buildSystemPrompt() },
          { role: 'user', content: cleanedText }
        ],
        stream: false,
        options: {
          temperature: 0.1
        }
      })
    });

    if (!response.ok) {
      return {
        source: 'ai',
        unavailable: true,
        confidence: 0.1,
        reasons: [`Ollama request failed (${response.status}). Is Ollama running?`],
        blocks: [],
        summary: ''
      };
    }

    const data = await response.json();
    const content = data?.message?.content || '';

    // Strip any markdown fences the model might add despite instructions
    const cleaned = content
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    if (!parsed) {
      return {
        source: 'ai',
        unavailable: true,
        confidence: 0.12,
        reasons: ['The model returned no structured content.'],
        blocks: [],
        summary: ''
      };
    }

    return {
      source: 'ai',
      unavailable: false,
      ...sanitizeSchedulePayload(parsed)
    };
  } catch (error) {
    return {
      source: 'ai',
      unavailable: true,
      confidence: 0.1,
      reasons: [error?.message || 'LLM parsing failed. Is Ollama running?'],
      blocks: [],
      summary: ''
    };
  }
}

module.exports = { parseScheduleWithLLM };