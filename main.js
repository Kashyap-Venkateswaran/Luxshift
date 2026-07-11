const {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  Tray,
  Menu,
  nativeImage,
  dialog,
  shell
} = require('electron');
const path = require('path');
const PreferencesStore = require('electron-store').default;
const brightness = require('brightness');
const {
  getActiveSchedule,
  saveActiveSchedule,
  clearActiveSchedule,
  archiveExpiredActiveSchedule
} = require('./schedule-store.js');

// TODO: replace with your real GitHub repo once created, e.g. 'yourusername/luxshift'
const GITHUB_REPO = 'LuxshiftOfficial/Luxshift';

let preferencesStore;
let mainWindow = null;
let tray = null;
let windDownInterval = null;
let lastWindDownSnapshot = null;
let lastSunlightNudgeAt = 0;
let baseDisplayBrightness = null;
let lastAppliedBrightness = null;
let brightnessAvailable = true;
let isQuitting = false;

function loadServices() {
  return require(path.join(__dirname, 'llm', 'schedule-service.js'));
}

function getTrayIcon() {
  const iconPathPng = path.join(__dirname, 'assets', 'tray-iconTemplate.png');
  const iconPathAltPng = path.join(__dirname, 'tray-icon.png');

  let image = nativeImage.createEmpty();

  try {
    image = nativeImage.createFromPath(iconPathPng);
    if (!image.isEmpty()) return image.resize({ width: 18, height: 18 });
  } catch (_error) {}

  try {
    image = nativeImage.createFromPath(iconPathAltPng);
    if (!image.isEmpty()) return image.resize({ width: 18, height: 18 });
  } catch (_error) {}

  const fallbackSvg = `
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="3" width="12" height="12" rx="4" fill="white"/>
      <path d="M6 11.8V6.2h1.4v4.4H12v1.2H6z" fill="black"/>
    </svg>
  `.trim();

  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(fallbackSvg)}`);
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

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
      } catch (_error) {}
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function showMainWindow() {
  const win = createWindow();

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();

  return win;
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
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
    win.webContents.send(channel, payload);
  }
}

function getPreferences() {
  return preferencesStore?.store || {
    bedtimeTarget: '00:30',
    wakeTarget: '07:30',
    windDownMinutes: 90,
    preferredLocationName: '',
    preferredLocation: null,
    timeFormat: '12h',
    timeFormatChosen: false
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

function buildSafePreferences(payload = {}) {
  const current = getPreferences();

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
        ? payload.preferredLocationName
        : current.preferredLocationName,
    preferredLocation:
      payload?.preferredLocation && typeof payload.preferredLocation === 'object'
        ? payload.preferredLocation
        : payload?.preferredLocation === null
          ? null
          : current.preferredLocation,
    timeFormat:
      payload?.timeFormat === '24h'
        ? '24h'
        : payload?.timeFormat === '12h'
          ? '12h'
          : current.timeFormat
  };
}

function formatClockLabel(hhmm, use24h = false) {
  if (!hhmm) return '';
  const [hours, minutes] = hhmm.split(':');
  const h = Number(hours);
  const m = Number(minutes);

  if (!Number.isInteger(h) || !Number.isInteger(m)) return hhmm;

  if (use24h) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;

  return `${displayH}:${String(m).padStart(2, '0')} ${period}`;
}

function minutesUntilClockTime(hhmm, now = new Date()) {
  if (!hhmm) return null;
  const [hours, minutes] = hhmm.split(':');
  const targetH = Number(hours);
  const targetM = Number(minutes);

  if (!Number.isInteger(targetH) || !Number.isInteger(targetM)) return null;
  if (targetH < 0 || targetH > 23 || targetM < 0 || targetM > 59) return null;

  const nowH = now.getHours();
  const nowM = now.getMinutes();

  const nowMinutes = nowH * 60 + nowM;
  const targetMinutes = targetH * 60 + targetM;

  let diff = targetMinutes - nowMinutes;
  if (diff < 0) diff += 24 * 60;

  return diff;
}

function computeWindDownState(now = new Date()) {
  const prefs = getPreferences();
  const scheduleResult = getActiveSchedule();
  const schedule = scheduleResult?.schedule || null;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const windDownMinutes =
    Number(prefs?.windDownMinutes) || 90;

  const bedtimeTarget = prefs?.bedtimeTarget || null;
  const wakeTarget = prefs?.wakeTarget || null;

  if (!bedtimeTarget && !wakeTarget) {
    return {
      intensity: 0,
      minutesToBedtime: null,
      windDownMinutes,
      phase: 'normal',
      bedtimeDisplay: 'Not set'
    };
  }

  let bedtimeMinutes = null;

  if (bedtimeTarget) {
    const [hours, minutes] = bedtimeTarget.split(':');
    const h = Number(hours);
    const m = Number(minutes);
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      bedtimeMinutes = h * 60 + m;
    }
  } else if (wakeTarget) {
    const [hours, minutes] = wakeTarget.split(':');
    const h = Number(hours);
    const m = Number(minutes);
    if (Number.isInteger(h) && Number.isInteger(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      bedtimeMinutes = h * 60 + m - 90;
    }
  }

  if (bedtimeMinutes === null) {
    return {
      intensity: 0,
      minutesToBedtime: null,
      windDownMinutes,
      phase: 'normal',
      bedtimeDisplay: 'Not set'
    };
  }

  let minutesToBedtime = bedtimeMinutes - nowMinutes;

  if (minutesToBedtime < -(24 * 60 - windDownMinutes)) {
    minutesToBedtime += 24 * 60;
  }

  const bedtimeDisplay = formatClockLabel(bedtimeTarget || '');

  if (minutesToBedtime < 0 && minutesToBedtime >= -30) {
    return {
      intensity: 1.0,
      minutesToBedtime: 0,
      windDownMinutes,
      targetBrightness: 0.35,
      phase: 'bedtime',
      bedtimeDisplay
    };
  }

  if (minutesToBedtime < -30) {
    return {
      intensity: 0,
      minutesToBedtime: null,
      windDownMinutes,
      targetBrightness: 1.0,
      phase: 'normal',
      bedtimeDisplay
    };
  }

  if (minutesToBedtime > windDownMinutes) {
    return {
      intensity: 0,
      minutesToBedtime,
      windDownMinutes,
      targetBrightness: 1.0,
      phase: minutesToBedtime <= windDownMinutes + 15 ? 'approaching' : 'normal',
      bedtimeDisplay
    };
  }

  const progress = 1 - (minutesToBedtime / windDownMinutes);
  const intensity = progress * progress;

  const targetBrightness = 1.0 - (intensity * (1.0 - 0.35));

  return {
    intensity,
    minutesToBedtime,
    windDownMinutes,
    targetBrightness,
    phase: 'winding-down',
    bedtimeDisplay
  };
}

function windDownChanged(next, prev) {
  if (!prev) return true;
  return (
    next.phase !== prev.phase ||
    Math.abs(next.intensity - prev.intensity) > 0.01
  );
}

async function brightnessGetAsync() {
  if (!brightnessAvailable) return null;
  try {
    const value = await brightness.getBrightness();
    return value;
  } catch (_error) {
    brightnessAvailable = false;
    return null;
  }
}

async function brightnessSetAsync(value) {
  if (!brightnessAvailable) return;
  try {
    await brightness.setBrightness(value);
  } catch (_error) {
    brightnessAvailable = false;
  }
}

async function ensureBaseBrightness() {
  if (!brightnessAvailable) return;

  try {
    const value = await brightnessGetAsync();
    if (value === null) {
      brightnessAvailable = false;
      return;
    }
    baseDisplayBrightness = value;
    lastAppliedBrightness = value;
  } catch (_error) {
    brightnessAvailable = false;
  }
}

async function applySystemBrightnessForState(state) {
  if (!state || !brightnessAvailable) return;

  try {
    const target = state.targetBrightness || 1.0;
    if (target < lastAppliedBrightness - 0.01 || target > lastAppliedBrightness + 0.01) {
      await brightnessSetAsync(target);
      lastAppliedBrightness = target;
    }
  } catch (_error) {
    brightnessAvailable = false;
  }
}

async function restoreBrightnessOnExit() {
  if (!brightnessAvailable) return;
  if (baseDisplayBrightness === null || lastAppliedBrightness === null) return;

  try {
    await brightnessSetAsync(baseDisplayBrightness);
  } catch (_error) {
    brightnessAvailable = false;
  }
}

async function maybeEmitSunlightNudge(state) {
  if (!state || state.phase !== 'bedtime') return;

  const now = Date.now();
  if (now - lastSunlightNudgeAt < 1000 * 60 * 60 * 10) return;

  const prefs = getPreferences();
  const hasManualLocation = Boolean(
    prefs.preferredLocation?.latitude && prefs.preferredLocation?.longitude
  );

  lastSunlightNudgeAt = now;

  broadcast('luxshift:sunlight-nudge', {
    title: 'Tomorrow morning light reminder',
    body: hasManualLocation
      ? 'Try to get some natural light soon after waking to help reinforce your sleep schedule.'
      : 'Tomorrow morning, try to get natural light soon after waking. Adding a saved location can make LuxShift more context-aware.',
    canGoOut: true,
    emittedAt: new Date(now).toISOString()
  });
}

/* ---------- Update check (manual, non-auto) ---------- */

function parseVersionParts(version) {
  return String(version || '0.0.0')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);
  const length = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < length; i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return 0;
}

async function fetchLatestRelease() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' }
  });

  if (!response.ok) {
    throw new Error(`GitHub release lookup failed (${response.status}).`);
  }

  return response.json();
}

async function checkForUpdates(showFeedbackWhenUpToDate = false) {
  try {
    const release = await fetchLatestRelease();
    const latestVersion = release?.tag_name || release?.name;
    const currentVersion = app.getVersion();

    if (!latestVersion) {
      if (showFeedbackWhenUpToDate) {
        dialog.showMessageBox({
          type: 'info',
          title: 'LuxShift Updates',
          message: 'Could not determine the latest version right now.'
        });
      }
      return;
    }

    const isNewer = compareVersions(latestVersion, currentVersion) > 0;

    if (isNewer) {
      const result = await dialog.showMessageBox({
        type: 'info',
        title: 'Update available',
        message: `A new version of LuxShift is available (${latestVersion}).`,
        detail: 'You are currently on an older version. Download the latest release to update.',
        buttons: ['Download Update', 'Later'],
        defaultId: 0,
        cancelId: 1
      });

      if (result.response === 0) {
        const releaseUrl =
          release?.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`;
        shell.openExternal(releaseUrl);
      }
    } else if (showFeedbackWhenUpToDate) {
      dialog.showMessageBox({
        type: 'info',
        title: 'LuxShift Updates',
        message: `You're up to date (v${currentVersion}).`
      });
    }
  } catch (error) {
    if (showFeedbackWhenUpToDate) {
      dialog.showMessageBox({
        type: 'error',
        title: 'LuxShift Updates',
        message: 'Could not check for updates.',
        detail: error?.message || 'Please check your internet connection and try again.'
      });
    }
  }
}

