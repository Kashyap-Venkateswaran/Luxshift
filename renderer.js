const input = document.getElementById('input');
const lateChangesInput = document.getElementById('lateChangesInput');
const preview = document.getElementById('preview');
const modeValue = document.getElementById('modeValue');
const envValue = document.getElementById('envValue');
const parseBtn = document.getElementById('parseBtn');
const fillBtn = document.getElementById('fillBtn');
const clearBtn = document.getElementById('clearBtn');
const retryEnvBtn = document.getElementById('retryEnvBtn');
const settingsHint = document.getElementById('settingsHint');
const bedtimeInput = document.getElementById('bedtimeInput');
const wakeInput = document.getElementById('wakeInput');
const windDownInput = document.getElementById('windDownInput');
const timeFormatInput = document.getElementById('timeFormatInput');
const locationSearchInput = document.getElementById('locationSearchInput');
const searchLocationBtn = document.getElementById('searchLocationBtn');
const saveSettingsBtn = document.getElementById('saveSettingsBtn');
const useDeviceLocationBtn = document.getElementById('useDeviceLocationBtn');
const locationResults = document.getElementById('locationResults');
const envHint = document.getElementById('envHint');
const settingsSummary = document.getElementById('settingsSummary');

const overlayEl = document.getElementById('luxshift-overlay');
const winddownBar = document.getElementById('winddown-bar');
const winddownLabel = document.getElementById('winddown-label');

 // Image upload elements
 const imageUpload = document.getElementById('imageUpload');
 const imageUploadBtn = document.getElementById('imageUploadBtn');
 const imagePreview = document.getElementById('imagePreview');
 const imagePreviewImg = document.getElementById('imagePreviewImg');
 const removeImageBtn = document.getElementById('removeImageBtn');

 const exampleText = 'My day starts at 9:00 AM. I have focused work until 12:30 PM, lunch after that, a football game I want to watch at 1:00 PM, then more work in the evening, and I expect everything to end by 11:00 PM.';
 const exampleLateChange = 'Please move the afternoon around the football game and keep the updated timeline until the day ends.';
 const appName = window.luxshiftAPI?.appName || 'LuxShift';
 const platform = window.luxshiftAPI?.platform || 'unknown';

 let environmentLoading = false;
 let settingsSaving = false;
 let windDownListener = null;
 let sunlightListener = null;
 let preferences = {
   bedtimeTarget: '00:30',
   wakeTarget: '07:30',
   windDownMinutes: 90,
   preferredLocationName: '',
   preferredLocation: null,
   timeFormat: '12h',
   timeFormatChosen: false
 };

 // API Key state
 let userApiKey = null;
 let userApiProvider = 'groq';
 let userApiAzureConfig = {};

 // Image upload state
 let uploadedImage = null;
 let lateChangesUploadedImage = null;

 wireUI();
 renderInitialState();
 bootstrap();

 async function parseScheduleViaProxy(text, images = []) {
   const headers = { 'Content-Type': 'application/json' };
   if (userApiKey) {
     headers['x-user-provider'] = userApiProvider;
     headers['x-user-api-key'] = userApiKey;
   }

   const body = { text };
   if (images.length > 0) {
     body.images = images;
   }

   const response = await fetch('https://luxshift.onrender.com/parse-schedule', {
     method: 'POST',
     headers,
     body: JSON.stringify(body)
   });

   const data = await response.json();

   if (!response.ok) {
     throw new Error(data?.error || data?.details?.error || 'Proxy parsing failed.');
   }

   // Update key source status from response header
   const keySource = response.headers.get('x-key-source');
   updateKeySourceStatus(keySource);

   return {
     summary: data?.summary || '',
     blocks: Array.isArray(data?.blocks) ? data.blocks : [],
     confidence: typeof data?.confidence === 'number' ? data.confidence : 0.9,
     reasons: Array.isArray(data?.reasons) ? data.reasons : [],
     source: 'nvidia-proxy',
     unavailable: false
   };
 }

 function applyWindDownState(state) {
   if (!overlayEl || !winddownBar || !winddownLabel) return;

   const intensity = Number(state?.intensity ?? 0);
   const phase = state?.phase || 'normal';
   const minutesToBedtime = state?.minutesToBedtime ?? null;
   const bedtimeLabel = state?.bedtimeDisplay || state?.bedtimeLabel || null;
   const dimness = Number(state?.visualDimness ?? intensity * 0.62);
   const warmth = Number(state?.visualWarmth ?? intensity * 0.92);
   const softness = Number(state?.visualSoftness ?? intensity * 0.48);

   document.documentElement.style.setProperty('--lux-dimness', String(dimness));
   document.documentElement.style.setProperty('--lux-warmth', String(warmth));
   document.documentElement.style.setProperty('--lux-softness', String(softness));

   const backgroundDim = (0.02 + intensity * 0.18).toFixed(3);
   const overlayAlpha = (0.08 + intensity * 0.24).toFixed(3);
   const warmAlpha = (0.04 + intensity * 0.18).toFixed(3);

   if (intensity <= 0 || phase === 'normal') {
     overlayEl.style.background = 'transparent';
     overlayEl.style.opacity = '0';
     winddownBar.classList.remove('visible');
     document.body.classList.remove('winddown-active');
     modeValue.textContent = 'Normal';
     winddownLabel.textContent = '';
     document.documentElement.style.setProperty('--lux-dimness', '0');
     document.documentElement.style.setProperty('--lux-warmth', '0');
     document.documentElement.style.setProperty('--lux-softness', '0');
     return;
   }

   overlayEl.style.opacity = '1';
   overlayEl.style.background = `
     radial-gradient(circle at top center, rgba(255, 206, 150, ${warmAlpha}), transparent 52%),
     linear-gradient(180deg, rgba(255, 170, 80, ${overlayAlpha}) 0%, rgba(18, 10, 4, ${backgroundDim}) 100%)
   `;

   winddownBar.classList.add('visible');
   document.body.classList.add('winddown-active');

   if (phase === 'bedtime') {
     winddownLabel.textContent = `Bedtime reached${bedtimeLabel ? ` · target ${formatTimeFromHHMM(bedtimeLabel)}` : ''}`;
     modeValue.textContent = 'Bedtime reached';
   } else if (phase === 'winding-down' && minutesToBedtime !== null) {
     const mins = Math.max(0, Math.round(minutesToBedtime));
     const bedStr = bedtimeLabel ? ` · target ${formatTimeFromHHMM(bedtimeLabel)}` : '';
     winddownLabel.textContent = `Wind-down · ${mins}m to bedtime${bedStr}`;
     modeValue.textContent = `Winding down — ${mins}m to sleep`;
   } else if (phase === 'approaching') {
     winddownLabel.textContent = 'Bedtime approaching soon';
     modeValue.textContent = 'Approaching bedtime';
   } else {
     winddownLabel.textContent = 'Wind-down active';
     modeValue.textContent = 'Wind-down active';
   }
 }

 function formatTimeFromHHMM(hhmm) {
   if (!hhmm) return '';
   const normalized = normalizeTo24Hour(hhmm);
   if (!normalized) return hhmm;
   return formatTimeForHumans(normalized);
 }

 function showSunlightBanner(payload) {
   const existing = document.getElementById('sunlight-banner');
   if (existing) existing.remove();

   const banner = document.createElement('div');
   banner.id = 'sunlight-banner';
   banner.style.cssText = `
     position: fixed;
     bottom: 24px;
     right: 24px;
     z-index: 10001;
     background: linear-gradient(135deg, rgba(255,200,50,0.15), rgba(255,160,20,0.1));
     border: 1px solid rgba(255,200,50,0.3);
     border-radius: 14px;
     padding: 16px 20px;
     max-width: 320px;
     backdrop-filter: blur(12px);
     color: #ffe4a0;
     font-size: 0.85rem;
     line-height: 1.5;
     box-shadow: 0 8px 32px rgba(0,0,0,0.4);
   `;

   const goOutIcon = payload?.canGoOut === false ? '🪟' : '🚶';
   const actionLabel = payload?.canGoOut === false ? 'Stay near window' : 'Morning light';

   banner.innerHTML = `
     <div style="font-weight:700;font-size:0.95rem;margin-bottom:6px">${escapeHtml(payload?.title || 'Morning light reminder')}</div>
     <div style="opacity:0.85;line-height:1.55">${escapeHtml(payload?.body || 'Try to get some natural light soon after waking.')}</div>
     <div style="margin-top:12px;display:flex;gap:8px;align-items:center">
       <button type="button" data-close-banner="true" style="
         background:rgba(255,200,50,0.2);border:1px solid rgba(255,200,50,0.3);
         color:#ffe4a0;border-radius:8px;padding:6px 14px;cursor:pointer;font-size:0.82rem;font-weight:600">
         ${goOutIcon} ${actionLabel}
       </button>
       <button type="button" data-close-banner="true" style="
         background:transparent;border:none;color:rgba(255,220,100,0.55);
         cursor:pointer;font-size:0.8rem;padding:6px 8px">
         Dismiss
       </button>
     </div>
   `;

   banner.addEventListener('click', (event) => {
     if (event.target?.matches?.('[data-close-banner="true"]')) {
       banner.remove();
     }
   });

   document.body.appendChild(banner);
   setTimeout(() => {
     if (banner.parentNode) banner.remove();
   }, 30000);
 }

 async function bootstrap() {
   await loadPreferences();
   await loadUserApiKey();
   bindRealtimeListeners();
   await fetchInitialWindDownState();
   await restoreActiveScheduleIfAvailable();
   startEnvironmentLoad();
   await checkPermissionsOnStartup();
 }

 async function checkPermissionsOnStartup() {
   if (!window.luxshiftAPI?.checkPermissions) return;
   try {
     const { accessibility } = await window.luxshiftAPI.checkPermissions();
     if (!accessibility) {
       showPermissionOnboarding();
     } else {
       await requestNotificationPermissionSilently();
     }
   } catch (_) {}
 }

 async function requestNotificationPermissionSilently() {
   if (!window.luxshiftAPI?.requestNotifications) return;
   try { await window.luxshiftAPI.requestNotifications(); } catch (_) {}
 }

 function showPermissionOnboarding() {
   const overlay = document.getElementById('permission-onboarding');
   if (overlay) overlay.classList.add('visible');
 }

 function hidePermissionOnboarding() {
   const overlay = document.getElementById('permission-onboarding');
   if (overlay) overlay.classList.remove('visible');
 }

 function bindRealtimeListeners() {
   if (window.luxshiftAPI?.onWindDownState) {
     windDownListener = window.luxshiftAPI.onWindDownState((state) => {
       applyWindDownState(state);
     });
   }

   if (window.luxshiftAPI?.onSunlightNudge) {
     sunlightListener = window.luxshiftAPI.onSunlightNudge((payload) => {
       if (window.luxshiftAPI?.notify) {
         window.luxshiftAPI.notify({
           title: payload?.title,
           body: payload?.body
         }).catch(() => {});
       }
       showSunlightBanner(payload);
     });
   }

   if (window.luxshiftAPI?.onPermissionStatus) {
     window.luxshiftAPI.onPermissionStatus((payload) => {
       if (payload?.accessibility) {
         const grantedMsg = document.getElementById('onboarding-granted-msg');
         const openBtn = document.getElementById('onboarding-open-settings-btn');
         if (grantedMsg) grantedMsg.style.display = 'flex';
         if (openBtn) openBtn.style.display = 'none';
         requestNotificationPermissionSilently();
         setTimeout(() => hidePermissionOnboarding(), 2000);
       }
     });
   }

   window.addEventListener('beforeunload', () => {
     if (window.luxshiftAPI?.removeWindDownListener) {
       window.luxshiftAPI.removeWindDownListener(windDownListener);
     }
     if (window.luxshiftAPI?.removeSunlightNudgeListener) {
       window.luxshiftAPI.removeSunlightNudgeListener(sunlightListener);
     }
   });
 }

 async function fetchInitialWindDownState() {
   if (!window.luxshiftAPI?.getWindDownState) return;
   try {
     const state = await window.luxshiftAPI.getWindDownState();
     applyWindDownState(state);
   } catch (_error) {}
 }

 function wireUI() {
   fillBtn?.addEventListener('click', () => {
     input.value = exampleText;
     // Only fill the main plan, not late changes
     input.focus();
   });

   clearBtn?.addEventListener('click', async () => {
     input.value = '';
     lateChangesInput.value = '';
     try {
       await window.luxshiftAPI?.clearActiveSchedule?.();
     } catch (_error) {}
     renderEmptyPreview();
     modeValue.textContent = 'Idle';
     settingsHint.textContent = 'Cleared current plan.';
   });

   parseBtn?.addEventListener('click', handleParse);
   retryEnvBtn?.addEventListener('click', () => startEnvironmentLoad(true));
   saveSettingsBtn?.addEventListener('click', saveSettings);
   searchLocationBtn?.addEventListener('click', searchManualLocation);
   useDeviceLocationBtn?.addEventListener('click', clearManualLocationAndReload);

   // Provider/API Key UI
   const providerSelect = document.getElementById('apiProviderSelect');
   const apiKeyInput = document.getElementById('apiKeyInput');
   const saveKeyBtn = document.getElementById('saveApiKeyBtn');
   const clearKeyBtn = document.getElementById('clearApiKeyBtn');
   const azureFields = document.getElementById('azureFields');
   const azureEndpoint = document.getElementById('azureEndpoint');
   const azureDeployment = document.getElementById('azureDeployment');
   const azureApiVersion = document.getElementById('azureApiVersion');

   if (providerSelect) {
     providerSelect.value = userApiProvider;
     updateAzureFieldsVisibility(userApiProvider);
     providerSelect.addEventListener('change', (e) => {
       userApiProvider = e.target.value;
       updateAzureFieldsVisibility(userApiProvider);
     });
   }

   if (apiKeyInput && userApiKey) {
     apiKeyInput.value = userApiKey;
   }

   if (saveKeyBtn) {
     saveKeyBtn.addEventListener('click', async () => {
       const key = apiKeyInput?.value?.trim();
       if (!key) {
         settingsHint.textContent = 'Please enter an API key.';
         return;
       }
       if (userApiProvider === 'azure') {
         const endpoint = azureEndpoint?.value?.trim();
         const deployment = azureDeployment?.value?.trim();
         const apiVersion = azureApiVersion?.value?.trim() || '2024-08-01-preview';
         if (!endpoint || !deployment) {
           settingsHint.textContent = 'Azure requires endpoint and deployment.';
           return;
         }
         userApiAzureConfig = { endpoint, deployment, apiVersion };
       }
       try {
         await window.luxshiftAPI?.saveUserApiKey(key, userApiProvider);
         userApiKey = key;
         settingsHint.textContent = `Saved ${userApiProvider} API key.`;
         updateKeySourceStatus('user');
       } catch (e) {
         settingsHint.textContent = 'Failed to save API key.';
       }
     });
   }

   if (clearKeyBtn) {
     clearKeyBtn.addEventListener('click', async () => {
       try {
         await window.luxshiftAPI?.deleteUserApiKey();
         userApiKey = null;
         userApiAzureConfig = {};
         if (apiKeyInput) apiKeyInput.value = '';
         settingsHint.textContent = 'API key cleared. Using shared pool.';
         updateKeySourceStatus('pool');
       } catch (e) {
         settingsHint.textContent = 'Failed to clear API key.';
       }
     });
   }

   // Clear All Data button
   const clearAllDataBtn = document.getElementById('clearAllDataBtn');
   if (clearAllDataBtn) {
     clearAllDataBtn.addEventListener('click', async () => {
       if (!confirm('This will permanently delete your API key, saved schedule, and all preferences. Are you sure?')) {
         return;
       }
       try {
         await window.luxshiftAPI?.clearAllUserData();
         userApiKey = null;
         userApiAzureConfig = {};
         if (apiKeyInput) apiKeyInput.value = '';
         input.value = '';
         lateChangesInput.value = '';
         renderEmptyPreview();
         modeValue.textContent = 'Idle';
         settingsHint.textContent = 'All user data cleared.';
         updateKeySourceStatus('pool');
         // Reset form preferences
         bedtimeInput.value = '00:30';
         wakeInput.value = '07:30';
         windDownInput.value = '90';
         timeFormatInput.value = '12h';
         locationSearchInput.value = '';
         clearLocationResults();
         clearSettingsSummary();
       } catch (e) {
         settingsHint.textContent = 'Failed to clear all data.';
       }
     });
   }

   // Toggle API key visibility
   const toggleKeyBtn = document.getElementById('toggleKeyVisibility');
   if (toggleKeyBtn && apiKeyInput) {
     toggleKeyBtn.addEventListener('click', () => {
       if (apiKeyInput.type === 'password') {
         apiKeyInput.type = 'text';
         toggleKeyBtn.textContent = 'Hide';
       } else {
         apiKeyInput.type = 'password';
         toggleKeyBtn.textContent = 'Show';
       }
     });
   }

   locationSearchInput?.addEventListener('keydown', (event) => {
     if (event.key === 'Enter') {
       event.preventDefault();
       searchManualLocation();
     }
   });

   locationSearchInput?.addEventListener('input', () => {
     if (!locationSearchInput.value.trim()) {
       clearLocationResults();
     }
   });

   // Image upload handling
   const imageUploadBtn = document.getElementById('imageUploadBtn');
   const imageUpload = document.getElementById('imageUpload');
   const removeImageBtn = document.getElementById('removeImageBtn');
   const imagePreview = document.getElementById('imagePreview');
   const imagePreviewImg = document.getElementById('imagePreviewImg');

   if (imageUploadBtn && imageUpload) {
     imageUploadBtn.addEventListener('click', () => {
       imageUpload.click();
     });
   }

   if (imageUpload) {
     imageUpload.addEventListener('change', (e) => {
       const file = e.target.files[0];
       if (!file) return;

       // Validate file type
       if (!file.type.startsWith('image/')) {
         settingsHint.textContent = 'Please select an image file.';
         return;
       }

       // Validate file size (max 10MB)
       if (file.size > 10 * 1024 * 1024) {
         settingsHint.textContent = 'Image too large. Maximum 10MB.';
         return;
       }

       const reader = new FileReader();
       reader.onload = (event) => {
         uploadedImage = {
           base64: event.target.result.split(',')[1],
           mimeType: file.type
         };
         imagePreviewImg.src = event.target.result;
         imagePreview.style.display = 'block';
         settingsHint.textContent = 'Image uploaded. Ready to parse.';
       };
       reader.readAsDataURL(file);
     });
   }

   if (removeImageBtn) {
     removeImageBtn.addEventListener('click', () => {
       uploadedImage = null;
       imagePreview.style.display = 'none';
       imagePreviewImg.src = '';
       if (imageUpload) imageUpload.value = '';
       settingsHint.textContent = 'Image removed.';
     });
   }

   // Late Changes Image upload handling
   const lateChangesImageUploadBtn = document.getElementById('lateChangesImageUploadBtn');
   const lateChangesImageUpload = document.getElementById('lateChangesImageUpload');
   const lateChangesRemoveImageBtn = document.getElementById('lateChangesRemoveImageBtn');
   const lateChangesImagePreview = document.getElementById('lateChangesImagePreview');
   const lateChangesImagePreviewImg = document.getElementById('lateChangesImagePreviewImg');

   if (lateChangesImageUploadBtn && lateChangesImageUpload) {
     lateChangesImageUploadBtn.addEventListener('click', () => {
       lateChangesImageUpload.click();
     });
   }

   if (lateChangesImageUpload) {
     lateChangesImageUpload.addEventListener('change', (e) => {
       const file = e.target.files[0];
       if (!file) return;

       // Validate file type
       if (!file.type.startsWith('image/')) {
         settingsHint.textContent = 'Please select an image file.';
         return;
       }

       // Validate file size (max 10MB)
       if (file.size > 10 * 1024 * 1024) {
         settingsHint.textContent = 'Image too large. Maximum 10MB.';
         return;
       }

       const reader = new FileReader();
       reader.onload = (event) => {
         lateChangesUploadedImage = {
           base64: event.target.result.split(',')[1],
           mimeType: file.type
         };
         lateChangesImagePreviewImg.src = event.target.result;
         lateChangesImagePreview.style.display = 'block';
         settingsHint.textContent = 'Late changes image uploaded. Ready to parse.';
       };
       reader.readAsDataURL(file);
     });
   }

   if (lateChangesRemoveImageBtn) {
     lateChangesRemoveImageBtn.addEventListener('click', () => {
       lateChangesUploadedImage = null;
       lateChangesImagePreview.style.display = 'none';
       lateChangesImagePreviewImg.src = '';
       if (lateChangesImageUpload) lateChangesImageUpload.value = '';
       settingsHint.textContent = 'Late changes image removed.';
     });
   }

   locationSearchInput?.addEventListener('keydown', (event) => {
     if (event.key === 'Enter') {
       event.preventDefault();
       searchManualLocation();
     }
   });

   locationSearchInput?.addEventListener('input', () => {
     if (!locationSearchInput.value.trim()) {
       clearLocationResults();
     }
   });
 }

