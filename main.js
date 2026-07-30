/**
 * LuxShift – Main Process
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
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const PreferencesStore = require('electron-store').default;
const SunCalc = require('suncalc');

const execFileAsync = promisify(execFile);

// Safety net: a synchronous child_process call during app quit (or any other
// late-stage teardown) can occasionally throw in a way that bypasses local
// try/catch (e.g. an EIO write error surfacing as a process-level exception).
// Log it instead of letting it hard-crash the app.
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error);
});

const {
  getActiveSchedule,
  saveActiveSchedule,
  clearActiveSchedule,
  archiveExpiredActiveSchedule,
  getUserApiKey,
  saveUserApiKey,
  deleteUserApiKey,
  clearAllUserData
} = require('./schedule-store.js');

const { GoogleCalendarClient } = require('./calendar/google.js');
const { AppleCalendarClient } = require('./calendar/apple.js');
const { NotionCalendarClient } = require('./calendar/notion.js');
const { parseICS } = require('./calendar/ics.js');
const { KeepAlivePinger } = require('./keep-alive.js');
const { SmartBulbManager } = require('./smart-bulb.js');

const GITHUB_REPO = 'LuxshiftOfficial/Luxshift';
const MIN_BRIGHTNESS = 0.35;
const WIND_DOWN_MINUTES_DEFAULT = 90;
const WEATHER_CACHE_MS = 30 * 60 * 1000;

let preferencesStore;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let windDownTickInterval = null;
let keepAlivePinger = null;
let smartBulbManager = null;
let permissionPollInterval = null;

const sunlightFiredToday = new Set();
let lastNotificationDate = null;
let weatherCache = null;
let weatherCacheTime = 0;

function getNightshiftBin() {
  const bundled = path.join(process.resourcesPath || __dirname, 'assets', 'nightshift-control');
  const dev = path.join(__dirname, 'assets', 'nightshift-control');
  const home = path.join(os.homedir(), 'nightshift-control');

  if (fs.existsSync(bundled)) return bundled;
  if (fs.existsSync(dev)) return dev;
  return home;
}

const NIGHTSHIFT_BIN = getNightshiftBin();

const DEFAULT_PREFERENCES = {
  bedtimeTarget: '00:30',
  wakeTarget: '07:30',
  windDownMinutes: 90,
  preferredLocationName: '',
  preferredLocation: null,
  timeFormat: '12h',
  timeFormatChosen: false,
  googleCalendarTokens: null,
  notionConfig: null,
  smartBulbEnabled: false,
  smartBulbProtocol: null
};

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
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
      <rect x="2" y="2" width="14" height="14" rx="4" fill="black"/>
      <circle cx="9" cy="9" r="3.4" fill="white"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

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
          body: 'LuxShift moved to the menu bar so wind-down support can continue.'
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
  } else {
    showMainWindow();
  }
}

function getAllWindows() {
  return BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
}

function broadcast(channel, payload) {
  for (const win of getAllWindows()) {
    try {
      win.webContents.send(channel, payload);
    } catch (_) {}
  }
}

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
    ...current,
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
    try {
      await shell.openExternal(url);
      return;
    } catch (_) {}
  }
}

function startPermissionPolling(win) {
  if (permissionPollInterval) return;

  permissionPollInterval = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(permissionPollInterval);
      permissionPollInterval = null;
      return;
    }

    const hasPermission = hasAccessibilityPermission();
    win.webContents.send('luxshift:permission-status', { accessibility: hasPermission });

    if (hasPermission) {
      clearInterval(permissionPollInterval);
      permissionPollInterval = null;
    }
  }, 2000);
}

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
  }

  if (schedule?.endTime) {
    const m = parseHHMMtoMinutes(schedule.endTime);
    if (m !== null) return m;
  }

  if (prefs?.bedtimeTarget) {
    return parseHHMMtoMinutes(prefs.bedtimeTarget);
  }

  return null;
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

function computeWindDownState(prefs, schedule) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const windDownMinutes = Number(prefs?.windDownMinutes) || WIND_DOWN_MINUTES_DEFAULT;
  const bedtimeMinutes = resolveBedtimeMinutes(prefs, schedule);

  if (bedtimeMinutes === null) return makeNormalState(windDownMinutes);

  let minutesToBedtime = bedtimeMinutes - nowMinutes;

  if (minutesToBedtime < -(24 * 60 - windDownMinutes)) {
    minutesToBedtime += 24 * 60;
  }

  const bedtimeLabel = minutesToHHMM(bedtimeMinutes);

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

async function applyNightShift(strength) {
  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(NIGHTSHIFT_BIN)) return;

  try {
    if (strength <= 0) {
      await execFileAsync(NIGHTSHIFT_BIN, ['off']);
    } else {
      await execFileAsync(NIGHTSHIFT_BIN, ['on', String(strength)]);
    }
  } catch (_) {}
}

async function setBrightness(level) {
  if (process.platform !== 'darwin') return;

  const clamped = Math.max(MIN_BRIGHTNESS, Math.min(1.0, level));
  try {
    await execFileAsync('osascript', [
      '-e',
      `tell application "System Events" to tell process "SystemUIServer" to set value of slider 1 of group 1 of window 1 of application process "ControlCenter" to ${clamped}`
    ]);
  } catch (_) {}
}

async function fetchWeather(coords) {
  const now = Date.now();
  if (weatherCache && now - weatherCacheTime < WEATHER_CACHE_MS) {
    return weatherCache;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=cloud_cover,is_day,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;

    const data = await res.json();
    weatherCache = data?.current || null;
    weatherCacheTime = now;
    return weatherCache;
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

  const cloudCover = Number(weather.cloud_cover ?? weather.cloudcover ?? 0);
  const isDay = Number(weather.is_day ?? 1);
  const code = Number(weather.weather_code ?? weather.weathercode ?? 0);

  const isRaining = (code >= 61 && code <= 67) || (code >= 80 && code <= 82) || code >= 95;
  const isSnowing = code >= 71 && code <= 77;

  if (!isDay) return { canGoOut: false, qualifier: 'after dark', weatherNote: 'Sun has set — wait for tomorrow morning.' };
  if (isRaining) return { canGoOut: false, qualifier: 'rainy', weatherNote: 'It is raining right now. Try to get light near a bright window instead.' };
  if (isSnowing) return { canGoOut: false, qualifier: 'snowy', weatherNote: 'Snowing outside — a bright window will help, or step out briefly if safe.' };
  if (cloudCover > 85) return { canGoOut: true, qualifier: 'overcast', weatherNote: 'Heavy cloud cover today — outdoor light still helps, just stay out a bit longer.' };
  if (cloudCover > 60) return { canGoOut: true, qualifier: 'partly cloudy', weatherNote: 'Partly cloudy — outdoor light still works well. Aim for 15 minutes.' };

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

  if (lastNotificationDate !== todayKey) {
    sunlightFiredToday.clear();
    lastNotificationDate = todayKey;
  }

  const coords = prefs?.preferredLocation || null;
  const wakeTarget = prefs?.wakeTarget || '07:30';
  const wakeMinutes = parseHHMMtoMinutes(wakeTarget) || 450;

  const sunTimes = coords ? getSunriseSunset(coords) : null;
  const sunriseMinutes = sunTimes?.sunriseMinutes ?? 360;
  const goldenHourEnd = sunTimes?.goldenHourEndMinutes ?? 480;

  const morningStart = Math.max(wakeMinutes, sunriseMinutes);
  const morningEnd = morningStart + 120;
  const afternoonStart = wakeMinutes + 5 * 60;
  const afternoonEnd = wakeMinutes + 7 * 60;

  const weather = coords ? await fetchWeather(coords) : null;
  const { canGoOut, qualifier, weatherNote } = getWeatherAdvice(weather);

  const morningId = `${todayKey}-morning`;
  if (
    !sunlightFiredToday.has(morningId) &&
    nowMinutes >= morningStart &&
    nowMinutes <= morningEnd &&
    !isInWorkBlock(schedule, nowMinutes)
  ) {
    const isGoldenHour = nowMinutes <= goldenHourEnd;
    const goldenNote = isGoldenHour ? ' The golden hour light right now is especially powerful.' : '';
    const body = canGoOut
      ? `Step outside for 10–15 minutes now. ${weatherNote}${goldenNote}`
      : `${weatherNote} Try to sit near your brightest window for 15 minutes.`;

    const payload = {
      id: morningId,
      title: `☀️ Morning sunlight${qualifier ? ` (${qualifier})` : ''}`,
      body,
      canGoOut
    };

    sendSunlightNotification(payload);
    if (Notification.isSupported()) {
      try { new Notification({ title: payload.title, body }).show(); } catch (_) {}
    }
    sunlightFiredToday.add(morningId);
  }

  const afternoonId = `${todayKey}-afternoon`;
  if (
    !sunlightFiredToday.has(afternoonId) &&
    nowMinutes >= afternoonStart &&
    nowMinutes <= afternoonEnd &&
    !isInWorkBlock(schedule, nowMinutes)
  ) {
    const body = canGoOut
      ? `A 10-minute walk outside now extends your afternoon alertness. ${weatherNote}`
      : `${weatherNote} Step near a bright window for a few minutes.`;

    const payload = {
      id: afternoonId,
      title: `🌤️ Afternoon light nudge${qualifier ? ` (${qualifier})` : ''}`,
      body,
      canGoOut
    };

    sendSunlightNotification(payload);
    if (Notification.isSupported()) {
      try { new Notification({ title: payload.title, body }).show(); } catch (_) {}
    }
    sunlightFiredToday.add(afternoonId);
  }
}

function pushStateToRenderer(state) {
  broadcast('luxshift:winddown-state', state);
  updateTrayMenu(state);
}

async function applyDisplayAdaptation(intensity) {
  if (process.platform !== 'darwin') return;

  if (intensity <= 0) {
    await applyNightShift(0);
    await setBrightness(1.0);
    return;
  }

  const strength = parseFloat((0.05 + intensity * 0.67).toFixed(3));
  await applyNightShift(strength);

  const brightnessIntensity = Math.max(0, (intensity - 0.5) * 2);
  const targetBrightness = 1.0 - (brightnessIntensity * (1.0 - MIN_BRIGHTNESS));
  await setBrightness(targetBrightness);
}

function runWindDownTick() {
  const prefs = getPreferences();
  const scheduleResult = getActiveSchedule();
  const schedule = scheduleResult?.schedule || null;

  const state = computeWindDownState(prefs, schedule);
  pushStateToRenderer(state);
  applyDisplayAdaptation(state.intensity).catch(() => {});

  if (smartBulbManager?.enabled && smartBulbManager?.activeController) {
    smartBulbManager.onWindDownTick(state).catch(() => {});
  }

  checkSunlightNotifications(prefs, schedule).catch(() => {});
}

function startWindDownTick() {
  if (windDownTickInterval) return;
  // Delay first tick by 5s so startup applyNightShift(0) runs first
  // and we don't immediately flip Night Shift on if bedtime is near
  setTimeout(() => {
    if (!windDownTickInterval) return; // stopped before first tick
    runWindDownTick();
    windDownTickInterval = setInterval(runWindDownTick, 60 * 1000);
  }, 5000);
}

function stopWindDownTick() {
  if (windDownTickInterval) {
    clearInterval(windDownTickInterval);
    windDownTickInterval = null;
  }
  applyNightShift(0).catch(() => {});
}

function getCurrentWindDownState() {
  const prefs = getPreferences();
  const scheduleResult = getActiveSchedule();
  const schedule = scheduleResult?.schedule || null;
  return computeWindDownState(prefs, schedule);
}

async function checkForUpdates(showFeedback = false) {
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    });

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
        label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? 'Hide Window' : 'Show Window',
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
      ? 'LuxShift • Wind-down'
      : current.phase === 'bedtime'
        ? 'LuxShift • Bedtime'
        : 'LuxShift';

  tray.setToolTip(title);
}

app.whenReady().then(async () => {
  app.setName('LuxShift');

  if (process.platform === 'darwin') {
    app.setAppUserModelId('com.luxshiftofficial.luxshift');
  }

  preferencesStore = new PreferencesStore({
    name: 'luxshift-preferences',
    cwd: app.getPath('userData'),
    defaults: DEFAULT_PREFERENCES
  });

  smartBulbManager = new SmartBulbManager(preferencesStore);

  archiveExpiredActiveSchedule();
  createWindow();

  await applyNightShift(0);

  if (smartBulbManager.enabled && smartBulbManager.activeControllerType) {
    await smartBulbManager.setProtocol(smartBulbManager.activeControllerType);
    await smartBulbManager.enable(true);
  }

  startWindDownTick();
  createTray();

  keepAlivePinger = new KeepAlivePinger();
  keepAlivePinger.start();

  checkForUpdates(false).catch(() => {});
  app.on('activate', showMainWindow);
});

app.on('before-quit', () => {
  isQuitting = true;

  // Clear the tick first so no more Night Shift calls happen
  if (windDownTickInterval) {
    clearInterval(windDownTickInterval);
    windDownTickInterval = null;
  }

  // Turn Night Shift off synchronously before the process exits
  // We cannot use await here — Electron does not wait for async before-quit handlers
  if (process.platform === 'darwin' && fs.existsSync(NIGHTSHIFT_BIN)) {
    try {
      // stdio: 'ignore' avoids EIO write errors during quit, when the app's
      // own stdio pipes may already be torn down (e.g. launched from Finder).
      // Without this, execFileSync's internal pipe writes can surface as an
      // uncaught exception that bypasses this try/catch entirely.
      require('child_process').execFileSync(NIGHTSHIFT_BIN, ['off'], {
        timeout: 3000,
        stdio: 'ignore'
      });
    } catch (_) {}
  }

  if (keepAlivePinger) keepAlivePinger.stop();
  smartBulbManager?.shutdown?.();
});

app.on('window-all-closed', () => {
  // App stays alive in background (tray icon)
});

ipcMain.handle('luxshift:get-preferences', async () => getPreferences());

ipcMain.handle('luxshift:save-preferences', async (_event, payload) => {
  const next = buildSafePreferences(payload);
  preferencesStore.set(next);
  return {
    ok: true,
    preferences: getPreferences(),
    windDownState: getCurrentWindDownState()
  };
});

ipcMain.handle('luxshift:get-active-schedule', async () => getActiveSchedule());

ipcMain.handle('luxshift:save-active-schedule', async (_event, payload) => {
  return saveActiveSchedule(payload);
});

ipcMain.handle('luxshift:clear-active-schedule', async () => {
  return clearActiveSchedule();
});

ipcMain.handle('luxshift:archive-expired-schedule', async () => {
  return archiveExpiredActiveSchedule();
});

ipcMain.handle('luxshift:get-winddown-state', async () => getCurrentWindDownState());

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

ipcMain.handle('luxshift:request-notifications', async () => {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'LuxShift',
        body: 'Notifications enabled — you will receive sunlight nudges and bedtime reminders.',
        silent: true
      });
      n.show();
      setTimeout(() => {
        try { n.close(); } catch (_) {}
      }, 3000);
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

ipcMain.handle('luxshift:get-user-api-key', async () => getUserApiKey());

ipcMain.handle('luxshift:save-user-api-key', async (_event, { key, provider }) => {
  return saveUserApiKey(key, provider);
});

ipcMain.handle('luxshift:delete-user-api-key', async () => {
  return deleteUserApiKey();
});

ipcMain.handle('luxshift:clear-all-user-data', async () => {
  return clearAllUserData();
});

ipcMain.handle('luxshift:calendar:google:connect-interactive', async () => {
  try {
    // If we already have valid tokens, skip OAuth and just return calendars
    const existingTokens = preferencesStore.get('googleCalendarTokens');
    if (existingTokens) {
      try {
        const client = new GoogleCalendarClient();
        await client.initialize(existingTokens);
        const calendars = await client.listCalendars();
        return { ok: true, calendars, reused: true };
      } catch (_) {
        // Tokens expired or invalid — fall through to fresh OAuth
        preferencesStore.set('googleCalendarTokens', null);
      }
    }
    // Fresh OAuth flow
    const client = new GoogleCalendarClient();
    const tokens = await client.connectInteractive((url) => shell.openExternal(url));
    preferencesStore.set('googleCalendarTokens', tokens);
    const calendars = await client.listCalendars();
    return { ok: true, calendars };
  } catch (error) {
    return { ok: false, error: error.message || 'Google Calendar connection failed.' };
  }
});

ipcMain.handle('luxshift:calendar:google:list-calendars', async () => {
  try {
    const tokens = preferencesStore.get('googleCalendarTokens');
    if (!tokens) return { ok: false, error: 'Not connected. Click Connect first.' };

    const client = new GoogleCalendarClient();
    await client.initialize(tokens);
    const calendars = await client.listCalendars();
    return { ok: true, calendars };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('luxshift:calendar:google:fetch-events', async (_event, { calendarIds, startDate, endDate }) => {
  try {
    const tokens = preferencesStore.get('googleCalendarTokens');
    if (!tokens) return { ok: false, error: 'Not connected. Click Connect first.' };

    const client = new GoogleCalendarClient();
    await client.initialize(tokens);
    const events = await client.getEvents(calendarIds, new Date(startDate), new Date(endDate));
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('luxshift:calendar:google:is-connected', async () => {
  return { ok: true, connected: Boolean(preferencesStore.get('googleCalendarTokens')) };
});

ipcMain.handle('luxshift:calendar:google:disconnect', async () => {
  preferencesStore.set('googleCalendarTokens', null);
  return { ok: true };
});

ipcMain.handle('luxshift:calendar:apple:check-access', async () => {
  const client = new AppleCalendarClient();
  const hasAccess = await client.checkAccess();
  return { ok: true, hasAccess };
});

ipcMain.handle('luxshift:calendar:apple:list-calendars', async () => {
  const client = new AppleCalendarClient();
  const calendars = await client.listCalendars();
  return { ok: true, calendars };
});

ipcMain.handle('luxshift:calendar:apple:fetch-events', async (_event, { calendarNames, startDate, endDate }) => {
  try {
    const client = new AppleCalendarClient();
    const events = await client.getEvents(calendarNames, new Date(startDate), new Date(endDate));
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('luxshift:calendar:notion:connect', async (_event, { token, databaseId }) => {
  try {
    const client = new NotionCalendarClient();
    const ok = await client.initialize(token, databaseId);
    if (ok) preferencesStore.set('notionConfig', { token, databaseId });
    return { ok };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('luxshift:calendar:notion:fetch-events', async (_event, { token, databaseId, startDate, endDate }) => {
  try {
    const client = new NotionCalendarClient();
    await client.initialize(token, databaseId);
    const events = await client.getEvents(new Date(startDate), new Date(endDate));
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('luxshift:calendar:ics:parse', async (_event, { content, startDate, endDate }) => {
  try {
    const events = parseICS(content, startDate ? new Date(startDate) : null, endDate ? new Date(endDate) : null);
    return { ok: true, events };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('luxshift:smartbulb:get-protocols', async () => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return { ok: true, protocols: smartBulbManager.getAvailableProtocols() };
});

ipcMain.handle('luxshift:smartbulb:discover', async (_event, { protocol }) => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };

  try {
    if (protocol) {
      const controller = smartBulbManager.controllers[protocol];
      if (!controller) return { ok: false, error: `Unknown protocol: ${protocol}` };
      const bulbs = await controller.discover();
      if (smartBulbManager.activeControllerType === protocol) smartBulbManager._mergeBulbs();
      return { ok: true, bulbs };
    }

    const results = await smartBulbManager.discoverAll();
    smartBulbManager._mergeBulbs();
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('luxshift:smartbulb:set-protocol', async (_event, { protocol }) => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return smartBulbManager.setProtocol(protocol);
});

ipcMain.handle('luxshift:smartbulb:enable', async (_event, { enabled }) => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return smartBulbManager.enable(enabled);
});

ipcMain.handle('luxshift:smartbulb:get-bulbs', async () => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return { ok: true, bulbs: smartBulbManager.getBulbs() };
});

ipcMain.handle('luxshift:smartbulb:control', async (_event, { bulbId, action, params = {} }) => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return smartBulbManager.controlBulb(bulbId, action, params);
});

ipcMain.handle('luxshift:smartbulb:apply-winddown', async (_event, { intensity, transitionMs }) => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return smartBulbManager.applyWindDownState(intensity, transitionMs);
});

ipcMain.handle('luxshift:smartbulb:restore-normal', async (_event, { transitionMs }) => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return smartBulbManager.restoreNormal(transitionMs);
});

ipcMain.handle('luxshift:smartbulb:get-status', async () => {
  if (!smartBulbManager) return { ok: false, error: 'Smart bulb manager not initialized' };
  return {
    ok: true,
    enabled: smartBulbManager.enabled,
    protocol: smartBulbManager.activeControllerType,
    bulbs: smartBulbManager.getConnectedBulbs().length,
    totalBulbs: smartBulbManager.getBulbs().length
  };
});