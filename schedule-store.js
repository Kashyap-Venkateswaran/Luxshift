const ScheduleStore = require('electron-store').default;

const scheduleStore = new ScheduleStore({
  name: 'luxshift-schedules',
  defaults: {
    activeSchedule: null,
    archivedSchedules: [],
    userApiKey: null,
    userApiProvider: null
  }
});

function toIsoString(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dateKeyFromDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeHHMM(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function combineDateAndTime(dateKey, hhmm) {
  const normalized = normalizeHHMM(hhmm);
  if (!dateKey || !normalized) return null;

  const date = new Date(`${dateKey}T${normalized}:00`);
  if (Number.isNaN(date.getTime())) return null;

  const now = new Date();
  if (date.getTime() < now.getTime()) {
    date.setDate(date.getDate() + 1);
  }

  return date;
}

function getScheduleBounds({ parsedBlocks = [], fallbackStart = null, fallbackEnd = null, dateKey }) {
  const starts = [];
  const ends = [];

  for (const block of parsedBlocks) {
    const start = normalizeHHMM(block?.start);
    const end = normalizeHHMM(block?.end);

    if (start) starts.push(start);
    if (end) ends.push(end);
  }

  starts.sort();
  ends.sort();

  const startTime = starts[0] || normalizeHHMM(fallbackStart) || null;
  const endTime = ends[ends.length - 1] || normalizeHHMM(fallbackEnd) || null;

  return {
    startTime,
    endTime,
    startAt: toIsoString(combineDateAndTime(dateKey, startTime)),
    endAt: toIsoString(combineDateAndTime(dateKey, endTime))
  };
}

function isScheduleStillActive(schedule, now = new Date()) {
  if (!schedule) return false;
  if (!schedule.endAt) return true;

  const end = new Date(schedule.endAt);
  if (Number.isNaN(end.getTime())) return true;

  return now.getTime() <= end.getTime();
}

function getActiveSchedule() {
  const schedule = scheduleStore.get('activeSchedule');
  if (!schedule) return { ok: true, schedule: null, restored: false };

  if (!isScheduleStillActive(schedule)) {
    archiveExpiredActiveSchedule();
    return { ok: true, schedule: null, restored: false };
  }

  return { ok: true, schedule, restored: true };
}

function saveActiveSchedule(payload) {
  const now = new Date();
  const dateKey = payload?.dateKey || dateKeyFromDate(now);
  const parsedBlocks = Array.isArray(payload?.parsedBlocks) ? payload.parsedBlocks : [];

  const bounds = getScheduleBounds({
    parsedBlocks,
    fallbackStart: payload?.startTime || null,
    fallbackEnd: payload?.endTime || null,
    dateKey
  });

  const current = scheduleStore.get('activeSchedule');

  const nextSchedule = {
    id: payload?.id || current?.id || `schedule-${Date.now()}`,
    dateKey,
    status: 'active',
    rawPlanText: String(payload?.rawPlanText || ''),
    lateChangesText: String(payload?.lateChangesText || ''),
    summary: String(payload?.summary || ''),
    parsedBlocks,
    confidence: Number(payload?.confidence ?? 0),
    reasons: Array.isArray(payload?.reasons) ? payload.reasons.slice(0, 8) : [],
    source: payload?.source || 'ai',
    unavailable: Boolean(payload?.unavailable),
    startTime: bounds.startTime,
    endTime: bounds.endTime,
    startAt: bounds.startAt,
    endAt: bounds.endAt,
    createdAt: current?.createdAt || now.toISOString(),
    updatedAt: now.toISOString()
  };

  scheduleStore.set('activeSchedule', nextSchedule);

  return {
    ok: true,
    schedule: nextSchedule
  };
}

function clearActiveSchedule() {
  scheduleStore.set('activeSchedule', null);
  return { ok: true };
}

function archiveExpiredActiveSchedule() {
  const current = scheduleStore.get('activeSchedule');
  if (!current) return { ok: true, archived: false };

  const archivedSchedules = scheduleStore.get('archivedSchedules') || [];
  const archivedItem = {
    ...current,
    status: 'archived',
    archivedAt: new Date().toISOString()
  };

  scheduleStore.set('archivedSchedules', [archivedItem, ...archivedSchedules].slice(0, 50));
  scheduleStore.set('activeSchedule', null);

  return { ok: true, archived: true };
}

function getUserApiKey() {
  const key = scheduleStore.get('userApiKey');
  const provider = scheduleStore.get('userApiProvider');
  if (!key || !provider) return { ok: true, key: null, provider: null };
  return { ok: true, key, provider };
}

function saveUserApiKey(key, provider) {
  if (!key || !provider) {
    scheduleStore.set('userApiKey', null);
    scheduleStore.set('userApiProvider', null);
    return { ok: true, cleared: true };
  }
  scheduleStore.set('userApiKey', key);
  scheduleStore.set('userApiProvider', provider);
  return { ok: true, key, provider };
}

function deleteUserApiKey() {
  scheduleStore.set('userApiKey', null);
  scheduleStore.set('userApiProvider', null);
  return { ok: true };
}

function clearAllUserData() {
  scheduleStore.set('userApiKey', null);
  scheduleStore.set('userApiProvider', null);
  scheduleStore.set('activeSchedule', null);
  scheduleStore.set('archivedSchedules', []);
  return { ok: true };
}

module.exports = {
  getActiveSchedule,
  saveActiveSchedule,
  clearActiveSchedule,
  archiveExpiredActiveSchedule,
  dateKeyFromDate,
  getUserApiKey,
  saveUserApiKey,
  deleteUserApiKey,
  clearAllUserData
};