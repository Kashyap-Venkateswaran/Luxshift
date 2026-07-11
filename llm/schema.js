function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asNullableTime(value) {
  if (value == null || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{2}:\d{2}$/.test(trimmed) ? trimmed : null;
}

function asBlockType(value) {
  const allowed = new Set(['work', 'unwind', 'leisure', 'sleep', 'wake', 'break', 'general']);
  return allowed.has(value) ? value : 'general';
}

function sanitizeBlock(block, index) {
  return {
    id: asString(block?.id, `block_${index + 1}`),
    type: asBlockType(block?.type),
    title: asString(block?.title, 'Schedule Block'),
    note: asString(block?.note, 'Parsed from your day description.'),
    timeLabel: asString(block?.timeLabel, 'Unspecified'),
    start: asNullableTime(block?.start),
    end: asNullableTime(block?.end),
    certainty: clamp(Number(block?.certainty ?? 0.7), 0, 1),
    derivedFrom: 'openrouter'
  };
}

function sanitizeSchedulePayload(payload) {
  const blocks = Array.isArray(payload?.blocks)
    ? payload.blocks.map((block, index) => sanitizeBlock(block, index))
    : [];

  return {
    summary: asString(payload?.summary, ''),
    confidence: clamp(Number(payload?.confidence ?? (blocks.length ? 0.72 : 0.18)), 0, 1),
    reasons: Array.isArray(payload?.reasons)
      ? payload.reasons.filter((item) => typeof item === 'string').slice(0, 8)
      : [],
    blocks
  };
}

function buildEmptyParseResult(reason = 'No schedule blocks could be extracted.') {
  return {
    confidence: 0.12,
    reasons: [reason],
    blocks: [],
    summary: ''
  };
}

module.exports = {
  sanitizeSchedulePayload,
  buildEmptyParseResult
};