/* ---------- Tray ---------- */

function updateTrayMenu(state = null) {
  if (!tray) return;

  const currentState = state || lastWindDownSnapshot || computeWindDownState();
  const minutesLabel =
    currentState?.minutesToBedtime === null || currentState?.minutesToBedtime === undefined
      ? 'No bedtime set'
      : currentState.minutesToBedtime <= 0
        ? 'Bedtime reached'
        : `${currentState.minutesToBedtime}m to bedtime`;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open LuxShift',
      click: () => showMainWindow()
    },
    {
      label: 'Open Settings',
      click: () => {
        showMainWindow();
        // If you add a settings section anchor (e.g. #settings) in index.html,
        // you can navigate there here via renderer API later.
      }
    },
    { type: 'separator' },
    {
      label: mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? 'Hide Window' : 'Show Window',
      click: () => toggleMainWindow()
    },
    { type: 'separator' },
    {
      label: `Mode: ${currentState?.phase || 'normal'}`,
      enabled: false
    },
    {
      label: `Status: ${minutesLabel}`,
      enabled: false
    },
    {
      label: `Bedtime: ${currentState?.bedtimeDisplay || 'Not set'}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Check for Updates…',
      click: () => checkForUpdates(true)
    },
    { type: 'separator' },
    {
      label: 'Quit LuxShift',
      click: async () => {
        isQuitting = true;
        await restoreBrightnessOnExit();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  const trayTitle =
    currentState?.phase === 'winding-down'
      ? 'LuxShift • Wind-down'
      : currentState?.phase === 'bedtime'
        ? 'LuxShift • Bedtime'
        : 'LuxShift';

  tray.setToolTip(trayTitle);
}

function createTray() {
  if (tray) return tray;

  tray = new Tray(getTrayIcon());
  tray.setIgnoreDoubleClickEvents(true);

  tray.on('click', () => {
    toggleMainWindow();
  });

  tray.on('right-click', () => {
    updateTrayMenu();
    tray.popUpContextMenu();
  });

  updateTrayMenu();
  return tray;
}

async function publishWindDownState(force = false) {
  const state = computeWindDownState();

  if (force || windDownChanged(state, lastWindDownSnapshot)) {
    lastWindDownSnapshot = state;
    broadcast('luxshift:winddown-state', state);
    updateTrayMenu(state);
  }

  if (state.phase !== 'normal') {
    await applySystemBrightnessForState(state);
  }

  if (state.phase === 'bedtime') {
    await maybeEmitSunlightNudge(state);
  }

  const latest = computeWindDownState();
  updateTrayMenu(latest);
  return latest;
}

function startWindDownEngine() {
  if (windDownInterval) clearInterval(windDownInterval);

  publishWindDownState(true).catch(() => {});

  windDownInterval = setInterval(() => {
    publishWindDownState(false).catch(() => {});
  }, 60 * 1000);
}

app.whenReady().then(async () => {
  app.setName('LuxShift');

  preferencesStore = new PreferencesStore({
    name: 'luxshift-preferences',
    cwd: app.getPath('userData'),
    defaults: {
      bedtimeTarget: '00:30',
      wakeTarget: '07:30',
      windDownMinutes: 90,
      preferredLocationName: '',
      preferredLocation: null,
      timeFormat: '12h',
      timeFormatChosen: false
    }
  });

  await ensureBaseBrightness();
  createWindow();
  createTray();
  startWindDownEngine();

  // Silent check on startup — only interrupts the user if an update exists.
  checkForUpdates(false).catch(() => {});

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('before-quit', async () => {
  isQuitting = true;

  if (windDownInterval) {
    clearInterval(windDownInterval);
    windDownInterval = null;
  }

  await restoreBrightnessOnExit();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

ipcMain.handle('luxshift:get-preferences', async () => getPreferences());
ipcMain.handle('luxshift:save-preferences', async (_event, payload) => {
  const next = buildSafePreferences(payload);
  preferencesStore.set(next);
  const state = await publishWindDownState(true);
  return { ok: true, preferences: getPreferences(), windDownState: state };
});

ipcMain.handle('luxshift:search-location', async (_event, query) => {
  const q = String(query || '').trim();

  if (q.length < 2) {
    return { ok: false, error: 'Please enter at least 2 characters.' };
  }

  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
    const response = await fetch(url);

    if (!response.ok) {
      return { ok: false, error: `Location search failed (${response.status}).` };
    }

    const data = await response.json();
    const results = Array.isArray(data?.results)
      ? data.results.map((item) => ({
          id: `${item.latitude},${item.longitude}`,
          name: [item.name, item.admin1, item.country].filter(Boolean).join(', '),
          latitude: item.latitude,
          longitude: item.longitude,
          timezone: item.timezone || null,
          country: item.country || null,
          admin1: item.admin1 || null
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
    return {
      ok: true,
      environment: {
        latitude,
        longitude,
        timezone: data?.timezone || null,
        current: data?.current || null
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

  const title = String(payload?.title || 'LuxShift').trim() || 'LuxShift';
  const body = String(payload?.body || '').trim();

  try {
    new Notification({ title, body }).show();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Notification failed.' };
  }
});

ipcMain.handle('luxshift:parse-schedule', async (_event, payload) => {
  try {
    const services = loadServices();
    return await services.parseSchedule(payload?.text || '');
  } catch (error) {
    return { ok: false, error: error?.message || 'Schedule parsing failed.' };
  }
});

ipcMain.handle('luxshift:get-active-schedule', async () => getActiveSchedule());
ipcMain.handle('luxshift:save-active-schedule', async (_event, payload) => saveActiveSchedule(payload));
ipcMain.handle('luxshift:clear-active-schedule', async () => clearActiveSchedule());
ipcMain.handle('luxshift:archive-expired-schedule', async () => archiveExpiredActiveSchedule());
ipcMain.handle('luxshift:get-winddown-state', async () => publishWindDownState(true));
ipcMain.handle('luxshift:check-for-updates', async () => {
  await checkForUpdates(true);
  return { ok: true };
});