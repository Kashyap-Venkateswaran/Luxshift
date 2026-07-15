/**
 * LuxShift – Main Process
 *
 * Single-process Electron app with:
 *  - Wind-down engine (60s tick): computes intensity, broadcasts state, controls Night Shift via Swift binary
 *  - Sunlight notification engine: morning/afternoon nudges with weather awareness
 *  - System tray/menu bar for background operation
 *  - IPC handlers for preferences, schedules, permissions, location
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell,
  systemPreferences
} = require('electron');

const path = require('path');
const PreferencesStore = require('electron-store').default;
const {
  getActiveSchedule,
  saveActiveSchedule,
  clearActiveSchedule,
  archiveExpiredActiveSchedule,
  getUserApiKey,
  saveUserApiKey,
  deleteUserApiKey,
  dateKeyFromDate
} = require('./schedule-store.js');

const GITHUB_REPO = 'LuxshiftOfficial/Luxshift';

let preferencesStore;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let windDownTickInterval = null;

// ---- Swift NightShift binary ----
function getNightshiftBin() {
  const bundled = path.join(process.resourcesPath || __dirname, 'assets', 'nightshift-control');
  const dev = path.join(__dirname, 'assets', 'nightshift-control');
  const home = path.join(require('os').homedir(), 'nightshift-control');
  const fs = require('fs');
  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync(dev)) return dev;
  return home;
}
const NIGHTSHIFT_BIN = getNightshiftBin();
const MIN_BRIGHTNESS = 0.35;

// ---- Default preferences ----
const DEFAULT_PREFERENCES = {
  bedtimeTarget: '00:30',
  wakeTarget: '07:30',
  windDownMinutes: 90,
  preferredLocationName: '',
  preferredLocation: null,
  timeFormat: '12h',
  timeFormatChosen: false
};

// ---- Tray icon ----
function getTrayIcon() {
  const templatePath = path.join(__dirname, 'assets', 'tray-iconTemplate.png');
  const alternatePath = path.join(__dirname, 'assets', 'tray-icon.png');

  for (const iconPath of [templatePath, alternatePath]) {
    try {
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) return image.resize({ width: 18, height: 18 });
    } catch (_) {}
  }

  const svg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="14" height="14" rx="4" fill="white"/>
      <path d="M6 5.4h1.5v5.1h4.7V12H6V5.4Z" fill="black"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  );
}

// ---- Window & Tray management ----
function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: 'LuxShift',
    backgroundColor: '#08111f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();

    if (Notification.isSupported()) {
      try {
        new Notification({
          title: 'LuxShift is still running',
          body: 'LuxShift moved to the menu bar so wind‑down support can continue.'
        }).show();
      } catch (_) {}
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showMainWindow() {
  const win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function toggleMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    hideMainWindow();
    return;
  }
  showMainWindow();
}

function getAllWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}

function broadcast(channel, payload) {
  for (const win of getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

// ---- Preference handling ----
function getPreferences() {
  return {
    ...DEFAULT_PREFERENCES,
    ...(preferencesStore?.store || {})
  };
}

function normalizeHHMM(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return fallback;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeLocation(value) {
  if (!value || typeof value !== 'object') return null;
  const latitude = Number(value.latitude);
  const longitude = Number(value.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    id: typeof value.id === 'string' ? value.id : `${latitude},${longitude}`,
    name: String(value.name || '').trim(),
    latitude,
    longitude,
    timezone: typeof value.timezone === 'string' ? value.timezone : null,
    country: typeof value.country === 'string' ? value.country : null,
    admin1: typeof value.admin1 === 'string' ? value.admin1 : null
  };
}

function buildSafePreferences(payload = {}) {
  const current = getPreferences();
  const requestedLocation =
    payload?.preferredLocation === null
      ? null
      : normalizeLocation(payload?.preferredLocation) || current.preferredLocation;

  return {
    bedtimeTarget: normalizeHHMM(payload?.bedtimeTarget, current.bedtimeTarget),
    wakeTarget: normalizeHHMM(payload?.wakeTarget, current.wakeTarget),
    windDownMinutes: Math.min(
      180,
      Math.max(
        15,
        Number.isFinite(Number(payload?.windDownMinutes))
          ? Number(payload.windDownMinutes)
          : current.windDownMinutes
      )
    ),
    preferredLocationName:
      typeof payload?.preferredLocationName === 'string'
        ? payload.preferredLocationName.trim()
        : current.preferredLocationName,
    preferredLocation: requestedLocation,
    timeFormat: payload?.timeFormat === '24h' ? '24h' : '12h',
    timeFormatChosen: Boolean(payload?.timeFormatChosen ?? current.timeFormatChosen)
  };
}

// ---- Permission helpers ----
function hasAccessibilityPermission() {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch (_) {
    return false;
  }
}

function requestAccessibilityPermission() {
  if (process.platform !== 'darwin') return;
  try {
    systemPreferences.isTrustedAccessibilityClient(true);
  } catch (_) {}
}

async function openAccessibilitySettings() {
  const urls = [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.Privacy-Accessibility',
    'x-apple.systempreferences:com.apple.preference.security'
  ];
  for (const url of urls) {
    try { await shell.openExternal(url); return; } catch (_) {}
  }
}

let _permissionPollInterval = null;
function startPermissionPolling(win) {
  if (_permissionPollInterval) return;
  _permissionPollInterval = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(_permissionPollInterval);
      _permissionPollInterval = null;
      return;
    }
    const hasPermission = hasAccessibilityPermission();
    win.webContents.send('luxshift:permission-status', { accessibility: hasPermission });
    if (hasPermission) {
      clearInterval(_permissionPollInterval);
      _permissionPollInterval = null;
    }
  }, 2000);
}

// ---- Wind-down engine (moved from display-engine.js) ----
const WIND_DOWN_MINUTES_DEFAULT = 90;
const SUNLIGHT_WINDOWS = [
  { id: 'morning', startH: 6, endH: 10, label: 'morning sunlight', message: 'Step outside for 10–15 minutes of morning sunlight. This anchors your circadian clock and makes tonight\'s sleep more effective.' },
  { id: 'afternoon', startH: 14, endH: 16, label: 'afternoon sunlight', message: 'A short walk outside now helps extend your afternoon alertness and prepares your body for a natural wind-down tonight.' }
];

const _sunlightFiredToday = new Set();
let _lastNotificationDate = null;
let _weatherCache = null;
let _weatherCacheTime = 0;
const WEATHER_CACHE_MS = 30 * 60 * 1000;

// SunCalc for sunrise/sunset
const SunCalc = require('suncalc');

function parseHHMMtoMinutes(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function minutesToHHMM(totalMinutes) {
  const normalized = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function resolveBedtimeMinutes(prefs, schedule) {
  if (schedule?.parsedBlocks?.length) {
    const sleepBlocks = schedule.parsedBlocks.filter(
      (b) => b.type === 'sleep' || b.type === 'unwind'
    );
    const starts = sleepBlocks
      .map((b) => b.start)
      .filter(Boolean)
      .map(parseHHMMtoMinutes)
      .filter((m) => m !== null);

    if (starts.length) return Math.max(...starts);

    if (schedule.endTime) {
      const m = parseHHMMtoMinutes(schedule.endTime);
      if (m !== null) return m;
    }
  }

  if (prefs?.bedtimeTarget) {
    return parseHHMMtoMinutes(prefs.bedtimeTarget);
  }

  return null;
}

function computeWindDownState(prefs, schedule) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const windDownMinutes = Number(prefs?.windDownMinutes) || WIND_DOWN_MINUTES_DEFAULT;

  const bedtimeMinutes = resolveBedtimeMinutes(prefs, schedule);

  if (bedtimeMinutes === null) {
    return makeNormalState(windDownMinutes);
  }

  let minutesToBedtime = bedtimeMinutes - nowMinutes;

  // Handle midnight crossing
  if (minutesToBedtime < -(24 * 60 - windDownMinutes)) {
    minutesToBedtime += 24 * 60;
  }

  const bedtimeLabel = minutesToHHMM(bedtimeMinutes);

  // Past bedtime — keep Night Shift on for 30 min grace
  if (minutesToBedtime < 0 && minutesToBedtime >= -30) {
    return {
      intensity: 1.0,
      minutesToBedtime: 0,
      windDownMinutes,
      targetBrightness: MIN_BRIGHTNESS,
      phase: 'bedtime',
      bedtimeLabel
    };
  }

  // More than 30 mins past bedtime — reset
  if (minutesToBedtime < -30) {
    return makeNormalState(windDownMinutes, bedtimeLabel);
  }

  if (minutesToBedtime > windDownMinutes) {
    return {
      intensity: 0,
      minutesToBedtime,
      windDownMinutes,
      targetBrightness: 1.0,
      phase: minutesToBedtime <= windDownMinutes + 15 ? 'approaching' : 'normal',
      bedtimeLabel
    };
  }

  // Non-linear biological curve: easeInQuad
  const progress = 1 - (minutesToBedtime / windDownMinutes);
  const intensity = progress * progress;

  const targetBrightness = 1.0 - (intensity * (1.0 - MIN_BRIGHTNESS));

  return {
    intensity: parseFloat(intensity.toFixed(3)),
    minutesToBedtime,
    windDownMinutes,
    targetBrightness: parseFloat(targetBrightness.toFixed(3)),
    phase: 'winding-down',
    bedtimeLabel
  };
}

function makeNormalState(windDownMinutes, bedtimeLabel = null) {
  return {
    intensity: 0,
    minutesToBedtime: null,
    windDownMinutes,
    targetBrightness: 1.0,
    phase: 'normal',
    bedtimeLabel
  };
}

// ---- Display control (Swift binary) ----
async function applyNightShift(strength) {
  if (process.platform !== 'darwin') return;

  try {
    if (strength <= 0) {
      await execFileAsync(NIGHTSHIFT_BIN, ['off']);
    } else {
      await execFileAsync(NIGHTSHIFT_BIN, ['on', String(strength)]);
    }
  } catch (_) {
    // Binary not available — in-app overlay still works
  }
}

async function setBrightness(level) {
  const clamped = Math.max(MIN_BRIGHTNESS, Math.min(1.0, level));
  try {
    await execFileAsync('osascript', [
      '-e',
      `tell application "System Events" to tell process "SystemUIServer" to set value of slider 1 of menu bar item "Brightness" of menu bar 2 to ${clamped}`
    ]);
  } catch (_) {}
}

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// ---- Sunlight notifications ----
async function fetchWeather(coords) {
  const now = Date.now();
  if (_weatherCache && now - _weatherCacheTime < WEATHER_CACHE_MS) {
    return _weatherCache;
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=cloudcover,is_day,weathercode&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    _weatherCache = data?.current || null;
    _weatherCacheTime = now;
    return _weatherCache;
  } catch (_) {
    return null;
  }
}

function getSunriseSunset(coords) {
  if (!coords?.latitude || !coords?.longitude) return null;
  const times = SunCalc.getTimes(new Date(), coords.latitude, coords.longitude);
  return {
    sunriseMinutes: times.sunrise.getHours() * 60 + times.sunrise.getMinutes(),
    sunsetMinutes: times.sunset.getHours() * 60 + times.sunset.getMinutes(),
    goldenHourEndMinutes: times.goldenHourEnd.getHours() * 60 + times.goldenHourEnd.getMinutes()
  };
}

function getWeatherAdvice(weather) {
  if (!weather) return { canGoOut: true, qualifier: '', weatherNote: '' };

  const cloudcover = Number(weather.cloudcover ?? 0);
  const isDay = Number(weather.is_day ?? 1);
  const code = Number(weather.weathercode ?? 0);

  const isRaining = (code >= 61 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const isSnowing = code >= 71 && code <= 77;

  if (!isDay) return { canGoOut: false, qualifier: 'after dark', weatherNote: 'Sun has set — wait for tomorrow morning.' };
  if (isRaining) return { canGoOut: false, qualifier: 'rainy', weatherNote: 'It is raining right now. Try to get light near a bright window instead.' };
  if (isSnowing) return { canGoOut: false, qualifier: 'snowy', weatherNote: 'Snowing outside — a bright window will help, or step out briefly if safe.' };
  if (cloudcover > 85) return { canGoOut: true, qualifier: 'overcast', weatherNote: 'Heavy cloud cover today — still go outside, overcast light still has circadian benefit, just stay out a bit longer (20 mins).' };
  if (cloudcover > 60) return { canGoOut: true, qualifier: 'partly cloudy', weatherNote: 'Partly cloudy — outdoor light still works well. Aim for 15 minutes.' };

  return { canGoOut: true, qualifier: 'clear', weatherNote: 'Good conditions — 10 minutes outside is enough.' };
}

function isInWorkBlock(schedule, nowMinutes) {
  if (!schedule?.parsedBlocks?.length) return false;
  for (const block of schedule.parsedBlocks) {
    if (block.type !== 'work') continue;
    const start = parseHHMMtoMinutes(block.start);
    const end = parseHHMMtoMinutes(block.end);
    if (start !== null && end !== null && nowMinutes >= start && nowMinutes <= end) {
      return true;
    }
  }
  return false;
}

function sendSunlightNotification(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('luxshift:sunlight-nudge', payload);
  } catch (_) {}
}

async function checkSunlightNotifications(prefs, schedule) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Reset fired set at start of each new day
  if (_lastNotificationDate !== todayKey) {
    _sunlightFiredToday.clear();
    _lastNotificationDate = todayKey;
  }

  const coords = prefs?.preferredLocation || null;
  const wakeTarget = prefs?.wakeTarget || '07:30';
  const wakeMinutes = parseHHMMtoMinutes(wakeTarget) || 7 * 60 + 30;

  // Get sunrise for this location
  const sunTimes = coords ? getSunriseSunset(coords) : null;
  const sunriseMinutes = sunTimes?.sunriseMinutes ?? 6 * 60;
  const goldenHourEnd = sunTimes?.goldenHourEndMinutes ?? 8 * 60;

  // Morning window: starts at LATER of (wake time) or (sunrise), ends 2h later
  const morningStart = Math.max(wakeMinutes, sunriseMinutes);
  const morningEnd = morningStart + 120;

  // Afternoon window: 5–7 hours after wake
  const afternoonStart = wakeMinutes + 5 * 60;
  const afternoonEnd = wakeMinutes + 7 * 60;

  // Fetch weather once for both checks
  const weather = coords ? await fetchWeather(coords) : null;
  const { canGoOut, qualifier, weatherNote } = getWeatherAdvice(weather);

  // Morning nudge
  const morningId = `${todayKey}-morning`;
  if (
    !_sunlightFiredToday.has(morningId) &&
    nowMinutes >= morningStart &&
    nowMinutes <= morningEnd &&
    !isInWorkBlock(schedule, nowMinutes)
  ) {
    const isGoldenHour = nowMinutes <= goldenHourEnd;
    const goldenNote = isGoldenHour ? ' The golden hour light right now is especially powerful for circadian anchoring.' : '';

    const body = canGoOut
      ? `Step outside for 10–15 minutes now. Morning sunlight triggers your cortisol peak and locks in tonight's melatonin timing. ${weatherNote}${goldenNote}`
      : `${weatherNote} Try to sit near your brightest window for 15 minutes — even indirect morning light helps anchor your clock.`;

    sendSunlightNotification({
      id: morningId,
      title: `☀️ Morning sunlight${qualifier ? ' (' + qualifier + ')' : ''}`,
      body,
      canGoOut
    });

    // Also show system notification
    if (Notification.isSupported()) {
      try {
        new Notification({ title: `☀️ Morning sunlight${qualifier ? ' (' + qualifier + ')' : ''}`, body }).show();
      } catch (_) {}
    }

    _sunlightFiredToday.add(morningId);
  }

  // Afternoon nudge
  const afternoonId = `${todayKey}-afternoon`;
  if (
    !_sunlightFiredToday.has(afternoonId) &&
    nowMinutes >= afternoonStart &&
    nowMinutes <= afternoonEnd &&
    !isInWorkBlock(schedule, nowMinutes)
  ) {
    const body = canGoOut
      ? `A 10-minute walk outside now extends your afternoon alertness and helps your melatonin rise at the right time tonight. ${weatherNote}`
      : `${weatherNote} Step near a bright window for a few minutes — your eyes need the light signal even if you cannot go outside.`;

    sendSunlightNotification({
      id: afternoonId,
      title: `🌤️ Afternoon light nudge${qualifier ? ' (' + qualifier + ')' : ''}`,
      body,
      canGoOut
    });

    if (Notification.isSupported()) {
      try {
        new Notification({ title: `🌤️ Afternoon light nudge${qualifier ? ' (' + qualifier + ')' : ''}`, body }).show();
      } catch (_) {}
    }

    _sunlightFiredToday.add(afternoonId);
  }
}

// ---- Wind-down tick loop ----
function pushStateToRenderer(state) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('luxshift:winddown-state', state);
  } catch (_) {}
}

async function applyDisplayAdaptation(intensity) {
  if (process.platform !== 'darwin') return;

  if (intensity <= 0) {
    await applyNightShift(0);
    await setBrightness(1.0);
    return;
  }

  // Map intensity (0–1) to Night Shift strength (0.05–0.72)
  const strength = parseFloat((0.05 + intensity * 0.67).toFixed(3));
  await applyNightShift(strength);

  // Brightness dims more gently — only starts dropping past 50% intensity
  const brightnessIntensity = Math.max(0, (intensity - 0.5) * 2);
  const targetBrightness = 1.0 - (brightnessIntensity * (1.0 - MIN_BRIGHTNESS));
  await setBrightness(targetBrightness);
}

function runWindDownTick() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const prefs = getPreferences();
  const scheduleResult = getActiveSchedule();
  const schedule = scheduleResult?.schedule || null;

  // Wind-down
  const state = computeWindDownState(prefs, schedule);
  pushStateToRenderer(state);
  applyDisplayAdaptation(state.intensity);

  // Sunlight notifications (async — fetches weather)
  checkSunlightNotifications(prefs, schedule);
}

function startWindDownTick() {
  runWindDownTick(); // immediate first run
  windDownTickInterval = setInterval(runWindDownTick, 60 * 1000);
}

function stopWindDownTick() {
  if (windDownTickInterval) {
    clearInterval(windDownTickInterval);
    windDownTickInterval = null;
  }
  // Turn off Night Shift on quit
  applyNightShift(0);
}

// Synchronous snapshot for tray / immediate UI refresh
function getCurrentWindDownState() {
  const prefs = getPreferences();
  const scheduleResult = getActiveSchedule();
  const schedule = scheduleResult?.schedule || null;
  return computeWindDownState(prefs, schedule);
}

// ---- App lifecycle ----
app.whenReady().then(async () => {
  app.setName('LuxShift');

  preferencesStore = new PreferencesStore({
    name: 'luxshift-preferences',
    cwd: app.getPath('userData'),
    defaults: DEFAULT_PREFERENCES
  });

  // Archive any expired schedule first
  archiveExpiredActiveSchedule();

  // Create window (needed before starting tick)
  const win = createWindow();

  // Start wind-down tick (includes sunlight notifications)
  startWindDownTick();

  // Create tray UI
  createTray();

  // Background update check
  checkForUpdates(false).catch(() => {});

  // Re-open window when dock icon clicked (macOS)
  app.on('activate', showMainWindow);
});

app.on('before-quit', () => {
  isQuitting = true;
  stopWindDownTick();
});

app.on('window-all-closed', (event) => {
  event.preventDefault(); // keep app alive in tray
});

// ---- IPC handlers ----
// Preferences
ipcMain.handle('luxshift:get-preferences', async () => getPreferences());

ipcMain.handle('luxshift:save-preferences', async (_event, payload) => {
  const next = buildSafePreferences(payload);
  preferencesStore.set(next);
  // Force fresh wind-down broadcast so UI updates immediately
  return {
    ok: true,
    preferences: getPreferences(),
    windDownState: getCurrentWindDownState()
  };
});

// Schedule store
ipcMain.handle('luxshift:get-active-schedule', async () => getActiveSchedule());

ipcMain.handle('luxshift:save-active-schedule', async (_event, payload) => {
  const result = saveActiveSchedule(payload);
  return result;
});

ipcMain.handle('luxshift:clear-active-schedule', async () => {
  const result = clearActiveSchedule();
  return result;
});

ipcMain.handle('luxshift:archive-expired-schedule', async () => {
  const result = archiveExpiredActiveSchedule();
  return result;
});

// Wind-down state
ipcMain.handle('luxshift:get-winddown-state', async () => getCurrentWindDownState());

// Location / environment & notifications
ipcMain.handle('luxshift:search-location', async (_event, query) => {
  const search = String(query || '').trim();
  if (search.length < 2) {
    return { ok: false, error: 'Please enter at least 2 characters.' };
  }
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(search)}&count=6&language=en&format=json`;
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `Location search failed (${response.status}).` };
    }
    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? data.results.map((item) => ({
          id: `${item.latitude},${item.longitude}`,
          name: item.name || '',
          admin1: item.admin1 || '',
          country: item.country || '',
          latitude: item.latitude,
          longitude: item.longitude,
          timezone: item.timezone || null
        }))
      : [];
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: error?.message || 'Location search failed.' };
  }
});

ipcMain.handle('luxshift:get-environment', async (_event, coords) => {
  const latitude = Number(coords?.latitude);
  const longitude = Number(coords?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { ok: false, error: 'Valid latitude and longitude are required.' };
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,apparent_temperature,cloud_cover,precipitation,weather_code,is_day&timezone=auto&forecast_days=1`;
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, error: `Environment lookup failed (${response.status}).` };
    }
    const data = await response.json();
    const current = data?.current || {};
    return {
      ok: true,
      weather: {
        temperature2m: current.temperature_2m,
        apparentTemperature: current.apparent_temperature,
        cloudcover: current.cloud_cover,
        precipitation: current.precipitation,
        weatherCode: current.weather_code,
        isday: current.is_day
      },
      environment: {
        latitude,
        longitude,
        timezone: data?.timezone || null,
        current
      }
    };
  } catch (error) {
    return { ok: false, error: error?.message || 'Environment lookup failed.' };
  }
});

ipcMain.handle('luxshift:notify', async (_event, payload) => {
  if (!Notification.isSupported()) {
    return { ok: false, error: 'Notifications are not supported on this device.' };
  }
  try {
    new Notification({
      title: String(payload?.title || 'LuxShift').trim() || 'LuxShift',
      body: String(payload?.body || '').trim()
    }).show();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Notification failed.' };
  }
});

// Update checks
ipcMain.handle('luxshift:request-notifications', async () => {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'LuxShift',
        body: 'Notifications enabled — you will receive sunlight nudges and bedtime reminders.',
        silent: true
      });
      n.show();
      setTimeout(() => { try { n.close(); } catch (_) {} }, 3000);
      return { ok: true };
    }
    return { ok: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('luxshift:check-for-updates', async () => {
  await checkForUpdates(true);
  return { ok: true };
});

// Permission IPC
ipcMain.handle('luxshift:check-permissions', async () => ({
  accessibility: hasAccessibilityPermission()
}));

ipcMain.handle('luxshift:request-accessibility', async () => {
  requestAccessibilityPermission();
  if (mainWindow && !mainWindow.isDestroyed()) {
    startPermissionPolling(mainWindow);
    await openAccessibilitySettings();
  }
  return { ok: true };
});

ipcMain.handle('luxshift:open-accessibility-settings', async () => {
  await openAccessibilitySettings();
  if (mainWindow && !mainWindow.isDestroyed()) startPermissionPolling(mainWindow);
  return { ok: true };
});

// API Key IPC
ipcMain.handle('luxshift:get-user-api-key', async () => getUserApiKey());

ipcMain.handle('luxshift:save-user-api-key', async (_event, { key, provider }) => {
  const result = saveUserApiKey(key, provider);
  return result;
});

ipcMain.handle('luxshift:delete-user-api-key', async () => {
  const result = deleteUserApiKey();
  return result;
});

// ---- Update check helper ----
async function checkForUpdates(showFeedback = false) {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status}).`);
    const release = await response.json();
    const latestVersion = release?.tag_name || release?.name;
    const currentVersion = app.getVersion();

    if (!latestVersion) {
      if (showFeedback) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'LuxShift Updates',
          message: 'Could not determine the latest version right now.'
        });
      }
      return;
    }
    if (compareVersions(latestVersion, currentVersion) <= 0) {
      if (showFeedback) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'LuxShift Updates',
          message: `You're up to date (v${currentVersion}).`
        });
      }
      return;
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Update available',
      message: `A new version of LuxShift is available (${latestVersion}).`,
      detail: 'Download the newest release to update LuxShift.',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) {
      await shell.openExternal(release?.html_url ?? `https://github.com/${GITHUB_REPO}/releases/latest`);
    }
  } catch (error) {
    if (showFeedback) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'LuxShift Updates',
        message: 'Could not check for updates.',
        detail: error?.message || 'Please check your internet connection and try again.'
      });
    }
  }
}

// ---- Version comparison helper ----
function parseVersionParts(version) {
  return String(version || '0.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const aParts = parseVersionParts(a);
  const bParts = parseVersionParts(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// ---- Tray creation ----
function createTray() {
  if (tray) return tray;
  tray = new Tray(getTrayIcon());
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', toggleMainWindow);
  tray.on('right-click', () => {
    updateTrayMenu();
    tray.popUpContextMenu();
  });
  updateTrayMenu();
  return tray;
}

function updateTrayMenu(state = null) {
  if (!tray) return;
  const current = state || getCurrentWindDownState();
  const status =
    current.minutesToBedtime === null
      ? 'No bedtime set'
      : current.minutesToBedtime <= 0
        ? 'Bedtime reached'
        : `${Math.round(current.minutesToBedtime)}m to bedtime`;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open LuxShift', click: showMainWindow },
      {
        label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
          ? 'Hide Window'
          : 'Show Window',
        click: toggleMainWindow
      },
      { type: 'separator' },
      { label: `Mode: ${current.phase}`, enabled: false },
      { label: `Status: ${status}`, enabled: false },
      { label: `Bedtime: ${current.bedtimeLabel || 'Not set'}`, enabled: false },
      { type: 'separator' },
      { label: 'Check for Updates…', click: () => checkForUpdates(true) },
      { type: 'separator' },
      {
        label: 'Quit LuxShift',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );

  const title =
    current.phase === 'winding-down'
      ? 'LuxShift • Wind‑down'
      : current.phase === 'bedtime'
        ? 'LuxShift • Bedtime'
        : 'LuxShift';
  tray.setToolTip(title);
}