// ---------- Calendar Integration UI ----------
const googleCalendarChk = document.getElementById('googleCalendarChk');
const appleCalendarChk = document.getElementById('appleCalendarChk');
const notionChk = document.getElementById('notionChk');
const connectCalendarBtn = document.getElementById('connectCalendarBtn');
const calendarStatus = document.getElementById('calendarStatus');

if (googleCalendarChk && appleCalendarChk && notionChk && connectCalendarBtn && calendarStatus) {
  connectCalendarBtn.addEventListener('click', async () => {
    const selected = [];
    if (googleCalendarChk.checked) selected.push('google');
    if (appleCalendarChk.checked) selected.push('apple');
    if (notionChk.checked) selected.push('notion');
    if (selected.length === 0) {
      calendarStatus.textContent = 'Select at least one calendar service.';
      return;
    }
    calendarStatus.textContent = 'Connecting…';
    try {
      const resp = await fetch(`http://localhost:8787/calendar/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({providers: selected})
      });
      if (!resp.ok) throw new Error('Connection failed');
      calendarStatus.textContent = 'Connected! Fetching events…';
      const eventsResp = await fetch(`http://localhost:8787/calendar/events?providers=${selected.join(',')}`);
      if (eventsResp.ok) {
        const events = await eventsResp.json();
        console.log('Fetched events:', events);
        calendarStatus.textContent = `Connected and fetched ${events.length} events.`;
      } else {
        const err = await eventsResp.text();
        calendarStatus.textContent = `Failed to fetch events: ${err}`;
      }
    } catch (e) {
      calendarStatus.textContent = `Error: ${e.message}`;
      console.error(e);
    }
  });
}

// Rest of renderer.js …