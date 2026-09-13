const { app, BrowserWindow, ipcMain, session, net, Menu, webContents, safeStorage, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createAutoUpdateManager, createReportSync, createRemoteCommandReceiver } = require('./updater/auto-update-manager');

let reportSync = null;
let remoteCommandReceiver = null;

// Fix GPU process crash on Windows
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-program-cache');
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// Pin userData vao mot thu muc co dinh du chay qua electron hay ThaiAsiaApp.exe
// -> dam bao cookies/localStorage (ke ca trang thai training Live Orders) luon persist
const STARTUP_SMOKE_TEST = process.env.THAIASIA_STARTUP_SMOKE_TEST === '1';
const USER_DATA_DIR = STARTUP_SMOKE_TEST && process.env.THAIASIA_SMOKE_USER_DATA
  ? path.resolve(process.env.THAIASIA_SMOKE_USER_DATA)
  : path.join(app.getPath('appData'), 'ThaiAsiaAllinOne');
app.setPath('userData', USER_DATA_DIR);
fs.mkdirSync(app.getPath('userData'), { recursive: true });

const MAIN_LOG_PATH = path.join(app.getPath('userData'), 'main-events.log');
const DIAGNOSTICS_DIR = path.join(app.getPath('userData'), 'diagnostics');
const APP_REPORTS_DIR = path.join(app.isPackaged ? path.dirname(process.execPath) : __dirname, 'reports');
const APP_RUNTIME_DIR = app.isPackaged
  ? path.dirname(process.execPath)
  : path.join(__dirname, 'dist', 'ThaiAsiaApp-win32-x64');
const WATCHDOG_STATE_DIR = path.join(APP_RUNTIME_DIR, 'watchdog-state');
const WATCHDOG_STOP_FLAG_PATH = path.join(WATCHDOG_STATE_DIR, 'watchdog.stop');
const ROOT_PROJECT_DIR = app.isPackaged
  ? path.resolve(path.dirname(process.execPath), '..', '..')
  : __dirname;
const ROOT_REPORT_TXT_PATH = path.join(ROOT_PROJECT_DIR, 'ThaiAsia-24h-report.txt');
const ROOT_REPORT_BUNDLE_PATH = path.join(ROOT_PROJECT_DIR, 'ThaiAsia-24h-report-bundle.txt');
const APP_24H_REPORT_TXT_PATH = path.join(APP_REPORTS_DIR, 'ThaiAsia-24h-report.txt');
const APP_24H_REPORT_BUNDLE_PATH = path.join(APP_REPORTS_DIR, 'ThaiAsia-24h-report-bundle.txt');
const REPORT_WINDOW_STATE_PATH = path.join(DIAGNOSTICS_DIR, 'report-window-state.json');
const IMPORTANT_EVENTS_RETENTION_DAYS = 14;
const APP_HEARTBEAT_PATH = path.join(app.getPath('userData'), 'app.heartbeat');
const APP_RUN_STATE_PATH = path.join(app.getPath('userData'), 'app-run-state.json');
const APP_HEARTBEAT_INTERVAL_MS = 3000;
const REMOTE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
const REMOTE_OFFLINE_AFTER_MS = 7 * 60 * 1000;
const TAKEAWAY_CANARY_TOKEN_REFRESH_RETRY_MS = 30 * 1000;
const APP_BOOT_ID = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const APP_RUN_STARTED_AT = new Date().toISOString();
const MAIN_LOG_FLUSH_INTERVAL_MS = 250;
const MAIN_LOG_MAX_BUFFERED_LINES = 80;
const IMPORTANT_LOG_FLUSH_INTERVAL_MS = 500;
const REPORT_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
let mainLogBuffer = [];
let mainLogFlushTimer = null;
let mainLogFlushInFlight = false;
let importantEventBuffer = [];
let importantEventFlushTimer = null;
let importantEventFlushInFlight = false;
let appHeartbeatTimer = null;
let remoteHeartbeatTimer = null;
let remoteHeartbeatInitialTimer = null;
let remoteHeartbeatRetryTimer = null;
let previousRunIncident = null;
let reportBundleDeletionMonitorTimer = null;
let autoUpdateManager = null;
const livePushRuntimeState = new Map();
const WOLT_WEB_URL = 'https://merchant-app.wolt.com/';
const WOLT_PARTITION = 'persist:wolt';
const WOLT_ACCEPT_LANGUAGE = 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7';
const TEMP_DISABLE_AUX_OPERATIONAL_TABS = false; // false = chay tat ca: Wolt + LiveOrders + Uber + TienShip
const takeawayOrdersCanaryState = {
  installed: false,
  installedAt: 0,
  endpoint: '',
  requestHeaders: {},
  endpointCapturedAt: 0,
  inFlight: false,
  lastPollAt: 0,
  lastPollOkAt: 0,
  lastStatusCode: 0,
  lastError: '',
  lastHealthLogAt: 0,
  lastErrorLogAt: 0,
  lastAuthLogAt: 0,
  lastPolicyLogAt: 0,
  lastTokenRefreshTriggeredAt: 0,
  failureSince: 0,
  lastFailureAt: 0,
  consecutiveFailures: 0,
  pendingOrders: new Map()
};

fs.mkdirSync(DIAGNOSTICS_DIR, { recursive: true });
fs.mkdirSync(APP_REPORTS_DIR, { recursive: true });

function pad2(v) {
  return String(v).padStart(2, '0');
}

function getLocalDayKey(value = Date.now()) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getMainEventsDailyPath(dayKey) {
  return path.join(DIAGNOSTICS_DIR, `main-events-${dayKey}.log`);
}

function getImportantEventsDailyPath(dayKey) {
  return path.join(DIAGNOSTICS_DIR, `important-events-${dayKey}.ndjson`);
}

function getLast24hReportJsonPath() {
  return path.join(DIAGNOSTICS_DIR, 'last-24h-report.json');
}

function getLast24hReportTxtPath() {
  return path.join(DIAGNOSTICS_DIR, 'last-24h-report.txt');
}

function writeAppHeartbeat() {
  try {
    const remoteControl = remoteCommandReceiver && typeof remoteCommandReceiver.getStatus === 'function'
      ? remoteCommandReceiver.getStatus()
      : { running: false };
    const payload = JSON.stringify({
      pid: process.pid,
      bootId: APP_BOOT_ID,
      startedAt: APP_RUN_STARTED_AT,
      ts: Date.now(),
      iso: new Date().toISOString(),
      version: app.getVersion(),
      remoteControl
    });
    fs.writeFileSync(APP_HEARTBEAT_PATH, payload, 'utf8');
  } catch (_) {}
}

function readJsonFileSafe(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function initializeAppRunState() {
  const previousState = readJsonFileSafe(APP_RUN_STATE_PATH);
  const previousHeartbeat = readJsonFileSafe(APP_HEARTBEAT_PATH);
  if (previousState && previousState.clean !== true && previousState.bootId !== APP_BOOT_ID) {
    previousRunIncident = {
      previousBootId: String(previousState.bootId || ''),
      previousStartedAt: String(previousState.startedAt || ''),
      lastSeenAt: String(previousHeartbeat && previousHeartbeat.iso || previousState.updatedAt || ''),
      previousPid: Number(previousHeartbeat && previousHeartbeat.pid || previousState.pid || 0)
    };
  }
  try {
    fs.writeFileSync(APP_RUN_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      bootId: APP_BOOT_ID,
      pid: process.pid,
      startedAt: APP_RUN_STARTED_AT,
      clean: false,
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  } catch (_) {}
}

function buildRemoteHeartbeatPayload(state = 'online', reason = '') {
  const lastSeenAt = new Date().toISOString();
  const remoteControl = remoteCommandReceiver && typeof remoteCommandReceiver.getStatus === 'function'
    ? remoteCommandReceiver.getStatus()
    : { running: false };
  return {
    state,
    reason: String(reason || ''),
    version: app.getVersion(),
    bootId: APP_BOOT_ID,
    pid: process.pid,
    startedAt: APP_RUN_STARTED_AT,
    lastSeenAt,
    offlineAfterMs: REMOTE_OFFLINE_AFTER_MS,
    offlineAfterAt: new Date(Date.parse(lastSeenAt) + REMOTE_OFFLINE_AFTER_MS).toISOString(),
    remoteControl,
    previousUnexpectedStop: previousRunIncident
  };
}

function syncRemoteHeartbeat(state = 'online', reason = '', force = false) {
  if (!reportSync || typeof reportSync.syncHeartbeatAsync !== 'function') {
    return Promise.resolve({ skipped: true, reason: 'report_sync_not_ready' });
  }
  return reportSync.syncHeartbeatAsync(buildRemoteHeartbeatPayload(state, reason), { force })
    .catch((error) => ({ success: false, error: String(error && error.message || error) }));
}

function startRemoteHeartbeatSync() {
  if (remoteHeartbeatTimer || remoteHeartbeatInitialTimer) return;
  const sendOnline = (force = false) => {
    syncRemoteHeartbeat('online', force ? 'startup' : '', force).then((result) => {
      if (result && result.skipped && result.reason === 'in_flight' && remoteHeartbeatTimer && !remoteHeartbeatRetryTimer) {
        remoteHeartbeatRetryTimer = setTimeout(() => {
          remoteHeartbeatRetryTimer = null;
          if (remoteHeartbeatTimer) sendOnline(force);
        }, 15000);
      }
    });
  };
  remoteHeartbeatTimer = setInterval(() => sendOnline(false), REMOTE_HEARTBEAT_INTERVAL_MS);
  // Heartbeat gets first access to the shared GitHub writer. This prevents the
  // startup report upload from delaying initial online visibility by five minutes.
  sendOnline(true);
}

function stopRemoteHeartbeatSync() {
  if (remoteHeartbeatInitialTimer) {
    clearTimeout(remoteHeartbeatInitialTimer);
    remoteHeartbeatInitialTimer = null;
  }
  if (remoteHeartbeatTimer) {
    clearInterval(remoteHeartbeatTimer);
    remoteHeartbeatTimer = null;
  }
  if (remoteHeartbeatRetryTimer) {
    clearTimeout(remoteHeartbeatRetryTimer);
    remoteHeartbeatRetryTimer = null;
  }
}

async function syncShutdownHeartbeat(reason) {
  const deadline = Date.now() + 2500;
  while (true) {
    const result = await syncRemoteHeartbeat('offline', reason, true);
    if (!result || !result.skipped || result.reason !== 'in_flight' || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function markCleanShutdown(reason = 'app_quit', { syncRemote = true } = {}) {
  const at = new Date().toISOString();
  try {
    fs.writeFileSync(APP_RUN_STATE_PATH, JSON.stringify({
      schemaVersion: 1,
      bootId: APP_BOOT_ID,
      pid: process.pid,
      startedAt: APP_RUN_STARTED_AT,
      clean: true,
      reason: String(reason || 'app_quit'),
      at,
      updatedAt: at
    }, null, 2), 'utf8');
  } catch (_) {}
  return syncRemote
    ? syncShutdownHeartbeat(reason)
    : Promise.resolve({ skipped: true, reason: 'remote_sync_disabled' });
}

app.on('browser-window-created', (_, browserWindow) => {
  if (process.platform !== 'win32' || !browserWindow || browserWindow.__thaiasiaSessionEndTracked) return;
  browserWindow.__thaiasiaSessionEndTracked = true;
  const noteWindowsSessionEnd = () => {
    _plannedShutdownReason = 'windows_shutdown_restart_or_logoff';
    _userRequestedQuit = true;
    markCleanShutdown(_plannedShutdownReason).catch(() => {});
  };
  browserWindow.on('query-session-end', noteWindowsSessionEnd);
  browserWindow.on('session-end', noteWindowsSessionEnd);
});

function startAppHeartbeat() {
  if (appHeartbeatTimer) return;
  writeAppHeartbeat();
  appHeartbeatTimer = setInterval(writeAppHeartbeat, APP_HEARTBEAT_INTERVAL_MS);
}

function stopAppHeartbeat() {
  if (appHeartbeatTimer) {
    clearInterval(appHeartbeatTimer);
    appHeartbeatTimer = null;
  }
}

function appendEntriesByDaySync(entries, toLine, pathByDay) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const buckets = new Map();
  for (const item of entries) {
    const tsMs = Number(item && item.tsMs);
    const dayKey = getLocalDayKey(Number.isFinite(tsMs) ? tsMs : Date.now());
    const prev = buckets.get(dayKey) || '';
    buckets.set(dayKey, prev + toLine(item));
  }
  for (const [dayKey, chunk] of buckets.entries()) {
    try { fs.appendFileSync(pathByDay(dayKey), chunk, 'utf8'); } catch (_) {}
  }
}

function appendFileAsyncSafe(filePath, chunk) {
  return new Promise((resolve) => {
    fs.appendFile(filePath, chunk, 'utf8', () => resolve());
  });
}

function appendEntriesByDayAsync(entries, toLine, pathByDay) {
  if (!Array.isArray(entries) || entries.length === 0) return Promise.resolve();
  const buckets = new Map();
  for (const item of entries) {
    const tsMs = Number(item && item.tsMs);
    const dayKey = getLocalDayKey(Number.isFinite(tsMs) ? tsMs : Date.now());
    const prev = buckets.get(dayKey) || '';
    buckets.set(dayKey, prev + toLine(item));
  }
  const tasks = [];
  for (const [dayKey, chunk] of buckets.entries()) {
    tasks.push(appendFileAsyncSafe(pathByDay(dayKey), chunk));
  }
  return Promise.allSettled(tasks).then(() => {});
}

function flushMainLogBufferSyncFallback() {
  if (mainLogBuffer.length === 0) return;
  const entries = mainLogBuffer;
  mainLogBuffer = [];
  const chunk = entries.map((entry) => `${entry.line}\n`).join('');
  try { fs.appendFileSync(MAIN_LOG_PATH, chunk, 'utf8'); } catch (_) {}
  appendEntriesByDaySync(entries, (entry) => `${entry.line}\n`, getMainEventsDailyPath);
}

function scheduleMainLogFlush(delayMs = MAIN_LOG_FLUSH_INTERVAL_MS) {
  if (mainLogFlushTimer) return;
  mainLogFlushTimer = setTimeout(() => {
    mainLogFlushTimer = null;
    flushMainLogBufferAsync();
  }, delayMs);
}

function flushMainLogBufferAsync() {
  if (mainLogFlushInFlight) return;
  if (mainLogFlushTimer) {
    clearTimeout(mainLogFlushTimer);
    mainLogFlushTimer = null;
  }
  if (mainLogBuffer.length === 0) return;
  mainLogFlushInFlight = true;
  const entries = mainLogBuffer;
  mainLogBuffer = [];
  const chunk = entries.map((entry) => `${entry.line}\n`).join('');
  Promise.allSettled([
    appendFileAsyncSafe(MAIN_LOG_PATH, chunk),
    appendEntriesByDayAsync(entries, (entry) => `${entry.line}\n`, getMainEventsDailyPath)
  ]).finally(() => {
    mainLogFlushInFlight = false;
    if (mainLogBuffer.length > 0) scheduleMainLogFlush(0);
  });
}

function normalizeLogArg(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function clipForReport(value, maxLen = 280) {
  const s = String(value || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...<trimmed>`;
}

function parseImportantEvent(iso, messageText) {
  const text = String(messageText || '');
  const lower = text.toLowerCase();
  const rendererMatch = text.match(/\[Renderer:([^\]]+)\]/);
  const source = rendererMatch ? `renderer:${rendererMatch[1]}` : 'main';
  const diagPrefix = '[thaiasiadiag]';
  const diagPos = lower.indexOf(diagPrefix);
  if (diagPos >= 0) {
    const afterPrefix = text.slice(diagPos + diagPrefix.length).trim();
    const jsonMatch = afterPrefix.match(/^\{.*\}/);
    if (jsonMatch) {
      try {
        const payload = JSON.parse(jsonMatch[0]);
        const eventType = String(payload.eventType || '');
        if (eventType === 'reload') {
          return {
            ts: iso,
            tsMs: Date.parse(iso),
            severity: 'warn',
            category: 'diag_reload',
            source,
            module: String(payload.module || ''),
            page: String(payload.page || ''),
            reason: String(payload.reason || payload.action || ''),
            action: String(payload.action || ''),
            message: clipForReport(text),
            meta: payload
          };
        }
        if (eventType === 'order_activity') {
          return {
            ts: iso,
            tsMs: Date.parse(iso),
            severity: 'info',
            category: 'diag_order_activity',
            source,
            module: String(payload.module || ''),
            page: String(payload.page || ''),
            reason: String(payload.reason || ''),
            action: String(payload.action || ''),
            orderCode: String(payload.orderCode || ''),
            message: clipForReport(text),
            meta: payload
          };
        }
        if (eventType === 'wolt_manual_action' || eventType === 'manual_action') {
          return {
            ts: iso,
            tsMs: Date.parse(iso),
            severity: 'info',
            category: 'diag_wolt_manual_action',
            source,
            module: String(payload.module || 'wolt'),
            page: String(payload.page || 'woltWin'),
            reason: String(payload.reason || ''),
            action: String(payload.action || 'manual_click'),
            orderCode: String(
              (payload.context && payload.context.activeOrderNumber)
              || (payload.before && payload.before.bridge && payload.before.bridge.activeOrderNumber)
              || (payload.context && payload.context.nearestOrderNumber)
              || payload.orderCode
              || ''
            ),
            message: clipForReport(text, 1200),
            meta: payload
          };
        }
        if (eventType === 'live_push') {
          const action = String(payload.action || '');
          const noisy = action === 'ws_close' || action === 'ws_error' || action === 'es_error' || action.endsWith('_patch_failed');
          return {
            ts: iso,
            tsMs: Date.parse(iso),
            severity: noisy ? 'warn' : 'info',
            category: 'diag_live_push',
            source,
            module: String(payload.module || ''),
            page: String(payload.page || ''),
            reason: String(payload.reason || ''),
            action,
            message: clipForReport(text),
            meta: payload
          };
        }
      } catch (_) {}
    }
  }
  let category = null;
  let severity = 'warn';
  if (lower.includes('uncaughtexception')) {
    category = 'uncaught_exception';
    severity = 'error';
  } else if (lower.includes('unhandledrejection')) {
    category = 'unhandled_rejection';
    severity = 'error';
  } else if (lower.includes('render-process-gone')) {
    category = 'render_process_gone';
    severity = 'error';
  } else if (lower.includes('child-process-gone')) {
    category = 'child_process_gone';
    severity = 'error';
  } else if (lower.includes('did-fail-load')) {
    category = 'did_fail_load';
    severity = 'warn';
  } else if (lower.includes('window became unresponsive')) {
    category = 'window_unresponsive';
    severity = 'error';
  } else if (lower.includes('[operationalwindow] missing')) {
    category = 'operational_window_missing';
    severity = 'error';
  } else if (lower.includes('[operationalwindow] destroyed')) {
    category = 'operational_window_destroyed';
    severity = 'error';
  } else if (lower.includes('[operationalwindow] close blocked')) {
    category = 'operational_window_close_blocked';
    severity = 'info';
  } else if (lower.includes('[report] report window reset')) {
    category = 'report_window_reset';
    severity = 'info';
  } else if (lower.includes('relaunch requested')) {
    category = 'relaunch_requested';
    severity = 'warn';
  } else if (lower.includes('[lifecycle] previous run ended unexpectedly')) {
    category = 'unexpected_previous_stop';
    severity = 'error';
  } else if (lower.includes('certificate-error blocked')) {
    category = 'tls_certificate_blocked';
    severity = 'warn';
  } else if (lower.includes('reload_stale_or_age')) {
    category = 'stale_reload';
    severity = 'warn';
  } else if (lower.includes('reload_cross_tab')) {
    category = 'cross_tab_reload';
    severity = 'warn';
  } else if (lower.includes('[reload]') || lower.includes('reload()') || lower.includes('reloadignoringcache') || lower.includes('f5 -> reload')) {
    category = 'window_reload';
    severity = 'warn';
  } else if (lower.includes('[lifecycle] app ready')) {
    category = 'app_ready';
    severity = 'info';
  } else if (lower.includes('[renderer:') && lower.includes('[error]')) {
    if (lower.includes('fakestoreapi.com')) {
      category = 'renderer_tech_info';
      severity = 'info';
    } else {
      category = 'renderer_error';
      severity = 'error';
    }
  } else if (lower.includes('[renderer:') && lower.includes('[warn]')) {
    if (lower.includes('fakestoreapi.com')) {
      category = 'renderer_tech_info';
      severity = 'info';
    } else {
      category = 'renderer_warn';
      severity = 'warn';
    }
  } else {
    return null;
  }
  const event = {
    ts: iso,
    tsMs: Date.parse(iso),
    severity,
    category,
    source,
    message: clipForReport(text)
  };
  return category === 'window_reload' ? inferReloadEventDetails(event) : event;
}

function scheduleImportantEventFlush(delayMs = IMPORTANT_LOG_FLUSH_INTERVAL_MS) {
  if (importantEventFlushTimer) return;
  importantEventFlushTimer = setTimeout(() => {
    importantEventFlushTimer = null;
    flushImportantEventBufferAsync();
  }, delayMs);
}

function flushImportantEventBufferSyncFallback() {
  if (importantEventBuffer.length === 0) return;
  const events = importantEventBuffer;
  importantEventBuffer = [];
  appendEntriesByDaySync(events, (evt) => `${JSON.stringify(evt)}\n`, getImportantEventsDailyPath);
}

function flushImportantEventBufferAsync() {
  if (importantEventFlushInFlight) return;
  if (importantEventFlushTimer) {
    clearTimeout(importantEventFlushTimer);
    importantEventFlushTimer = null;
  }
  if (importantEventBuffer.length === 0) return;
  importantEventFlushInFlight = true;
  const events = importantEventBuffer;
  importantEventBuffer = [];
  appendEntriesByDayAsync(events, (evt) => `${JSON.stringify(evt)}\n`, getImportantEventsDailyPath)
    .finally(() => {
      importantEventFlushInFlight = false;
      if (importantEventBuffer.length > 0) scheduleImportantEventFlush(0);
    });
}

let realtimeSyncTimer = null;
function scheduleRealtimeReportSync(delayMs = 3000) {
  if (realtimeSyncTimer) return;
  realtimeSyncTimer = setTimeout(() => {
    realtimeSyncTimer = null;
    flushImportantEventBufferSyncFallback();
    write24hSummaryReport();
  }, delayMs);
}

function trackImportantEvent(iso, messageText) {
  const evt = parseImportantEvent(iso, messageText);
  if (!evt) return;
  if (!Number.isFinite(evt.tsMs)) evt.tsMs = Date.now();
  if (evt.category === 'diag_live_push') noteLivePushRuntimeEvent(evt);
  if (evt.category === 'diag_order_activity') noteOrderRuntimeEvent(evt);
  if (evt.action === 'tienship_report_sent') {
    try {
      executeSafeShutdownSequence(evt.meta || {});
    } catch (e) {
      logMain('[AutoShutdown] Error executing shutdown from diag event:', e);
    }
  }
  if (evt.page === 'fertigWin' || evt.module === 'autofertig') {
    if (evt.action === 'autofertig_orders_status' || evt.action === 'qualifying_count_changed') {
      if (typeof (evt.meta && evt.meta.remainingCount) === 'number') {
        _autofertigRemainingOrders = evt.meta.remainingCount;
      }
      if (_autofertigHoldsShutdownKey && _autofertigRemainingOrders === 0 && !(evt.meta && evt.meta.isProcessing)) {
        logMain('[AutoShutdown] Autofertig đã xử lý xong đơn cuối cùng (0 đơn). Kích hoạt tắt máy theo chìa khóa đã bàn giao.');
        const savedOpts = _pendingAutofertigShutdownOptions || {};
        _autofertigHoldsShutdownKey = false;
        _pendingAutofertigShutdownOptions = null;
        executeSafeShutdownSequence({ ...savedOpts, force: true, triggeredBy: 'autofertig_drain' });
      }
    }
  }
  importantEventBuffer.push(evt);
  scheduleImportantEventFlush();

  const isSignificant = evt.category === 'diag_order_activity' ||
                        evt.category === 'diag_wolt_manual_action' ||
                        evt.category === 'diag_reload' ||
                        evt.category === 'window_reload' ||
                        evt.category === 'stale_reload' ||
                        evt.category === 'cross_tab_reload' ||
                        evt.category === 'unexpected_previous_stop' ||
                        evt.category === 'renderer_error' ||
                        evt.category === 'uncaught_exception' ||
                        (evt.action && (
                          evt.action.includes('fertig') ||
                          evt.action.includes('tienship') ||
                          evt.action.includes('submit') ||
                          evt.action.includes('fill') ||
                          evt.action.includes('received')
                        ));
  if (isSignificant) {
    scheduleRealtimeReportSync(3000);
  }
}

function noteLivePushRuntimeEvent(evt) {
  try {
    noteTakeawayRuntimePayload(evt.meta || {}, evt.tsMs || Date.now());
  } catch (_) {}
}

function noteTakeawayRuntimePayload(payload, receivedAt = Date.now()) {
  try {
    const page = String(payload.page || 'liveOrderWin');
    const action = String(payload.action || '');
    const prev = livePushRuntimeState.get(page) || {};
    const next = {
      ...prev,
      page,
      lastEventAt: receivedAt,
      lastAction: action,
      lastLiveSignalAgeMs: payload.lastLiveSignalAgeMs == null ? prev.lastLiveSignalAgeMs : Number(payload.lastLiveSignalAgeMs),
      wsOpenCount: payload.wsOpenCount == null ? prev.wsOpenCount : Number(payload.wsOpenCount),
      wsCloseCount: payload.wsCloseCount == null ? prev.wsCloseCount : Number(payload.wsCloseCount),
      wsErrorCount: payload.wsErrorCount == null ? prev.wsErrorCount : Number(payload.wsErrorCount),
      wsMessageCount: payload.wsMessageCount == null ? prev.wsMessageCount : Number(payload.wsMessageCount),
      esMessageCount: payload.esMessageCount == null ? prev.esMessageCount : Number(payload.esMessageCount)
    };

    if (action === 'probe_installed') {
      next.probeInstalledAt = receivedAt;
      next.rendererHeartbeatAt = 0;
      next.orderSocket = null;
      next.mqttSocket = null;
      next.orderSocketOpenedAt = 0;
      next.orderSocketDisconnectedAt = 0;
      next.orderSocketLastMessageAt = 0;
      next.processing = false;
      next.businessEvents = [];
      next.strongEvidenceAt = 0;
      next.strongEvidenceReason = '';
      next.strongEvidenceOrderCode = '';
    }
    if (action === 'renderer_heartbeat') {
      next.rendererHeartbeatAt = receivedAt;
      next.processing = !!payload.processing;
      next.documentReadyState = String(payload.documentReadyState || '');
      next.acceptButtonCount = Number(payload.acceptButtonCount || 0);
      next.pageUrl = String(payload.pageUrl || '');
      next.pageOperational = payload.pageOperational === true;
      next.orderSocket = payload.orderSocket || prev.orderSocket || null;
      next.mqttSocket = payload.mqttSocket || prev.mqttSocket || null;
    }
    if (action === 'order_activity_seen') {
      next.processing = !!payload.processing;
      next.lastOrderActivityAt = receivedAt;
      next.lastOrderActivityAction = String(payload.orderAction || '');
      next.lastOrderCode = String(payload.orderCode || prev.lastOrderCode || '');
      if (/send_result|accept_|cycle_done|resume_accept|fertig_clicked/i.test(next.lastOrderActivityAction)) {
        next.lastConfirmedOrderActivityAt = receivedAt;
      }
    }
    if (action === 'order_business_message') {
      const eventName = String(payload.eventName || '').slice(0, 100);
      const parsedTs = Date.parse(String(payload.ts || ''));
      const eventAt = Number.isFinite(parsedTs) ? parsedTs : receivedAt;
      const history = Array.isArray(prev.businessEvents) ? prev.businessEvents.slice() : [];
      const duplicate = history.some((item) => item
        && item.eventName === eventName
        && Number(item.at || 0) === eventAt);
      if (eventName && !duplicate) history.push({ eventName, at: eventAt });
      next.businessEvents = history
        .filter((item) => item && eventAt - Number(item.at || 0) <= 2 * 60 * 1000)
        .slice(-40);
      next.lastBusinessEventAt = eventAt;
      next.lastBusinessEventName = eventName;
    }
    if (payload.socketKind === 'orders_socket') {
      if (action === 'ws_open') {
        next.orderSocketOpenedAt = receivedAt;
        next.orderSocketDisconnectedAt = 0;
        next.orderSocket = {
          ...(prev.orderSocket || {}),
          present: true,
          open: true,
          readyState: 1,
          openedAgeMs: 0,
          lastMessageAgeMs: null,
          disconnectedAgeMs: null,
          url: String(payload.url || '')
        };
      } else if (action === 'ws_close' || action === 'ws_error') {
        next.orderSocketDisconnectedAt = receivedAt;
        next.orderSocket = {
          ...(prev.orderSocket || {}),
          present: true,
          open: false,
          readyState: action === 'ws_close' ? 3 : (prev.orderSocket && prev.orderSocket.readyState),
          disconnectedAgeMs: 0,
          url: String(payload.url || (prev.orderSocket && prev.orderSocket.url) || '')
        };
      } else if (action === 'ws_message') {
        next.orderSocketLastMessageAt = receivedAt;
        next.orderSocket = {
          ...(prev.orderSocket || {}),
          present: true,
          open: true,
          readyState: 1,
          lastMessageAgeMs: 0,
          url: String(payload.url || (prev.orderSocket && prev.orderSocket.url) || '')
        };
      }
    }
    if (action === 'push_dom_timeout'
        || action === 'push_dom_timeout_anonymous'
        || action === 'server_dom_mismatch') {
      const parsedTs = Date.parse(String(payload.ts || ''));
      next.strongEvidenceAt = Number.isFinite(parsedTs) ? parsedTs : receivedAt;
      next.strongEvidenceReason = action;
      next.strongEvidenceOrderCode = String(payload.orderCode || '');
    }
    if (action === 'ws_open' || action === 'ws_message' || action === 'es_open' || action === 'es_message') {
      next.lastHealthyAt = receivedAt;
    }
    livePushRuntimeState.set(page, next);
  } catch (_) {}
}

function noteOrderRuntimeEvent(evt) {
  try {
    const page = String(evt.page || '');
    if (page !== 'liveOrderWin' && page !== 'fertigWin') return;
    const prev = livePushRuntimeState.get(page) || { page };
    const action = String(evt.action || '');
    const startActions = new Set(['cycle_start', 'fertig_cycle_start', 'resume_after_send_clicked']);
    const finishActions = new Set([
      'cycle_done',
      'fertig_clicked',
      'fertig_not_clicked',
      'cycle_blocked_missing_send_button',
      'send_timeout_no_signal'
    ]);
    const next = {
      ...prev,
      lastOrderActivityAt: evt.tsMs || Date.now(),
      lastOrderActivityAction: action,
      lastOrderCode: String(evt.orderCode || prev.lastOrderCode || '')
    };
    if (/send_result|accept_|cycle_done|resume_accept|fertig_clicked/i.test(action)) {
      next.lastConfirmedOrderActivityAt = evt.tsMs || Date.now();
    }
    if (startActions.has(action)) next.processing = true;
    if (finishActions.has(action)) next.processing = false;
    livePushRuntimeState.set(page, next);
  } catch (_) {}
}

function isTakeawayOrdersApiUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.protocol === 'https:'
      && url.hostname === 'live-orders-api.takeaway.com'
      && url.pathname.replace(/\/+$/, '') === '/api/orders';
  } catch (_) {
    return false;
  }
}

function normalizeTakeawayOrderCode(value) {
  const code = String(value == null ? '' : value).trim().replace(/^#/, '').toUpperCase();
  return /^[A-Z0-9]{5,10}$/.test(code) ? code : '';
}

function collectTakeawayPendingOrders(payload) {
  const found = new Map();
  const seen = new Set();
  let visited = 0;

  function statusText(value, depth = 0) {
    if (depth > 2 || value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    }
    if (Array.isArray(value)) return value.map((item) => statusText(item, depth + 1)).filter(Boolean).join(' ');
    if (typeof value === 'object') {
      return Object.values(value).map((item) => statusText(item, depth + 1)).filter(Boolean).join(' ');
    }
    return '';
  }

  function walk(node, depth) {
    if (depth > 8 || visited > 1200 || node == null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    visited += 1;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }

    const localCodes = [];
    const localStatuses = [];
    for (const [rawKey, rawValue] of Object.entries(node)) {
      const key = String(rawKey || '').toLowerCase();
      const codeKey = [
        'ordercode', 'shortcode', 'shortid', 'displaycode', 'displayid',
        'friendlyid', 'ordernumber', 'orderreference', 'shortreference',
        'friendlyorderreference'
      ].includes(key)
        || (/order/.test(key) && /(code|number|displayid|friendlyid|reference|shortid)$/.test(key));
      if (codeKey) {
        const code = normalizeTakeawayOrderCode(rawValue);
        if (code) localCodes.push(code);
      }
      if (['status', 'state', 'orderstatus'].includes(key)) {
        const text = statusText(rawValue);
        if (text) localStatuses.push(text);
      }
      if (/(pending|unaccepted|new|incoming)/.test(key) && rawValue === true) {
        localStatuses.push(key);
      }
      if (/(accepted|confirmed)/.test(key) && rawValue === false) {
        localStatuses.push(`not_${key}`);
      }
    }

    const status = localStatuses.join(' ').replace(/[_-]+/g, ' ');
    const pending = /\b(new|pending|placed|received|incoming|unaccepted|awaiting|created|unconfirmed|open)\b/i.test(status)
      || /\bnot\s+(accepted|confirmed)\b/i.test(status);
    const terminal = /\b(accepted|confirmed|preparing|preparation|ready|completed|delivered|cancelled|canceled|rejected|closed)\b/i.test(status);
    const actionable = pending || (status.length > 0 && !terminal);
    if (localCodes.length && actionable) {
      for (const code of localCodes) found.set(code, status.slice(0, 160));
    }

    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  }

  walk(payload, 0);
  return Array.from(found.entries()).map(([code, status]) => ({ code, status }));
}

function sanitizeTakeawayCanaryHeaders(headers) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName || '');
    if (!name || /^(host|content-length|cookie|connection|transfer-encoding)$/i.test(name)) continue;
    if (/^sec-/i.test(name)) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue == null ? '' : rawValue);
    if (value) out[name] = value;
  }
  return out;
}

function markTakeawayCanaryFailure(error, observedAt = Date.now()) {
  const nowTs = Number(observedAt || Date.now());
  if (!takeawayOrdersCanaryState.failureSince) {
    takeawayOrdersCanaryState.failureSince = nowTs;
  }
  takeawayOrdersCanaryState.lastFailureAt = nowTs;
  takeawayOrdersCanaryState.consecutiveFailures =
    Number(takeawayOrdersCanaryState.consecutiveFailures || 0) + 1;
  takeawayOrdersCanaryState.lastError = String(error || 'UNKNOWN');
}

function markTakeawayCanarySuccess(observedAt = Date.now()) {
  takeawayOrdersCanaryState.lastPollOkAt = Number(observedAt || Date.now());
  takeawayOrdersCanaryState.lastError = '';
  takeawayOrdersCanaryState.failureSince = 0;
  takeawayOrdersCanaryState.lastFailureAt = 0;
  takeawayOrdersCanaryState.consecutiveFailures = 0;
}

function updateTakeawayCanaryPendingOrders(rows, observedAt) {
  const previous = takeawayOrdersCanaryState.pendingOrders;
  const next = new Map();
  for (const row of rows) {
    const code = normalizeTakeawayOrderCode(row && row.code);
    if (!code) continue;
    const prev = previous.get(code) || {};
    next.set(code, {
      ...prev,
      code,
      status: String(row.status || ''),
      firstSeenAt: Number(prev.firstSeenAt || observedAt),
      lastSeenAt: observedAt,
      recoveryStage: Number(prev.recoveryStage || 0),
      recoveryAt: Number(prev.recoveryAt || 0),
      cooldownUntil: Number(prev.cooldownUntil || 0),
      domSeenAt: Number(prev.domSeenAt || 0),
      acknowledgedAt: Number(prev.acknowledgedAt || 0)
    });
  }
  takeawayOrdersCanaryState.pendingOrders = next;
}

function triggerTakeawayTokenRefresh() {
  try {
    if (typeof BrowserWindow !== 'undefined' && typeof BrowserWindow.getAllWindows === 'function') {
      const allWins = BrowserWindow.getAllWindows();
      for (const w of allWins) {
        if (!w || w.isDestroyed()) continue;
        const wc = w.webContents;
        if (!wc || wc.isDestroyed()) continue;
        const url = String(wc.getURL() || '');
        if (url.includes('live-orders.takeaway.com')) {
          wc.executeJavaScript(`
            (function() {
              try {
                fetch('https://live-orders-api.takeaway.com/api/orders', {
                  method: 'GET',
                  headers: { 'Accept': 'application/json' },
                  credentials: 'include'
                }).catch(function() {});
              } catch(_) {}
            })();
          `, true).catch(() => {});
        }
      }
    }
  } catch (_) {}
}

function installTakeawayOrdersCanary(partition, emitDiag) {
  if (takeawayOrdersCanaryState.installed) return;
  const ses = session.fromPartition(partition);
  if (!ses || !ses.webRequest) return;
  takeawayOrdersCanaryState.installed = true;
  takeawayOrdersCanaryState.installedAt = Date.now();

  ses.webRequest.onBeforeSendHeaders(
    { urls: ['https://live-orders-api.takeaway.com/api/orders*'] },
    (details, callback) => {
      try {
        if (String(details.method || 'GET').toUpperCase() === 'GET'
            && isTakeawayOrdersApiUrl(details.url)
            && Number(details.webContentsId) >= 0) {
          const firstCapture = !takeawayOrdersCanaryState.endpoint;
          const wasFailing = Number(takeawayOrdersCanaryState.failureSince || 0) > 0;
          takeawayOrdersCanaryState.endpoint = details.url;
          takeawayOrdersCanaryState.requestHeaders = sanitizeTakeawayCanaryHeaders(details.requestHeaders);
          takeawayOrdersCanaryState.endpointCapturedAt = Date.now();
          if (firstCapture) {
            emitDiag('live_push', {
              page: 'liveOrderWin',
              action: 'orders_canary_endpoint_captured',
              sourceUrl: 'https://live-orders-api.takeaway.com/api/orders',
              pollIntervalMs: 5000
            });
          } else if (wasFailing) {
            emitDiag('live_push', {
              page: 'liveOrderWin',
              action: 'orders_canary_headers_refreshed',
              sourceUrl: details.url,
              previousError: String(takeawayOrdersCanaryState.lastError || '')
            });
            setTimeout(() => { try { poll(); } catch (_) {} }, 100);
          }
        }
      } catch (_) {}
      callback({ requestHeaders: details.requestHeaders || {} });
    }
  );

  setTimeout(() => {
    if (takeawayOrdersCanaryState.endpoint) return;
    emitDiag('live_push', {
      page: 'liveOrderWin',
      action: 'orders_canary_endpoint_not_seen',
      expectedUrl: 'https://live-orders-api.takeaway.com/api/orders'
    });
  }, 30 * 1000);

  const poll = () => {
    if (takeawayOrdersCanaryState.inFlight || !takeawayOrdersCanaryState.endpoint) return;
    takeawayOrdersCanaryState.inFlight = true;
    takeawayOrdersCanaryState.lastPollAt = Date.now();

    let request = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      takeawayOrdersCanaryState.inFlight = false;
    };

    try {
      request = net.request({
        method: 'GET',
        url: takeawayOrdersCanaryState.endpoint,
        session: ses,
        credentials: 'include'
      });
      for (const [name, value] of Object.entries(takeawayOrdersCanaryState.requestHeaders)) {
        try { request.setHeader(name, value); } catch (_) {}
      }
      try { request.setHeader('Cache-Control', 'no-cache'); } catch (_) {}

      request.on('redirect', () => {
        try { request.followRedirect(); } catch (_) {}
      });
      request.on('response', (response) => {
        const chunks = [];
        let bytes = 0;
        const statusCode = Number(response.statusCode || 0);
        takeawayOrdersCanaryState.lastStatusCode = statusCode;
        response.on('data', (chunk) => {
          if (bytes > 5 * 1024 * 1024) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes <= 5 * 1024 * 1024) chunks.push(buffer);
        });
        response.on('end', () => {
          finish();
          const nowTs = Date.now();
          if (statusCode === 401 || statusCode === 403) {
            markTakeawayCanaryFailure(`HTTP_${statusCode}`, nowTs);
            const now = Date.now();
            if (now - Number(takeawayOrdersCanaryState.lastTokenRefreshTriggeredAt || 0) >= TAKEAWAY_CANARY_TOKEN_REFRESH_RETRY_MS) {
              takeawayOrdersCanaryState.lastTokenRefreshTriggeredAt = now;
              emitDiag('live_push', {
                page: 'liveOrderWin',
                action: 'orders_canary_auth_refresh_triggered',
                statusCode,
                consecutiveFailures: takeawayOrdersCanaryState.consecutiveFailures
              });
              if (typeof triggerTakeawayTokenRefresh === 'function') {
                try { triggerTakeawayTokenRefresh(); } catch (_) {}
              }
            }
            if (nowTs - takeawayOrdersCanaryState.lastAuthLogAt >= 5 * 60 * 1000) {
              takeawayOrdersCanaryState.lastAuthLogAt = nowTs;
              emitDiag('live_push', {
                page: 'liveOrderWin',
                action: 'orders_canary_auth_failed',
                statusCode
              });
            }
            return;
          }
          if (statusCode < 200 || statusCode >= 300 || bytes > 5 * 1024 * 1024) {
            markTakeawayCanaryFailure(bytes > 5 * 1024 * 1024
              ? 'RESPONSE_TOO_LARGE'
              : `HTTP_${statusCode}`, nowTs);
            return;
          }

          let payload = null;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
          if (!payload) {
            markTakeawayCanaryFailure('INVALID_JSON', nowTs);
            return;
          }

          const previousCodes = Array.from(takeawayOrdersCanaryState.pendingOrders.keys()).sort().join(',');
          const pendingRows = collectTakeawayPendingOrders(payload);
          updateTakeawayCanaryPendingOrders(pendingRows, nowTs);
          const currentCodes = Array.from(takeawayOrdersCanaryState.pendingOrders.keys()).sort().join(',');
          const recoveredError = String(takeawayOrdersCanaryState.lastError || '');
          const recoveredFailureSince = Number(takeawayOrdersCanaryState.failureSince || 0);
          markTakeawayCanarySuccess(nowTs);

          if (recoveredFailureSince > 0) {
            emitDiag('live_push', {
              page: 'liveOrderWin',
              action: 'orders_canary_recovered',
              previousError: recoveredError,
              failureDurationMs: Math.max(0, nowTs - recoveredFailureSince),
              statusCode,
              pendingCount: pendingRows.length,
              orderCodes: pendingRows.map((row) => row.code).slice(0, 12),
              statuses: pendingRows.map((row) => row.status).filter(Boolean).slice(0, 12)
            });
          } else if (currentCodes !== previousCodes) {
            emitDiag('live_push', {
              page: 'liveOrderWin',
              action: 'orders_canary_snapshot',
              pendingCount: pendingRows.length,
              orderCodes: pendingRows.map((row) => row.code).slice(0, 12),
              statuses: pendingRows.map((row) => row.status).filter(Boolean).slice(0, 12)
            });
          } else if (nowTs - takeawayOrdersCanaryState.lastHealthLogAt >= 5 * 60 * 1000) {
            takeawayOrdersCanaryState.lastHealthLogAt = nowTs;
            emitDiag('live_push', {
              page: 'liveOrderWin',
              action: 'orders_canary_health',
              statusCode,
              pendingCount: pendingRows.length
            });
          }
        });
        response.on('error', (err) => {
          finish();
          markTakeawayCanaryFailure(
            String((err && err.message) || err || 'response_error'),
            Date.now()
          );
        });
      });
      request.on('error', (err) => {
        finish();
        const nowTs = Date.now();
        markTakeawayCanaryFailure(
          String((err && err.message) || err || 'request_error'),
          nowTs
        );
        if (nowTs - takeawayOrdersCanaryState.lastErrorLogAt >= 5 * 60 * 1000) {
          takeawayOrdersCanaryState.lastErrorLogAt = nowTs;
          emitDiag('live_push', {
            page: 'liveOrderWin',
            action: 'orders_canary_request_failed',
            error: takeawayOrdersCanaryState.lastError.slice(0, 180)
          });
        }
      });
      request.end();
      setTimeout(() => {
        if (finished) return;
        try { request.abort(); } catch (_) {}
        finish();
        markTakeawayCanaryFailure('TIMEOUT', Date.now());
      }, 4500);
    } catch (err) {
      finish();
      markTakeawayCanaryFailure(
        String((err && err.message) || err || 'request_setup_error'),
        Date.now()
      );
    }
  };

  setInterval(poll, 5000);
}

function listDayKeysSince(cutoffMs, endMs) {
  const keys = [];
  const start = new Date(cutoffMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endMs);
  end.setHours(0, 0, 0, 0);
  for (let ts = start.getTime(); ts <= end.getTime(); ts += 24 * 60 * 60 * 1000) {
    keys.push(getLocalDayKey(ts));
  }
  return keys;
}

function loadImportantEventsSince(cutoffMs, endMs) {
  const rows = [];
  const dayKeys = listDayKeysSince(cutoffMs, endMs);
  for (const dayKey of dayKeys) {
    const p = getImportantEventsDailyPath(dayKey);
    if (!fs.existsSync(p)) continue;
    let raw = '';
    try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let obj = null;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      const tsMs = Number(obj && obj.tsMs);
      const normalizedTs = Number.isFinite(tsMs) ? tsMs : Date.parse(obj && obj.ts);
      if (!Number.isFinite(normalizedTs)) continue;
      if (normalizedTs < cutoffMs || normalizedTs > endMs) continue;
      rows.push({ ...obj, tsMs: normalizedTs });
    }
  }
  rows.sort((a, b) => a.tsMs - b.tsMs);
  return rows;
}

function cleanupOldDiagnosticFiles() {
  const cutoff = Date.now() - (IMPORTANT_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let names = [];
  try { names = fs.readdirSync(DIAGNOSTICS_DIR); } catch (_) { return; }
  for (const name of names) {
    if (!/^(main-events|important-events)-\d{4}-\d{2}-\d{2}\./.test(name)) continue;
    const m = name.match(/-(\d{4}-\d{2}-\d{2})\./);
    if (!m) continue;
    const dayTs = Date.parse(`${m[1]}T00:00:00`);
    if (!Number.isFinite(dayTs) || dayTs >= cutoff) continue;
    try { fs.unlinkSync(path.join(DIAGNOSTICS_DIR, name)); } catch (_) {}
  }
}

function summarizeNumberSeries(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const sum = nums.reduce((acc, n) => acc + n, 0);
  const pick = (p) => nums[Math.min(nums.length - 1, Math.max(0, Math.ceil((p / 100) * nums.length) - 1))];
  return {
    count: nums.length,
    min: nums[0],
    avg: Math.round(sum / nums.length),
    p95: Math.round(pick(95)),
    max: nums[nums.length - 1]
  };
}

function build24hSummary(events, generatedAtIso) {
  const byCategory = {};
  const severityCounts = { error: 0, warn: 0, info: 0 };
  for (const evt of events) {
    const msg = String(evt.message || '').toLowerCase();
    const isIgnoredTechInfo = msg.includes('fakestoreapi.com');
    let cat = String(evt.category || 'unknown');
    let sev = String(evt.severity || 'warn');
    if (isIgnoredTechInfo && (sev === 'error' || sev === 'warn')) {
      sev = 'info';
      cat = 'renderer_tech_info';
    }
    if (!byCategory[cat]) byCategory[cat] = 0;
    byCategory[cat] += 1;
    if (severityCounts[sev] == null) severityCounts[sev] = 0;
    severityCounts[sev] += 1;
  }
  const categoryTop = Object.entries(byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));
  const suggestions = [];
  const staleReloadCount = (byCategory.stale_reload || 0) + (byCategory.cross_tab_reload || 0) + (byCategory.diag_reload || 0);
  if (staleReloadCount >= 5) suggestions.push('Stale/cross-tab reload cao: can xem nguong stale, dieu kien mutation, va thoi diem reload de tranh gian doan don.');
  if ((byCategory.render_process_gone || 0) > 0 || (byCategory.child_process_gone || 0) > 0) {
    suggestions.push('Co su kien process-gone: nen xem lai tai nguyen may, GPU va cac reload lien tiep.');
  }
  if ((byCategory.did_fail_load || 0) > 0) {
    suggestions.push('Co did-fail-load: nen kiem tra on dinh mang/DNS/proxy va retry policy.');
  }
  if ((byCategory.app_ready || 0) >= 4) {
    suggestions.push('App ready lap lai nhieu lan/24h: co dau hieu relaunch/restart nhieu, can dieu tra nguyen nhan goc.');
  }
  const reloadTimeline = dedupeReloadEvents(events
    .filter((evt) => evt.category === 'diag_reload' || evt.category === 'window_reload' || evt.category === 'stale_reload' || evt.category === 'cross_tab_reload'))
    .slice(-80)
    .map((evt) => ({
      ts: evt.ts,
      category: evt.category,
      module: evt.module || '',
      page: evt.page || '',
      reason: evt.reason || '',
      action: evt.action || '',
      message: clipForReport(evt.message, 220)
    }));
  const orderEvents = events.filter((evt) => evt.category === 'diag_order_activity');
  const orderTimeline = orderEvents
    .slice(-120)
    .map((evt) => ({
      ts: evt.ts,
      module: evt.module || '',
      page: evt.page || '',
      action: evt.action || '',
      orderCode: evt.orderCode || '',
      details: evt.meta || null
    }));
  const uberCaptureDone = orderEvents.filter((evt) => evt.module === 'ubereats' && evt.action === 'uber_capture_done');
  const uberDelayStats = {
    queueWaitMs: summarizeNumberSeries(uberCaptureDone.map((evt) => evt.meta && evt.meta.queueWaitMs)),
    captureDurationMs: summarizeNumberSeries(uberCaptureDone.map((evt) => evt.meta && evt.meta.durationMs)),
    detectToDoneMs: summarizeNumberSeries(uberCaptureDone.map((evt) => evt.meta && evt.meta.detectToDoneMs))
  };
  const allinoneCycleDone = orderEvents.filter((evt) => evt.module === 'allinone' && evt.action === 'cycle_done');
  const allinoneCycleStats = {
    totalDurationMs: summarizeNumberSeries(allinoneCycleDone.map((evt) => evt.meta && evt.meta.durationMs)),
    sendPhaseMs: summarizeNumberSeries(allinoneCycleDone.map((evt) => evt.meta && evt.meta.sendPhaseMs)),
    acceptPhaseMs: summarizeNumberSeries(allinoneCycleDone.map((evt) => evt.meta && evt.meta.acceptPhaseMs)),
    settlePhaseMs: summarizeNumberSeries(allinoneCycleDone.map((evt) => evt.meta && evt.meta.settlePhaseMs))
  };
  const livePushEvents = events.filter((evt) => evt.category === 'diag_live_push');
  const livePushActionCounts = {};
  for (const evt of livePushEvents) {
    const action = String(evt.action || 'unknown');
    if (!livePushActionCounts[action]) livePushActionCounts[action] = 0;
    livePushActionCounts[action] += 1;
  }
  const livePushHealth = livePushEvents.filter((evt) => evt.action === 'health');
  const latestLivePushHealth = livePushHealth.length ? livePushHealth[livePushHealth.length - 1].meta : null;
  const livePushStats = {
    actionCounts: Object.entries(livePushActionCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([action, count]) => ({ action, count })),
    lastLiveSignalAgeMs: summarizeNumberSeries(livePushHealth.map((evt) => evt.meta && evt.meta.lastLiveSignalAgeMs)),
    latestHealth: latestLivePushHealth,
    timeline: livePushEvents.slice(-80).map((evt) => ({
      ts: evt.ts,
      action: evt.action || '',
      page: evt.page || '',
      message: clipForReport(evt.message, 220),
      details: evt.meta || null
    }))
  };
  const recent = events.slice(-12).map((evt) => ({
    ts: evt.ts,
    severity: evt.severity,
    category: evt.category,
    source: evt.source,
    message: clipForReport(evt.message, 200)
  }));
  const { version: appVer, updatedAtIso: appUpdatedIso } = getAppVersionInfo();
  return {
    appVersion: appVer,
    appUpdatedAt: appUpdatedIso,
    generatedAt: generatedAtIso,
    windowHours: 24,
    totals: {
      importantEvents: events.length,
      bySeverity: severityCounts
    },
    categories: categoryTop,
    suggestions,
    uberDelayStats,
    allinoneCycleStats,
    livePushStats,
    reloadTimeline,
    orderTimeline,
    recent
  };
}

function deriveReportWindowState(previousState, anyReportExists, nowMs) {
  const nowTs = Number(nowMs || Date.now());
  const previous = previousState && typeof previousState === 'object'
    ? previousState
    : null;
  const hasDetailedPresence = anyReportExists && typeof anyReportExists === 'object';
  const presence = hasDetailedPresence ? anyReportExists : null;
  const rootAnyPresent = !!(presence && presence.rootAnyPresent);
  const appAnyPresent = !!(presence && presence.appAnyPresent);
  const reportExists = hasDetailedPresence
    ? (rootAnyPresent || appAnyPresent)
    : !!anyReportExists;
  const previousResetAt = Number(previous && previous.resetAtMs);
  let resetAtMs = Number.isFinite(previousResetAt) && previousResetAt > 0
    ? previousResetAt
    : 0;
  let resetOccurred = false;

  if (hasDetailedPresence) {
    const hasPreviousPairState = !!previous && (
      typeof previous.rootPairPresent === 'boolean' ||
      typeof previous.appPairPresent === 'boolean'
    );
    const rootPairDeleted = !!previous && previous.rootPairPresent === true && !rootAnyPresent;
    const appPairDeleted = !!previous && previous.appPairPresent === true && !appAnyPresent;
    const legacyAllFilesDeleted = !!previous &&
      !hasPreviousPairState &&
      !reportExists &&
      (previous.filesPresent === true || previous.bundlePresent === true);
    if (rootPairDeleted || appPairDeleted || legacyAllFilesDeleted) {
      resetAtMs = nowTs;
      resetOccurred = true;
    }
  } else if (!reportExists && (!previous || previous.filesPresent === true || previous.bundlePresent === true)) {
    resetAtMs = nowTs;
    resetOccurred = true;
  }

  return {
    version: 1,
    resetAtMs,
    filesPresent: reportExists,
    bundlePresent: reportExists,
    rootPairPresent: hasDetailedPresence ? !!presence.rootPairPresent : false,
    appPairPresent: hasDetailedPresence ? !!presence.appPairPresent : false,
    updatedAtMs: nowTs,
    resetOccurred
  };
}

function readReportWindowState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REPORT_WINDOW_STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeReportWindowState(state) {
  try {
    fs.writeFileSync(
      REPORT_WINDOW_STATE_PATH,
      JSON.stringify({
        version: 1,
        resetAtMs: Number(state && state.resetAtMs || 0),
        filesPresent: !!(state && (state.filesPresent || state.bundlePresent)),
        bundlePresent: !!(state && (state.filesPresent || state.bundlePresent)),
        rootPairPresent: !!(state && state.rootPairPresent),
        appPairPresent: !!(state && state.appPairPresent),
        updatedAtMs: Number(state && state.updatedAtMs || Date.now())
      }, null, 2),
      'utf8'
    );
  } catch (_) {}
}

function getReportOutputPresence() {
  const rootTxtPresent = fs.existsSync(ROOT_REPORT_TXT_PATH);
  const rootBundlePresent = fs.existsSync(ROOT_REPORT_BUNDLE_PATH);
  const appTxtPresent = fs.existsSync(APP_24H_REPORT_TXT_PATH);
  const appBundlePresent = fs.existsSync(APP_24H_REPORT_BUNDLE_PATH);
  return {
    rootAnyPresent: rootTxtPresent || rootBundlePresent,
    appAnyPresent: appTxtPresent || appBundlePresent,
    rootPairPresent: rootTxtPresent && rootBundlePresent,
    appPairPresent: appTxtPresent && appBundlePresent
  };
}

function deleteReportOutputFiles() {
  for (const filePath of [
    ROOT_REPORT_TXT_PATH,
    ROOT_REPORT_BUNDLE_PATH,
    APP_24H_REPORT_TXT_PATH,
    APP_24H_REPORT_BUNDLE_PATH
  ]) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

function getReportCutoffMs(endMs, resetAtMs) {
  const rollingCutoffMs = Number(endMs) - (24 * 60 * 60 * 1000);
  const resetTs = Number(resetAtMs || 0);
  return Number.isFinite(resetTs) && resetTs > rollingCutoffMs
    ? resetTs
    : rollingCutoffMs;
}

function startReportBundleDeletionMonitor() {
  if (reportBundleDeletionMonitorTimer) return;
  reportBundleDeletionMonitorTimer = setInterval(() => {
    const previous = readReportWindowState();
    if (!previous) return;
    const nowMs = Date.now();
    const windowState = deriveReportWindowState(previous, getReportOutputPresence(), nowMs);
    if (!windowState.resetOccurred) return;

    // Keep the two mirrored report locations consistent. The diagnostics event
    // store remains intact; resetAtMs is what excludes all pre-deletion events.
    deleteReportOutputFiles();
    writeReportWindowState({
      resetAtMs: windowState.resetAtMs,
      filesPresent: false,
      bundlePresent: false,
      rootPairPresent: false,
      appPairPresent: false,
      updatedAtMs: nowMs
    });
    logMain(`[Report] report window reset reason=report-deleted-by-user resetAt=${new Date(nowMs).toISOString()}`);
    write24hSummaryReport();
  }, 1000);
}

function formatLocalReportTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch (_) {
    return isoString;
  }
}

function formatLocalReportDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch (_) {
    return isoString;
  }
}

function translateReloadReason(rawReason) {
  const r = String(rawReason || '').toLowerCase();
  if (r.includes('online_recovery_reload')) return 'Mạng vừa kết nối lại; Uber tải lại an toàn khi không có đơn đang xử lý';
  if (r.includes('canary') || r.includes('auth')) return 'Tự động kết nối lại do mất xác thực canary/phiên';
  if (r.includes('stale') || r.includes('freeze') || r.includes('unresponsive')) return 'Tải lại do trang bị đơ / không phản hồi';
  if (r.includes('dead-websocket') || r.includes('websocket')) return 'Tải lại do mất kết nối WebSocket nhận đơn';
  if (r.includes('render-process-gone') || r.includes('crash')) return 'Tải lại do tiến trình hiển thị bị gián đoạn / crash';
  if (r.includes('did-fail-load') || r.includes('network') || r.includes('dns')) return 'Tải lại do lỗi mạng / tải trang thất bại';
  if (r.includes('menu-reload') || r.includes('f5') || r.includes('user-requested')) return 'Người dùng chủ động bấm tải lại';
  if (r.includes('locale') || r.includes('lang')) return 'Tải lại do chuyển ngôn ngữ';
  return rawReason || 'Tải lại định kỳ giữ kết nối';
}

function getTabDisplayName(pageOrModule) {
  const s = String(pageOrModule || '').toLowerCase();
  if (s.includes('liveorder')) return 'Takeaway (Live Orders)';
  if (s.includes('fertig')) return 'Tự động Fertig';
  if (s.includes('uber')) return 'Uber Eats';
  if (s.includes('wolt')) return 'Wolt';
  if (s.includes('tienship') || s.includes('ship')) return 'Tiền Ship';
  if (s.includes('admin')) return 'Admin';
  return pageOrModule || 'Ứng dụng';
}

function inferReloadEventDetails(event) {
  const normalized = { ...(event || {}) };
  const message = String(normalized.message || '');
  if (!normalized.page) {
    const pageMatch = message.match(/\[(?:Reload|ReloadKey)\]\s+([a-zA-Z0-9_-]+)/i);
    if (pageMatch) normalized.page = pageMatch[1];
  }
  if (!normalized.reason) {
    const reasonMatch = message.match(/\breason=([^\s]+)/i);
    if (reasonMatch) normalized.reason = reasonMatch[1];
    else if (/F5|Ctrl\+R|reloaded manually/i.test(message)) normalized.reason = 'manual-f5';
  }
  if (!normalized.action) {
    const actionMatch = message.match(/->\s+(reload(?:IgnoringCache)?\(\))/i);
    if (actionMatch) normalized.action = actionMatch[1];
  }
  if (!Number.isFinite(normalized.tsMs)) normalized.tsMs = Date.parse(String(normalized.ts || ''));
  return normalized;
}

function dedupeReloadEvents(events) {
  const result = [];
  const rows = (events || [])
    .map(inferReloadEventDetails)
    .sort((a, b) => Number(a.tsMs || 0) - Number(b.tsMs || 0));
  for (const event of rows) {
    const eventAt = Number(event.tsMs || Date.parse(String(event.ts || '')) || 0);
    const duplicateIndex = result.findIndex((previous) => {
      const previousAt = Number(previous.tsMs || Date.parse(String(previous.ts || '')) || 0);
      return String(previous.page || '') === String(event.page || '')
        && String(previous.reason || '') === String(event.reason || '')
        && Math.abs(eventAt - previousAt) <= 2000;
    });
    if (duplicateIndex < 0) {
      result.push(event);
      continue;
    }
    if (event.category === 'diag_reload' && result[duplicateIndex].category !== 'diag_reload') {
      result[duplicateIndex] = event;
    }
  }
  return result;
}

function getAppVersionInfo() {
  const version = typeof app !== 'undefined' && app.getVersion ? app.getVersion() : '1.2.12';
  let updatedAtIso = '';
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const stat = fs.statSync(pkgPath);
      updatedAtIso = stat.mtime ? stat.mtime.toISOString() : '';
    }
  } catch (_) {}
  return { version, updatedAtIso };
}

function buildVietnameseHumanReport(events, generatedAtIso, windowDescription) {
  const { version: appVer, updatedAtIso: appUpdatedIso } = getAppVersionInfo();
  const updatedDateStr = appUpdatedIso ? formatLocalReportDate(appUpdatedIso) : '';
  const versionHeader = updatedDateStr
    ? `Phiên bản app: v${appVer} (Cập nhật lúc: ${updatedDateStr})`
    : `Phiên bản app: v${appVer}`;

  const orderEvents = events.filter((evt) => evt.category === 'diag_order_activity');
  const manualWoltEvents = events.filter((evt) =>
    evt.category === 'diag_wolt_manual_action'
    && evt.action === 'manual_click'
    && evt.meta
    && ['accept_order', 'confirm', 'delivery_time', 'mark_ready'].includes(evt.meta.actionKind)
  );
  const ordersMap = new Map();

  for (const evt of orderEvents) {
    const code = String(evt.orderCode || (evt.meta && evt.meta.orderCode) || '').trim();
    if (!code) continue;
    if (!ordersMap.has(code)) ordersMap.set(code, []);
    ordersMap.get(code).push(evt);
  }

  // Attach a real operator click to the same Wolt order. Prefer the active
  // bridge order because Flutter can concatenate "#089" with the next label.
  for (const evt of manualWoltEvents) {
    const meta = evt.meta || {};
    const activeNumber = String(
      (meta.context && meta.context.activeOrderNumber)
      || (meta.before && meta.before.bridge && meta.before.bridge.activeOrderNumber)
      || evt.orderCode
      || ''
    ).replace(/^WOLT-/i, '').match(/^\d{1,10}/)?.[0] || '';
    if (!activeNumber) continue;
    const code = [...ordersMap.keys()].find(key => {
      const normalized = String(key).replace(/^WOLT-/i, '').replace(/^0+/, '') || '0';
      return normalized === (activeNumber.replace(/^0+/, '') || '0');
    }) || `WOLT-${activeNumber}`;
    if (!ordersMap.has(code)) ordersMap.set(code, []);
    ordersMap.get(code).push(evt);
  }

  let takeawayCount = 0;
  let uberCount = 0;
  let woltCount = 0;
  let takeawaySuccess = 0;
  let uberSuccess = 0;
  let woltSuccess = 0;
  let takeawayManual = 0;
  let takeawayAuto = 0;
  let uberManual = 0;
  let uberAuto = 0;
  let woltManual = 0;
  let woltAuto = 0;

  const quickRows = [];
  const treeBlocks = [];
  let orderIndex = 1;

  for (const [code, evts] of ordersMap.entries()) {
    evts.sort((a, b) => Number(a.tsMs || Date.parse(a.ts) || 0) - Number(b.tsMs || Date.parse(b.ts) || 0));
    const isUber = evts.some(e => e.module === 'ubereats' || (e.page && String(e.page).includes('uber')));
    const isWolt = evts.some(e => e.module === 'wolt' || (e.page && String(e.page).includes('wolt')));
    const isTakeaway = !isUber && !isWolt;

    let platformName = 'Takeaway (Live Orders)';
    let shortPlatform = 'Takeaway';
    if (isUber) { platformName = 'Uber Eats'; shortPlatform = 'Uber Eats'; }
    else if (isWolt) { platformName = 'Wolt'; shortPlatform = 'Wolt'; }

    const hasWoltManualIntervention = evts.some(e =>
      e.category === 'diag_wolt_manual_action'
      && e.action === 'manual_click'
      && e.meta
      && ['accept_order', 'confirm', 'delivery_time', 'mark_ready'].includes(e.meta.actionKind)
    );
    const isManual = hasWoltManualIntervention || evts.some(e =>
      (e.meta && (e.meta.trigger === 'manual' || e.meta.manual === true || e.meta.source === 'dock_button' || e.meta.source === 'manual_click' || e.meta.source === 'capture_header')) ||
      e.action === 'uber_dock_manual_clicked' ||
      e.action === 'wolt_manual_clicked'
    ) || (isTakeaway && !evts.some(e => e.action === 'cycle_start'));

    const modeLabel = hasWoltManualIntervention ? '[Có bấm tay]' : (isManual ? '[Thủ công]' : '[Tự động]');

    const hasAdminConfirmed = evts.some(e => e.action === 'admin_submit_confirmed');
    const hasAdminFill = evts.some(e => e.action === 'admin_fill_succeeded');
    const hasDuplicateSubmit = evts.filter(e => e.action === 'admin_submit_started').length > 1;
    const hasUberCompleted = evts.some(e => e.action === 'uber_start_delivery_clicked' || e.action === 'uber_scheduled_marked_admin_sent');
    const hasWoltCompleted = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'ready' || (e.meta.state === 'accepted' && e.meta.isPreorder === true))
    );
    const hasWoltAccepted = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'accepted' || e.meta.state === 'ready')
    );
    const hasError = evts.some(e => e.action === 'uber_capture_error' || e.action === 'uber_post_accept_failed' || e.action === 'uber_capture_incomplete' || e.action === 'order_failed' || (e.severity === 'error'));

    let isSuccess = false;
    let statusTag = '⚠️ CẦN KIỂM TRA';

    if (hasDuplicateSubmit) {
      statusTag = '⚠️ ĐƠN BỊ TẠO LẶP TRÊN ADMIN';
    } else if (isUber && hasAdminConfirmed && hasUberCompleted) {
      statusTag = isManual ? '✅ THÀNH CÔNG (Bấm tay)' : '✅ THÀNH CÔNG (Tự động)';
      isSuccess = true;
    } else if (isUber && hasAdminConfirmed) {
      statusTag = '⚠️ ADMIN ĐÃ TẠO - UBER CHƯA HOÀN TẤT';
    } else if (isUber && hasUberCompleted) {
      statusTag = '⚠️ UBER ĐÃ XONG - ADMIN CHƯA XÁC NHẬN';
    } else if (isUber && hasAdminFill) {
      statusTag = '⚠️ ĐÃ ĐIỀN ADMIN - UBER CHƯA HOÀN TẤT';
    } else if (isWolt && hasAdminConfirmed && hasWoltCompleted) {
      statusTag = hasWoltManualIntervention ? '✅ THÀNH CÔNG (Có can thiệp tay)' : (isManual ? '✅ THÀNH CÔNG (Bấm tay)' : '✅ THÀNH CÔNG (Tự động)');
      isSuccess = true;
    } else if (isWolt && hasAdminConfirmed && hasWoltAccepted) {
      statusTag = '⚠️ WOLT ĐÃ NHẬN - CHƯA BẤM BEREIT';
    } else if (isWolt && hasAdminConfirmed) {
      statusTag = '⚠️ ADMIN ĐÃ TẠO - WOLT CHƯA NHẬN ĐƠN';
    } else if (isWolt && hasWoltCompleted) {
      statusTag = '⚠️ WOLT ĐÃ NHẬN - ADMIN CHƯA XÁC NHẬN';
    } else if (isWolt && hasAdminFill) {
      statusTag = '⚠️ ĐÃ ĐIỀN ADMIN - WOLT CHƯA NHẬN ĐƠN';
    } else if (isTakeaway && hasAdminConfirmed) {
      statusTag = isManual ? '✅ THÀNH CÔNG (Bấm tay)' : '✅ THÀNH CÔNG (Tự động)';
      isSuccess = true;
    } else if (isTakeaway && hasAdminFill) {
      statusTag = '⚠️ ĐÃ ĐIỀN FORM - CHƯA XÁC NHẬN TẠO ĐƠN';
    } else if (hasError) {
      statusTag = '⚠️ CẦN KIỂM TRA';
      isSuccess = false;
    }

    if (isUber) {
      uberCount++;
      if (isManual) uberManual++; else uberAuto++;
      if (isSuccess) uberSuccess++;
    } else if (isWolt) {
      woltCount++;
      if (isManual) woltManual++; else woltAuto++;
      if (isSuccess) woltSuccess++;
    } else {
      takeawayCount++;
      if (isManual) takeawayManual++; else takeawayAuto++;
      if (isSuccess) takeawaySuccess++;
    }

    const firstTime = evts.length ? formatLocalReportTime(evts[0].ts) : '';

    let itemCountStr = '';
    let durationStr = '';
    for (const e of evts) {
      const meta = e.meta || {};
      if (meta.itemCount) itemCountStr = `${meta.itemCount} món`;
      if (meta.durationMs) durationStr = `${(meta.durationMs / 1000).toFixed(1)}s`;
    }
    if (isWolt && evts.length > 1) {
      const firstMs = Number(evts[0].tsMs || Date.parse(evts[0].ts) || 0);
      const lastMs = Number(evts[evts.length - 1].tsMs || Date.parse(evts[evts.length - 1].ts) || 0);
      if (firstMs > 0 && lastMs >= firstMs) durationStr = `${((lastMs - firstMs) / 1000).toFixed(1)}s`;
    }

    const quickDetail = [itemCountStr, durationStr].filter(Boolean).join(' | ') || (isSuccess ? 'Đã xử lý' : 'Chưa hoàn tất');
    quickRows.push(`   ${orderIndex}. ${firstTime} | ${shortPlatform.padEnd(10, ' ')} | ${modeLabel.padEnd(10, ' ')} | Đơn #${code} | ${quickDetail} | ${statusTag}`);
    orderIndex++;

    const rawNodes = [];
    let lastNodeText = '';
    for (const e of evts) {
      const timeStr = formatLocalReportTime(e.ts);
      const action = e.action || '';
      const meta = e.meta || {};
      let node = '';

      switch (action) {
        case 'uber_order_seen_first_time':
          node = `👁️ [${timeStr}] Phát hiện: Thẻ đơn mới #${code} xuất hiện trên Uber Eats`;
          break;
        case 'uber_capture_start':
          node = `🔍 [${timeStr}] Đọc thông tin: Bắt đầu quét chi tiết đơn hàng #${code}`;
          break;
        case 'uber_delivery_details_captured': {
          const phoneInfo = meta.phonePresent ? 'Có SĐT khách' : 'Không có SĐT';
          node = `📍 [${timeStr}] Địa chỉ & SĐT: Lấy xong địa chỉ giao hàng và ${phoneInfo}`;
          break;
        }
        case 'uber_payload_saved': {
          const count = meta.itemCount ? `${meta.itemCount} món` : 'danh sách món';
          node = `💾 [${timeStr}] Dữ liệu: Trích xuất thành công ${count} & lưu bộ nhớ tạm`;
          break;
        }
        case 'uber_accept_clicked':
          node = `⚡ [${timeStr}] Nhận đơn: Bấm nút chấp nhận đơn trên Uber Eats`;
          break;
        case 'uber_ready_clicked':
          node = `🛎️ [${timeStr}] Sẵn sàng: Bấm nút "Đã sẵn sàng" (Bereit) trên Uber Eats`;
          break;
        case 'uber_start_delivery_clicked':
          node = `🚚 [${timeStr}] Giao hàng: Đã bấm "Bắt đầu giao hàng" (Lieferung beginnen) trên Uber Eats`;
          break;
        case 'uber_scheduled_marked_admin_sent':
          node = `🗓️ [${timeStr}] Đơn đặt trước: Đã ghi nhận hoàn tất phần xử lý Uber Eats`;
          break;
        case 'uber_post_accept_failed':
          node = `⚠️ [${timeStr}] Uber chưa hoàn tất sau khi nhận đơn: ${meta.error || 'Không tìm thấy nút xử lý tiếp theo'}`;
          break;
        case 'uber_capture_incomplete':
          node = `⚠️ [${timeStr}] Quy trình Uber dừng giữa chừng tại bước ${meta.completionStage || 'không xác định'}${meta.error ? `: ${meta.error}` : ''}`;
          break;
        case 'uber_capture_done': {
          const dur = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : '';
          node = `🏁 [${timeStr}] Hoàn tất: Xử lý xong toàn bộ đơn Uber Eats ${dur ? `(trong ${dur})` : ''}`;
          break;
        }
        case 'cycle_start':
          node = `👁️ [${timeStr}] Phát hiện: Đơn mới #${code} xuất hiện trên Takeaway Live Orders`;
          break;
        case 'cycle_blocked_missing_order_identity':
          node = `🛑 [${timeStr}] Dừng an toàn: Không đọc được mã của nút nhận đơn; chưa mở Admin và chưa nhận đơn`;
          break;
        case 'cycle_blocked_panel_identity_mismatch':
          node = `🛑 [${timeStr}] Dừng an toàn: Panel chi tiết chưa chuyển đúng sang đơn #${meta.expectedOrderCode || code}`;
          break;
        case 'send_identity_mismatch':
          node = `🛑 [${timeStr}] Dừng an toàn: Mã payload #${code} không khớp đơn đang chờ #${meta.expectedOrderCode || 'không xác định'}`;
          break;
        case 'accept_attempt':
        case 'accept_clicked':
          node = `⚡ [${timeStr}] Nhận đơn: Bấm nút nhận đơn trên Takeaway`;
          break;
        case 'cycle_done': {
          const dur = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : '';
          node = `🏁 [${timeStr}] Hoàn tất: Xử lý xong toàn bộ đơn Takeaway ${dur ? `(trong ${dur})` : ''}`;
          break;
        }
        case 'admin_window_opened':
          node = `🌐 [${timeStr}] Tab Admin: Mở tab Admin ngầm và nạp thông tin đơn`;
          break;
        case 'admin_payload_loaded':
          node = `📥 [${timeStr}] Nạp dữ liệu: Tab Admin đã nhận đầy đủ thông tin đơn`;
          break;
        case 'admin_fill_succeeded': {
          const mCount = meta.matchedCount ? `${meta.matchedCount} trường` : 'các trường';
          node = `✍️ [${timeStr}] Điền form: Tự động điền xong ${mCount} vào form Admin`;
          break;
        }
        case 'admin_submit_started':
          node = `📤 [${timeStr}] Gửi đơn: Bấm Submit tạo đơn trên Admin`;
          break;
        case 'admin_submit_confirmed': {
          const dur = meta.durationMs ? `(mất ${meta.durationMs}ms)` : '';
          node = `✅ [${timeStr}] Admin xác nhận: Tạo đơn thành công ${dur} -> Đóng tab Admin`;
          break;
        }
        case 'wolt_tasks_captured':
          node = `👁️ [${timeStr}] Phát hiện: Bắt được đơn mới #${code} từ Wolt`;
          break;
        case 'wolt_accept_clicked':
          node = `⚡ [${timeStr}] Nhận đơn: Bấm nút xác nhận đơn trên Wolt`;
          break;
        case 'wolt_delivery_time_selected':
          node = `⏰ [${timeStr}] Thời gian: Bấm chọn thời gian giao ${meta.minutes ? meta.minutes + ' phút' : ''} trên Wolt`;
          break;
        case 'wolt_confirm_clicked':
          node = `📤 [${timeStr}] Xác nhận: Gửi xác nhận thời gian nhận đơn cho Wolt`;
          break;
        case 'wolt_accept_unconfirmed':
          node = `⚠️ [${timeStr}] Wolt chưa hoàn tất: Chưa xác minh được Wolt đã nhận đơn; app sẽ thử lại và không tạo lại đơn Admin`;
          break;
        case 'wolt_order_processed':
        case 'wolt_order_reconciled':
          if (meta.state === 'ready' || (meta.state === 'accepted' && meta.isPreorder === true)) {
            node = `✅ [${timeStr}] Wolt xác nhận: ${meta.state === 'ready' ? 'Đơn đã được nhận và bấm Bereit thành công' : 'Đơn đặt trước đã được Wolt nhận'}`;
          } else if (meta.state === 'accepted') {
            node = `⏳ [${timeStr}] Wolt đã nhận đơn: Đang chờ app bấm Bereit`;
          }
          break;
        case 'mark_ready':
          node = `🛎️ [${timeStr}] Sẵn sàng: Bấm "Bereit" (Sẵn sàng) trên Wolt`;
          break;
        case 'fertig_clicked':
          node = `🛎️ [${timeStr}] Tự động Fertig: Đã bấm hoàn tất đơn (Fertig) trên Übergabe${meta.orderMinutes != null ? ' (còn ' + meta.orderMinutes + ' phút)' : ''}`;
          break;
        default:
          break;
      }

      if (node && node !== lastNodeText) {
        rawNodes.push(node);
        lastNodeText = node;
      }
    }

    const treeLines = [];
    treeLines.push(`📦 [${platformName.toUpperCase()}] ĐƠN #${code} (Bắt đầu lúc ${firstTime}) -> ${modeLabel} -> ${statusTag} ${durationStr ? `(${durationStr})` : ''}`);
    for (let i = 0; i < rawNodes.length; i++) {
      const isLast = (i === rawNodes.length - 1);
      const prefix = isLast ? '└── ' : '├── ';
      treeLines.push(prefix + rawNodes[i]);
    }

    treeBlocks.push(treeLines.join('\n'));
  }

  // 4. Activity log for Auto Fertig, Tiền Ship, and Wolt Manual Interventions
  const auxEvents = events.filter((evt) =>
    (evt.category === 'diag_order_activity' || evt.category === 'diag_live_push' || evt.category === 'diag_wolt_manual_action') &&
    (evt.module === 'autofertig' || evt.page === 'fertigWin' || evt.module === 'tienship' || evt.page === 'tienShipWin' || evt.category === 'diag_wolt_manual_action' || evt.action === 'manual_click')
  );

  const auxLogLines = [];
  for (const e of auxEvents) {
    const timeStr = formatLocalReportTime(e.ts);
    const action = e.action || '';
    const meta = e.meta || {};

    if (action === 'fertig_clicked') {
      const minsStr = meta.orderMinutes != null ? ` (còn ${meta.orderMinutes} phút)` : '';
      auxLogLines.push(`   - 🛎️ [${timeStr}] Tự động Fertig: Đã bấm hoàn tất (Fertig) đơn #${meta.orderCode || 'đơn'}${minsStr}`);
    } else if (action === 'tienship_report_sent') {
      auxLogLines.push(`   - 🚚 [${timeStr}] Tiền Ship: Đã gửi báo cáo ngày ${meta.reportDate || ''}`);
    } else if (action === 'tienship_report_failed') {
      auxLogLines.push(`   - ❌ [${timeStr}] Tiền Ship: Gửi báo cáo ngày ${meta.reportDate || ''} thất bại (Lỗi: ${meta.error || 'Unknown'})`);
    } else if (action === 'manual_click_result') {
      const targetText = (meta.target && (meta.target.text || meta.target.ariaLabel || meta.target.tagName)) || 'nút';
      const orderStr = e.orderCode ? ` (Đơn #${e.orderCode.replace(/^WOLT-/i, '')})` : '';
      const result = meta.outcomeEvidence || {};
      const beforeStatus = result.beforeTaskStatus || 'chưa có';
      const afterStatus = result.finalTaskStatus || 'chưa có';
      const changed = result.semanticChanged ? 'giao diện đã thay đổi' : 'chưa thấy giao diện thay đổi';
      const targetState = result.targetStillVisible ? 'nút vẫn còn' : 'nút đã biến mất/đổi';
      const intervening = Number(result.interveningManualClicks || 0);
      const finalStage = Array.isArray(meta.after) && meta.after.length ? meta.after[meta.after.length - 1] : null;
      const actions = finalStage && Array.isArray(finalStage.semanticActions)
        ? finalStage.semanticActions.filter(row => row.actionKind && row.actionKind !== 'other').map(row => row.label).slice(0, 6)
        : [];
      const actionSuffix = actions.length ? `; nút sau thao tác: ${actions.join(' | ')}` : '';
      const interveningSuffix = intervening > 0 ? `; có ${intervening} lần bấm tay tiếp theo trong lúc theo dõi` : '';
      auxLogLines.push(`   - 🔎 [${timeStr}] Kết quả bấm tay Wolt "${targetText.slice(0, 60)}"${orderStr}: API ${beforeStatus} -> ${afterStatus}; ${changed}; ${targetState}${actionSuffix}${interveningSuffix}`);
    } else if (e.category === 'diag_wolt_manual_action' || action === 'manual_click') {
      const targetText = (meta.interactiveAncestor && meta.interactiveAncestor.text) || (meta.target && meta.target.text) || (meta.target && meta.target.tagName) || 'nút';
      const orderStr = e.orderCode ? ` (Đơn #${e.orderCode})` : '';
      const actionKind = meta.actionKind && meta.actionKind !== 'other' ? ` [${meta.actionKind}]` : '';
      const semantic = meta.target ? `${meta.target.tagName || ''}${meta.target.role ? '/role=' + meta.target.role : ''}` : '';
      const bridge = meta.before && meta.before.bridge ? meta.before.bridge : {};
      const appState = bridge.lastActionAttempted
        ? `; app trải qua ${bridge.lastActionAttempted}/${bridge.lastActionStatus || 'không rõ'}`
        : '';
      auxLogLines.push(`   - 👆 [${timeStr}] Wolt can thiệp thủ công${actionKind}: Klick "${targetText.slice(0, 60)}"${orderStr}${semantic ? `; semantic ${semantic}` : ''}${appState}`);
    }
  }

  // 5. Reload statistics per tab
  const reloadEvents = dedupeReloadEvents(events.filter((evt) =>
    evt.category === 'diag_reload' ||
    evt.category === 'window_reload' ||
    evt.category === 'stale_reload' ||
    evt.category === 'cross_tab_reload'
  ));

  const tabReloads = new Map([
    ['Takeaway (Live Orders)', []],
    ['Uber Eats', []],
    ['Wolt', []],
    ['Tự động Fertig', []],
    ['Tiền Ship', []]
  ]);

  for (const evt of reloadEvents) {
    const tabName = getTabDisplayName(evt.page || evt.module);
    if (!tabReloads.has(tabName)) tabReloads.set(tabName, []);
    tabReloads.get(tabName).push(evt);
  }

  const reloadSectionLines = [];
  for (const [tabName, evts] of tabReloads.entries()) {
    if (evts.length === 0) {
      reloadSectionLines.push(`   - Tab ${tabName}: 0 lần (Hoạt động liên tục, không reload)`);
    } else {
      reloadSectionLines.push(`   - Tab ${tabName}: ${evts.length} lần`);
      const recentEvts = evts.slice(-10);
      for (const e of recentEvts) {
        const timeStr = formatLocalReportTime(e.ts);
        const reasonText = translateReloadReason(e.reason || e.action || e.category || (e.meta && e.meta.reason));
        reloadSectionLines.push(`     + ${timeStr} | ${reasonText}`);
      }
      if (evts.length > 10) {
        reloadSectionLines.push(`     + ... và ${evts.length - 10} lần reload trước đó`);
      }
    }
  }

  // 6. Warnings
  const warnings = [];
  const isIgnoredWarning = (e) => {
    const msg = String(e.message || '').toLowerCase();
    return msg.includes('fakestoreapi.com');
  };
  const errorEvents = events.filter(e => e.severity === 'error' && !isIgnoredWarning(e));
  if (errorEvents.length > 0) {
    warnings.push(`   - Phát hiện ${errorEvents.length} cảnh báo trong quá trình chạy (chi tiết lưu trong file bundle).`);
  }
  const incompleteUberOrders = new Set();
  for (const [code, evts] of ordersMap.entries()) {
    const isUberOrder = evts.some(e => e.module === 'ubereats' || String(e.action || '').startsWith('uber_'));
    const hasUberCompletion = evts.some(e => e.action === 'uber_start_delivery_clicked' || e.action === 'uber_scheduled_marked_admin_sent');
    const hasIncompleteEvidence = evts.some(e => e.action === 'uber_post_accept_failed' || e.action === 'uber_capture_incomplete' || e.action === 'admin_submit_confirmed');
    if (isUberOrder && !hasUberCompletion && hasIncompleteEvidence) incompleteUberOrders.add(code);
  }
  if (incompleteUberOrders.size > 0) {
    warnings.push(`   - Có ${incompleteUberOrders.size} đơn Uber Eats chưa hoàn tất bước cuối; hãy kiểm tra các đơn có ký hiệu ⚠️ ở mục 2 và 3.`);
  }
  const woltAwaitingAccept = new Set();
  const woltAwaitingReady = new Set();
  for (const [code, evts] of ordersMap.entries()) {
    const isWoltOrder = evts.some(e => e.module === 'wolt' || String(e.action || '').startsWith('wolt_'));
    const hasAdminConfirmation = evts.some(e => e.action === 'admin_submit_confirmed');
    const hasWoltCompletion = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'ready' || (e.meta.state === 'accepted' && e.meta.isPreorder === true))
    );
    const hasWoltAcceptance = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'accepted' || e.meta.state === 'ready')
    );
    if (isWoltOrder && hasAdminConfirmation && !hasWoltCompletion) {
      if (hasWoltAcceptance) woltAwaitingReady.add(code);
      else woltAwaitingAccept.add(code);
    }
  }
  if (woltAwaitingAccept.size > 0) {
    warnings.push(`   - Có ${woltAwaitingAccept.size} đơn đã tạo trên Admin nhưng Wolt chưa xác nhận nhận đơn: ${[...woltAwaitingAccept].map(code => `#${code}`).join(', ')}.`);
  }
  if (woltAwaitingReady.size > 0) {
    warnings.push(`   - Có ${woltAwaitingReady.size} đơn Wolt đã nhận nhưng chưa hoàn tất nút Bereit: ${[...woltAwaitingReady].map(code => `#${code}`).join(', ')}.`);
  }
  const duplicateAdminOrders = [...ordersMap.entries()]
    .filter(([, evts]) => evts.filter(e => e.action === 'admin_submit_started').length > 1)
    .map(([code]) => code);
  if (duplicateAdminOrders.length > 0) {
    warnings.push(`   - Có ${duplicateAdminOrders.length} mã đơn bị tạo lặp trên Admin: ${duplicateAdminOrders.map(code => `#${code}`).join(', ')}.`);
  }

  const lines = [
    '======================================================================',
    '                   BÁO CÁO HOẠT ĐỘNG THAIASIA (24H QUA)               ',
    '======================================================================',
    versionHeader,
    `Thời gian xuất báo cáo: ${formatLocalReportDate(generatedAtIso)}`,
    `Khoảng thời gian theo dõi: ${windowDescription || '24 giờ qua'}`,
    '',
    '📊 1. TỔNG KẾT ĐƠN HÀNG TRONG NGÀY:',
    `   - Takeaway (Live Orders):  ${takeawayCount} đơn [${takeawayManual} Thủ công, ${takeawayAuto} Tự động] (Thành công: ${takeawaySuccess}/${takeawayCount})`,
    `   - Uber Eats:               ${uberCount} đơn [${uberManual} Thủ công, ${uberAuto} Tự động] (Thành công: ${uberSuccess}/${uberCount})`,
    `   - Wolt:                    ${woltCount} đơn [${woltManual} Thủ công, ${woltAuto} Tự động] (Thành công: ${woltSuccess}/${woltCount})`,
    `   -> TỔNG CỘNG:              ${takeawayCount + uberCount + woltCount} đơn được ghi nhận trong report`,
    '',
    '📋 2. DANH SÁCH ĐƠN HÀNG (LƯỚT NHANH):',
    quickRows.length > 0
      ? quickRows.join('\n')
      : '   (Chưa có đơn hàng nào trong khoảng thời gian này)',
    '',
    '🌳 3. CHI TIẾT TỪNG ĐƠN THEO NHÁNH HÀNH ĐỘNG:',
    treeBlocks.length > 0
      ? treeBlocks.join('\n\n----------------------------------------------------------------------\n\n')
      : '   (Chưa có dữ liệu chi tiết)',
    '',
    '📬 4. NHẬT KÝ TỰ ĐỘNG FERTIG & GỬI BÁO CÁO TIỀN SHIP:',
    auxLogLines.length > 0
      ? auxLogLines.join('\n')
      : '   (Chưa có lượt bấm Fertig hay gửi báo cáo tiền ship nào trong 24h qua)',
    '',
    '🔄 5. THỐNG KÊ TẢI LẠI TRANG (RELOAD) THEO TỪNG TAB:',
    reloadSectionLines.join('\n'),
    '',
    '⚠️ 6. TÌNH TRẠNG KẾT NỐI & HỆ THỐNG:',
    warnings.length > 0
      ? warnings.join('\n')
      : '   - Tất cả các sàn (Takeaway, Uber Eats, Wolt, Admin) hoạt động ổn định, không có đơn hàng nào bị kẹt.',
    '======================================================================'
  ];

  return lines.join('\n');
}
function write24hSummaryReport() {
  const endMs = Date.now();
  const previousWindowState = readReportWindowState();
  const windowState = deriveReportWindowState(previousWindowState, getReportOutputPresence(), endMs);
  if (windowState.resetOccurred) {
    deleteReportOutputFiles();
    windowState.filesPresent = false;
    windowState.bundlePresent = false;
    windowState.rootPairPresent = false;
    windowState.appPairPresent = false;
    logMain(`[Report] report window reset reason=report-missing resetAt=${new Date(windowState.resetAtMs).toISOString()}`);
  }
  writeReportWindowState(windowState);
  flushImportantEventBufferSyncFallback();

  const cutoffMs = getReportCutoffMs(endMs, windowState.resetAtMs);
  const events = loadImportantEventsSince(cutoffMs, endMs);
  const generatedAtIso = new Date(endMs).toISOString();
  const windowStartIso = new Date(cutoffMs).toISOString();
  const resetWindowActive = windowState.resetAtMs > endMs - (24 * 60 * 60 * 1000);
  const windowDescription = resetWindowActive
    ? `từ lúc ${formatLocalReportDate(windowStartIso)}`
    : '24 giờ qua';
  const summary = build24hSummary(events, generatedAtIso);
  summary.windowHours = Math.round(((endMs - cutoffMs) / (60 * 60 * 1000)) * 100) / 100;
  summary.windowStart = windowStartIso;
  summary.windowEnd = generatedAtIso;
  summary.windowResetAt = windowState.resetAtMs > 0
    ? new Date(windowState.resetAtMs).toISOString()
    : null;

  const humanReportText = buildVietnameseHumanReport(events, generatedAtIso, windowDescription);

  const bundleLines = [
    '================ THAIASIA 24H REPORT BUNDLE ================',
    `Generated: ${generatedAtIso}`,
    `Window start: ${windowStartIso}`,
    `Window end:   ${generatedAtIso}`,
    '',
    '---------------- SUMMARY (VIETNAMESE) ---------',
    humanReportText,
    '',
    '---------------- SUMMARY (JSON) ---------------',
    JSON.stringify(summary, null, 2),
    '',
    '------------- IMPORTANT EVENTS (NDJSON) --------',
    ...events.map((evt) => JSON.stringify(evt)),
    '================ END OF BUNDLE ================='
  ];
  try {
    fs.writeFileSync(getLast24hReportJsonPath(), JSON.stringify(summary, null, 2), 'utf8');
    fs.writeFileSync(getLast24hReportTxtPath(), humanReportText + '\n', 'utf8');
    fs.writeFileSync(APP_24H_REPORT_TXT_PATH, humanReportText + '\n', 'utf8');
    fs.writeFileSync(APP_24H_REPORT_BUNDLE_PATH, bundleLines.join('\n') + '\n', 'utf8');
  } catch (_) {}
  try {
    fs.writeFileSync(ROOT_REPORT_TXT_PATH, humanReportText + '\n', 'utf8');
    fs.writeFileSync(ROOT_REPORT_BUNDLE_PATH, bundleLines.join('\n') + '\n', 'utf8');
  } catch (_) {}

  const finalPresence = getReportOutputPresence();
  writeReportWindowState({
    resetAtMs: windowState.resetAtMs,
    filesPresent: finalPresence.rootAnyPresent || finalPresence.appAnyPresent,
    bundlePresent: finalPresence.rootAnyPresent || finalPresence.appAnyPresent,
    rootPairPresent: finalPresence.rootPairPresent,
    appPairPresent: finalPresence.appPairPresent,
    updatedAtMs: Date.now()
  });

  if (reportSync) {
    reportSync.syncReportsAsync({
      humanText: humanReportText + '\n',
      bundleText: bundleLines.join('\n') + '\n'
    }).then((res) => {
      logMain('[ReportSync] write24h sync result:', JSON.stringify(res));
    }).catch((err) => {
      logMain('[ReportSync] write24h sync error:', err);
    });
  } else {
    logMain('[ReportSync] write24h skipped: reportSync not initialized');
  }
}
function logMain(...args) {
  const now = new Date();
  const iso = now.toISOString();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const consolePrefix = `[${hh}:${mm}:${ss}]`;
  const messageText = args.map(normalizeLogArg).join(' ');
  const line = `[${iso}] ${messageText}`;
  console.log(consolePrefix, ...args);
  mainLogBuffer.push({ tsMs: now.getTime(), line });
  trackImportantEvent(iso, messageText);
  if (mainLogBuffer.length >= MAIN_LOG_MAX_BUFFERED_LINES) flushMainLogBufferAsync();
  else scheduleMainLogFlush();
}

const RENDERER_DEBUG_KEYWORDS = [
  'reload',
  'stale',
  'crash',
  'restart',
  'relaunch',
  'unresponsive',
  'freeze',
  'dead-websocket',
  'render-process-gone',
  'did-fail-load',
  'recovery',
  'thaiasiadiag'
];
function shouldForwardRendererMessage(level, message) {
  if (!message) return false;
  if (level >= 3) return true;
  const lower = String(message).toLowerCase();
  return RENDERER_DEBUG_KEYWORDS.some((k) => lower.includes(k));
}
function consoleLevelName(level) {
  if (level === 0) return 'log';
  if (level === 1) return 'info';
  if (level === 2) return 'warn';
  if (level === 3) return 'error';
  return `level-${level}`;
}
function clipLogText(value, maxLen = 260) {
  const s = String(value || '');
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...<trimmed>`;
}
function shortenUrlForLog(raw) {
  const value = String(raw || '');
  if (!value || value === 'about:blank') return value || 'about:blank';
  try {
    const u = new URL(value);
    const tabMode = u.searchParams.get('tabmode');
    const base = `${u.origin}${u.pathname}`;
    return tabMode ? `${base}?tabmode=${tabMode}` : base;
  } catch (_) {
    return clipLogText(value, 140);
  }
}

const DEFAULT_ZOOM_FACTOR = 0.75;
const ZOOM_ONE_HUNDRED_PERCENT = 1;
const ZOOM_EPSILON = 0.001;
const ZOOM_PREFS_PATH = path.join(app.getPath('userData'), 'zoom-preferences.json');
const LIVE_ORDERS_ZOOM_KEY = 'liveOrdersShared';
let zoomPrefsCache = null;

function normalizeZoomFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0.25 || n > 5) return null;
  return Math.round(n * 1000) / 1000;
}

function loadZoomPrefs() {
  if (zoomPrefsCache) return zoomPrefsCache;
  try {
    const raw = fs.readFileSync(ZOOM_PREFS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    zoomPrefsCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    zoomPrefsCache = {};
  }
  return zoomPrefsCache;
}

function saveZoomPrefsToDisk() {
  try {
    fs.writeFileSync(ZOOM_PREFS_PATH, JSON.stringify(loadZoomPrefs(), null, 2), 'utf8');
  } catch (err) {
    logMain('[Zoom] Failed to write zoom preferences:', err);
  }
}

function getSavedZoomFactor(zoomKey) {
  const value = loadZoomPrefs()[zoomKey];
  return normalizeZoomFactor(value);
}

function setSavedZoomFactor(zoomKey, zoomFactor) {
  const z = normalizeZoomFactor(zoomFactor);
  if (!z) return false;
  const prefs = loadZoomPrefs();
  const prev = normalizeZoomFactor(prefs[zoomKey]);
  if (prev && Math.abs(prev - z) <= ZOOM_EPSILON) return false;
  prefs[zoomKey] = z;
  saveZoomPrefsToDisk();
  return true;
}

function migrateZoomPreferenceKey(targetKey, sourceKeys = []) {
  if (!targetKey || !Array.isArray(sourceKeys) || sourceKeys.length === 0) return null;
  const prefs = loadZoomPrefs();
  if (normalizeZoomFactor(prefs[targetKey])) return null;
  for (const sourceKey of sourceKeys) {
    const candidate = normalizeZoomFactor(prefs[sourceKey]);
    if (!candidate) continue;
    prefs[targetKey] = candidate;
    saveZoomPrefsToDisk();
    logMain(`[Zoom] migrated saved zoom ${candidate} from ${sourceKey} -> ${targetKey}`);
    return candidate;
  }
  return null;
}

async function getCurrentZoomFactor(browserWin) {
  if (!browserWin || browserWin.isDestroyed()) return null;
  const wc = browserWin.webContents;
  if (!wc || wc.isDestroyed()) return null;

  try {
    if (typeof wc.getZoomFactor === 'function') {
      const value = wc.getZoomFactor();
      const resolved = value && typeof value.then === 'function' ? await value : value;
      const normalized = normalizeZoomFactor(resolved);
      if (normalized) return normalized;
    }
  } catch (_) {}

  try {
    const normalized = normalizeZoomFactor(wc.zoomFactor);
    if (normalized) return normalized;
  } catch (_) {}

  return null;
}

async function setCurrentZoomFactor(browserWin, zoomFactor) {
  const z = normalizeZoomFactor(zoomFactor);
  if (!z || !browserWin || browserWin.isDestroyed()) return false;
  const wc = browserWin.webContents;
  if (!wc || wc.isDestroyed()) return false;

  try {
    if ('zoomFactor' in wc) {
      wc.zoomFactor = z;
      return true;
    }
  } catch (_) {}

  try {
    if (typeof wc.setZoomFactor === 'function') {
      const maybePromise = wc.setZoomFactor(z);
      if (maybePromise && typeof maybePromise.then === 'function') await maybePromise;
      return true;
    }
  } catch (_) {}

  return false;
}

function installPersistentZoom(browserWin, label, zoomKey = label) {
  if (!browserWin || browserWin.isDestroyed()) return;
  let lastPersistedZoom = null;
  let initialZoomReady = false;
  let applyInitialZoomInFlight = false;

  const applyInitialZoom = async () => {
    if (applyInitialZoomInFlight) return;
    applyInitialZoomInFlight = true;
    try {
      if (!browserWin || browserWin.isDestroyed()) return;
      const currentZoom = await getCurrentZoomFactor(browserWin);
      if (!currentZoom) return;

      const savedZoom = getSavedZoomFactor(zoomKey);
      if (savedZoom) {
        if (Math.abs(currentZoom - savedZoom) > ZOOM_EPSILON) {
          const applied = await setCurrentZoomFactor(browserWin, savedZoom);
          if (applied) logMain(`[Zoom] ${label} restored saved zoom ${savedZoom}`);
        }
        const afterApplyZoom = await getCurrentZoomFactor(browserWin);
        lastPersistedZoom = afterApplyZoom || savedZoom;
        return;
      }

      if (Math.abs(currentZoom - ZOOM_ONE_HUNDRED_PERCENT) <= ZOOM_EPSILON) {
        await setCurrentZoomFactor(browserWin, DEFAULT_ZOOM_FACTOR);
        setSavedZoomFactor(zoomKey, DEFAULT_ZOOM_FACTOR);
        lastPersistedZoom = DEFAULT_ZOOM_FACTOR;
        logMain(`[Zoom] ${label} default zoom changed ${currentZoom} -> ${DEFAULT_ZOOM_FACTOR}`);
      }
    } catch (err) {
      logMain(`[Zoom] ${label} apply initial zoom failed:`, err);
    } finally {
      initialZoomReady = true;
      applyInitialZoomInFlight = false;
    }
  };

  const persistCurrentZoom = async () => {
    try {
      if (!browserWin || browserWin.isDestroyed()) return;
      if (!initialZoomReady) return;
      const z = await getCurrentZoomFactor(browserWin);
      if (!z) return;
      if (lastPersistedZoom && Math.abs(lastPersistedZoom - z) <= ZOOM_EPSILON) return;
      if (setSavedZoomFactor(zoomKey, z)) {
        lastPersistedZoom = z;
        logMain(`[Zoom] ${label} saved zoom ${z}`);
      }
    } catch (_) {}
  };

  setTimeout(() => { void applyInitialZoom(); }, 0);
  browserWin.webContents.on('did-finish-load', () => setTimeout(() => { void applyInitialZoom(); }, 60));
  browserWin.webContents.on('dom-ready', () => setTimeout(() => { void applyInitialZoom(); }, 80));
  browserWin.webContents.on('zoom-changed', () => setTimeout(() => { void persistCurrentZoom(); }, 0));
  browserWin.on('blur', () => { void persistCurrentZoom(); });
  browserWin.on('close', () => { void persistCurrentZoom(); });

  const zoomPollTimer = setInterval(() => { void persistCurrentZoom(); }, 2000);
  browserWin.on('closed', () => clearInterval(zoomPollTimer));
}

function installKeyboardZoomShortcuts(browserWin, zoomKey, label = zoomKey) {
  if (!browserWin || browserWin.isDestroyed()) return;
  browserWin.webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    if (!input.control || input.alt) return;

    const code = String(input.code || '');
    const key = String(input.key || '');
    let action = '';

    if (code === 'Equal' || code === 'NumpadAdd' || key === '+' || key === '=') action = 'in';
    else if (code === 'Minus' || code === 'NumpadSubtract' || key === '-' || key === '_') action = 'out';
    else if (code === 'Digit0' || code === 'Numpad0' || key === '0') action = 'reset';
    if (!action) return;

    event.preventDefault();
    void (async () => {
      const current = (await getCurrentZoomFactor(browserWin)) || DEFAULT_ZOOM_FACTOR;
      let next = current;
      if (action === 'in') next = Math.min(5, Math.round((current + 0.10) * 100) / 100);
      else if (action === 'out') next = Math.max(0.25, Math.round((current - 0.10) * 100) / 100);
      else next = DEFAULT_ZOOM_FACTOR;

      const applied = await setCurrentZoomFactor(browserWin, next);
      if (!applied) return;
      setSavedZoomFactor(zoomKey, next);
      logMain(`[Zoom] ${label} keyboard zoom ${action}: ${current} -> ${next}`);
    })();
  });
}

function installOperationalReloadShortcut(browserWin, label) {
  if (!browserWin || browserWin.isDestroyed()) return;
  browserWin.webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    const code = String(input.code || '');
    const key = String(input.key || '');
    const isCtrlR = !!input.control && !input.alt && (code === 'KeyR' || key.toLowerCase() === 'r');
    if (isCtrlR) {
      event.preventDefault();
      logMain(`[ReloadKey] ${label} Ctrl+R blocked; use F5`);
      return;
    }

    const isF5 = !input.control && !input.alt && (code === 'F5' || key === 'F5');
    if (!isF5) return;
    event.preventDefault();
    if (input.isAutoRepeat || browserWin.isDestroyed() || browserWin.webContents.isDestroyed()) return;
    logMain(`[ReloadKey] ${label} F5 -> reload()`);
    browserWin.webContents.reload();
  });
}

// Win7 deployments can have outdated root certificates, which may cause
// certificate validation failures for operational endpoints even when those
// services are otherwise reachable. Limit bypass strictly to known domains.
const CERT_ERROR_BYPASS_HOSTS = [
  'live-orders.takeaway.com',
  'partner-hub.justeattakeaway.com',
  'merchants-beta.ubereats.com',
  'auth.uber.com',
  'api.thaiasiasushibar.de',
  'www.api.thaiasiasushibar.de',
];
const CERT_ERROR_BYPASS_HOST_SUFFIXES = [
  '.takeaway.com',
  '.justeattakeaway.com',
  '.ubereats.com',
  '.uber.com',
];
const UBEREATS_LANGUAGE_PREF_PATH = path.join(app.getPath('userData'), 'ubereats-language.json');
const UBEREATS_LANGUAGE_PROFILES = {
  vi: {
    locale: 'vi-VN',
    acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7,de;q=0.6',
  },
  de: {
    locale: 'de-DE',
    acceptLanguage: 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7,vi;q=0.6',
  },
};
const ubereatsLocaleHooksInstalledForPartition = new Set();
const woltLocaleHooksInstalledForPartition = new Set();

function isWoltDomainHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'wolt.com' || host.endsWith('.wolt.com');
}

function installWoltGermanLocaleHooks(partition) {
  const part = String(partition || '');
  if (!part || woltLocaleHooksInstalledForPartition.has(part)) return;
  const ses = session.fromPartition(part);
  if (!ses || !ses.webRequest) return;

  try {
    ses.setUserAgent(ses.getUserAgent(), WOLT_ACCEPT_LANGUAGE);
  } catch (error) {
    logMain('[Locale] Wolt setUserAgent language override failed:', error);
  }

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    try {
      if (isWoltDomainHost(new URL(details.url).hostname)) {
        headers['Accept-Language'] = WOLT_ACCEPT_LANGUAGE;
      }
    } catch (_) {}
    callback({ requestHeaders: headers });
  });

  woltLocaleHooksInstalledForPartition.add(part);
  logMain(`[Locale] Wolt German locale override active on partition ${part}`);
}

function normalizeUberEatsLanguageMode(value) {
  return String(value || '').toLowerCase() === 'de' ? 'de' : 'vi';
}

function loadUberEatsLanguageMode() {
  try {
    const data = JSON.parse(fs.readFileSync(UBEREATS_LANGUAGE_PREF_PATH, 'utf8'));
    return normalizeUberEatsLanguageMode(data && data.mode);
  } catch (_) {
    return 'vi';
  }
}

function saveUberEatsLanguageMode(mode) {
  const normalized = normalizeUberEatsLanguageMode(mode);
  fs.writeFileSync(UBEREATS_LANGUAGE_PREF_PATH, JSON.stringify({ mode: normalized }), 'utf8');
  return normalized;
}

let uberEatsLanguageMode = loadUberEatsLanguageMode();

function isUberDomainHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'uber.com' || host.endsWith('.uber.com') || host === 'ubereats.com' || host.endsWith('.ubereats.com');
}

function installUberEatsLocaleHooks(partition) {
  const part = String(partition || '');
  if (!part || ubereatsLocaleHooksInstalledForPartition.has(part)) return;
  const ses = session.fromPartition(part);
  if (!ses || !ses.webRequest) return;

  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    try {
      const host = new URL(details.url).hostname;
      if (isUberDomainHost(host)) {
        const profile = UBEREATS_LANGUAGE_PROFILES[uberEatsLanguageMode] || UBEREATS_LANGUAGE_PROFILES.vi;
        headers['Accept-Language'] = profile.acceptLanguage;
      }
    } catch (_) {}
    callback({ requestHeaders: headers });
  });

  ubereatsLocaleHooksInstalledForPartition.add(part);
  logMain(`[Locale] UberEats dynamic Accept-Language override active on partition ${part}`);
}

ipcMain.on('uber-language-mode-get', (event) => {
  event.returnValue = uberEatsLanguageMode;
});

ipcMain.handle('uber-language-mode-set', (_, mode) => {
  try {
    uberEatsLanguageMode = saveUberEatsLanguageMode(mode);
    logMain(`[Locale] UberEats language changed to ${uberEatsLanguageMode}`);
    return { ok: true, mode: uberEatsLanguageMode };
  } catch (error) {
    logMain('[Locale] Failed to save UberEats language:', error);
    return { ok: false, mode: uberEatsLanguageMode, error: String(error && error.message || error || '') };
  }
});

ipcMain.on('uber-language-mode-reload', (event, mode) => {
  const requestedMode = normalizeUberEatsLanguageMode(mode);
  const sender = event.sender;
  if (requestedMode !== uberEatsLanguageMode) {
    logMain(`[Locale] Ignored stale UberEats reload request mode=${requestedMode} current=${uberEatsLanguageMode}`);
    return;
  }

  setImmediate(async () => {
    try {
      const ses = sender.session;
      await ses.clearStorageData({
        origin: 'https://merchants-beta.ubereats.com',
        storages: ['serviceworkers', 'cachestorage']
      });
      await ses.clearCache();
      await ses.flushStorageData();
      logMain(`[Locale] UberEats cache and service worker cleared for mode=${requestedMode}`);
    } catch (error) {
      logMain('[Locale] Failed to clear UberEats language cache:', error);
    }

    if (!sender.isDestroyed()) {
      logMain(`[Locale] UberEats reloadIgnoringCache for mode=${requestedMode}`);
      sender.reloadIgnoringCache();
    }
  });
});

function shouldBypassCertificateForUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    const host = String(u.hostname || '').toLowerCase();
    if (CERT_ERROR_BYPASS_HOSTS.includes(host)) return true;
    return CERT_ERROR_BYPASS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch (_) {
    return false;
  }
}

let _quitting = false;
let _relaunching = false;
let _userRequestedQuit = false;
let _stopWatchdogOnQuit = false;
let _plannedShutdownReason = '';
const gpuCrashTs = [];
const operationalTabLabels = {
  woltWin: 'Wolt',
  liveOrderWin: 'LiveOrder / AllInOne',
  fertigWin: 'Auto Fertig',
  uberEatsWin: 'Uber Eats',
  tienShipWin: 'Tiền Ship'
};
const userDisabledOperationalTabs = new Set();

function isOperationalTabDisabled(label) {
  return userDisabledOperationalTabs.has(label);
}

function signalWatchdogStop(reason) {
  try {
    fs.mkdirSync(WATCHDOG_STATE_DIR, { recursive: true });
    fs.writeFileSync(WATCHDOG_STOP_FLAG_PATH, `stop ${new Date().toISOString()} ${reason || ''}\n`, 'utf8');
    logMain(`[Watchdog] stop flag written reason=${reason || ''} path=${WATCHDOG_STOP_FLAG_PATH}`);
    return true;
  } catch (err) {
    logMain('[Watchdog] failed to write stop flag:', err);
    return false;
  }
}

function quitAppAndStopWatchdog(reason = 'menu-quit-app') {
  _plannedShutdownReason = reason;
  _stopWatchdogOnQuit = true;
  signalWatchdogStop(reason);
  _userRequestedQuit = true;
  app.quit();
}

function quitAppForAutoUpdate(version) {
  _plannedShutdownReason = `auto_update_to_${version || 'unknown'}`;
  _userRequestedQuit = true;
  logMain(`[AutoUpdate] Graceful quit requested for version=${version || 'unknown'}`);
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  app.quit();
}

async function isAppBusyForAutoUpdate() {
  const operational = BrowserWindow.getAllWindows().filter((browserWin) => {
    if (!browserWin || browserWin.isDestroyed() || !browserWin.webContents || browserWin.webContents.isDestroyed()) return false;
    let url = '';
    try { url = String(browserWin.webContents.getURL() || ''); } catch (_) {}
    return /^https?:/i.test(url);
  });
  if (operational.length === 0) return false;
  const states = await Promise.all(operational.map(async (browserWin) => {
    try {
      const isBusy = await Promise.race([
        browserWin.webContents.executeJavaScript('Boolean(window.__thaiasiaOrderProcessing)', true),
        new Promise((resolve) => setTimeout(() => resolve(false), 1500))
      ]);
      return Boolean(isBusy);
    } catch (_) {
      return false;
    }
  }));
  return states.some((isBusy) => isBusy === true);
}

function triggerRelaunch(reason, { quitDelayMs = 500 } = {}) {
  if (_relaunching) return false;
  const helperDir = path.join(USER_DATA_DIR, 'restart-helper');
  const sourceHelper = path.join(__dirname, 'updater', 'restart-app.js');
  const helperPath = path.join(helperDir, 'restart-app.js');
  const instructionPath = path.join(helperDir, 'restart-instruction.json');

  try {
    if (!fs.existsSync(sourceHelper)) throw new Error(`Restart helper missing: ${sourceHelper}`);
    fs.mkdirSync(helperDir, { recursive: true });
    fs.copyFileSync(sourceHelper, helperPath);
    fs.writeFileSync(instructionPath, JSON.stringify({
      schemaVersion: 1,
      parentPid: process.pid,
      appExe: process.execPath,
      logPath: MAIN_LOG_PATH,
      reason: String(reason || ''),
      createdAt: new Date().toISOString()
    }, null, 2), 'utf8');

    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [helperPath, instructionPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: path.dirname(process.execPath),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    child.unref();
    if (!child.pid) throw new Error('Restart helper did not return a PID');
  } catch (err) {
    logMain('[Recovery] external restart helper failed:', err);
    return false;
  }

  _relaunching = true;
  _plannedShutdownReason = String(reason || 'app_restart');
  _userRequestedQuit = true;
  logMain('[Recovery] External relaunch scheduled:', reason);
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  setTimeout(() => app.quit(), Math.max(250, Number(quitDelayMs) || 500));
  return true;
}

function findOperationalWindowFailure(windowsByLabel) {
  for (const [label, browserWin] of Object.entries(windowsByLabel || {})) {
    if (isOperationalTabDisabled(label)) continue;
    if (!browserWin) return { label, reason: 'missing-reference' };
    try {
      if (browserWin.isDestroyed()) return { label, reason: 'browser-window-destroyed' };
    } catch (_) {
      return { label, reason: 'browser-window-check-failed' };
    }
    try {
      if (!browserWin.webContents || browserWin.webContents.isDestroyed()) {
        return { label, reason: 'web-contents-destroyed' };
      }
    } catch (_) {
      return { label, reason: 'web-contents-check-failed' };
    }
  }
  return null;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  logMain('[Lifecycle] Another app instance is already running. Exiting this one.');
  app.quit();
} else {
  initializeAppRunState();
}
app.on('second-instance', () => {
  logMain('[Lifecycle] second-instance event: focusing existing windows.');
  const operationalTargets = [woltWin, liveOrderWin, uberEatsWin].filter((w) => w && !w.isDestroyed());
  if (operationalTargets.length === 0) {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
    return;
  }
  for (const target of operationalTargets) {
    if (target.isMinimized()) target.restore();
    try { target.setSkipTaskbar(false); } catch (_) {}
    target.show();
    target.focus();
  }
});

// -- Shared GM_* store -------------------------------------------------
// Acts as the Tampermonkey cross-tab storage so both the live-orders window and
// the admin window can read/write bridge data via IPC.
const sharedStore = new Map();

// ————— Safe Auto-Shutdown After Tienship Daily Report —————————————————————————
const AUTO_SHUTDOWN_CONFIG_PATH = path.join(app.getPath('userData'), 'auto-shutdown-config.json');

function readAutoShutdownConfig() {
  try {
    if (fs.existsSync(AUTO_SHUTDOWN_CONFIG_PATH)) {
      const raw = fs.readFileSync(AUTO_SHUTDOWN_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        enabled: !!parsed.enabled,
        countdownSeconds: Number(parsed.countdownSeconds) || 60,
        minHour: Number(parsed.minHour != null ? parsed.minHour : 19),
        minMinute: Number(parsed.minMinute != null ? parsed.minMinute : 47)
      };
    }
  } catch (_) {}
  return {
    enabled: false,
    countdownSeconds: 60,
    minHour: 19,
    minMinute: 47
  };
}

function writeAutoShutdownConfig(cfg) {
  try {
    fs.writeFileSync(AUTO_SHUTDOWN_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    logMain('[AutoShutdown] write config error:', e);
  }
}

let lastShutdownTriggeredDate = '';
let activeShutdownBannerWin = null;
let _autofertigRemainingOrders = 0;
let _autofertigHoldsShutdownKey = false;
let _pendingAutofertigShutdownOptions = null;

async function queryAutofertigRemainingOrderCount() {
  if (fertigWin && !fertigWin.isDestroyed()) {
    try {
      const count = await fertigWin.webContents.executeJavaScript(`
        (function() {
          try {
            if (typeof window.__getAutofertigStatus === 'function') {
              const status = window.__getAutofertigStatus();
              return typeof status.remainingCount === 'number' ? status.remainingCount : 0;
            }
            if (typeof window.__thaiasiaAutofertigRemainingCount === 'number') {
              return window.__thaiasiaAutofertigRemainingCount;
            }
          } catch (_) {}
          return 0;
        })()
      `);
      if (typeof count === 'number' && count >= 0) {
        _autofertigRemainingOrders = count;
        return count;
      }
    } catch (_) {}
  }
  return _autofertigRemainingOrders;
}

function evaluateAutoShutdownEligibility(options = {}) {
  const cfg = readAutoShutdownConfig();
  if (options.force !== true && !cfg.enabled) {
    return { eligible: false, reason: 'disabled_by_config' };
  }

  // Nếu là gửi thủ công (bấm nút gửi trên web) -> KHÔNG tắt máy (chỉ tắt khi auto done full hoặc bấm test menu)
  const isManual = options.source === 'manual-direct' || options.source === 'manual' || options.source === 'manual-reload' || options.triggerReason === 'manual';
  if (options.force !== true && isManual) {
    return { eligible: false, reason: 'manual_report_keep_running' };
  }

  // Nếu gửi tự động do chạm deadline 23h55 mà CHƯA Done Full 100% -> KHÔNG tắt máy
  if (options.force !== true && options.triggerReason === 'deadline' && options.doneFull !== true) {
    return { eligible: false, reason: 'deadline_not_done_full_keep_running' };
  }

  // CHỈ tắt máy khi tự động gửi và ĐÃ Done Full 100%
  if (options.force !== true && options.doneFull !== true) {
    return { eligible: false, reason: 'not_done_full_keep_running' };
  }

  const now = options.now || new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const minMinutes = cfg.minHour * 60 + cfg.minMinute;
  // Cho phép nếu >= minMinutes (mặc định 19:47) hoặc ca đêm rạng sáng (< 04:00) hoặc bấm Test thử nghiệm
  const isNightTime = options.force === true || currentMinutes >= minMinutes || now.getHours() < 4;
  if (!isNightTime) {
    return { eligible: false, reason: `daytime_guard_blocked_${now.getHours()}h${now.getMinutes()}` };
  }

  const todayStr = options.reportDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (options.force !== true && lastShutdownTriggeredDate === todayStr) {
    return { eligible: false, reason: 'already_triggered_today' };
  }

  return { eligible: true, config: cfg, todayStr };
}

function cancelWindowsShutdown() {
  _autofertigHoldsShutdownKey = false;
  _pendingAutofertigShutdownOptions = null;
  try {
    const { exec } = require('child_process');
    exec('shutdown /a', (err) => {
      if (err) {
        logMain('[AutoShutdown] shutdown /a result:', err.message);
      } else {
        logMain('[AutoShutdown] shutdown /a executed successfully');
      }
    });
  } catch (e) {
    logMain('[AutoShutdown] cancel error:', e);
  }
  if (activeShutdownBannerWin && !activeShutdownBannerWin.isDestroyed()) {
    try { activeShutdownBannerWin.close(); } catch (_) {}
    activeShutdownBannerWin = null;
  }
}

function showShutdownBanner(countdownSeconds, reportDate, triggeredBy = 'tienship') {
  try {
    if (activeShutdownBannerWin && !activeShutdownBannerWin.isDestroyed()) {
      try { activeShutdownBannerWin.close(); } catch (_) {}
    }
    const win = new BrowserWindow({
      width: 540,
      height: 280,
      resizable: false,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });
    activeShutdownBannerWin = win;
    win.center();

    const subtitle = triggeredBy === 'autofertig_drain'
      ? `Báo cáo Tiền Ship ngày <b>${reportDate || ''}</b> và toàn bộ đơn Takeaway đã hoàn tất.<br>Máy tính sẽ tự động tắt sau:`
      : `Báo cáo Tiền Ship ngày <b>${reportDate || ''}</b> đã gửi thành công.<br>Máy tính sẽ tự động tắt sau:`;

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {
      margin: 0; padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      background: rgba(15, 23, 42, 0.96);
      color: #fff;
      border-radius: 16px;
      border: 2px solid #ef4444;
      box-shadow: 0 20px 40px rgba(0,0,0,0.7);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      box-sizing: border-box;
      text-align: center;
      user-select: none;
    }
    h2 { margin: 0 0 6px; font-size: 20px; color: #f87171; }
    p { margin: 0 0 14px; font-size: 14px; color: #cbd5e1; line-height: 1.4; }
    .timer { font-size: 36px; font-weight: bold; color: #fbbf24; margin-bottom: 16px; font-variant-numeric: tabular-nums; }
    button {
      background: #ef4444; color: #fff; border: none; padding: 12px 28px;
      font-size: 16px; font-weight: bold; border-radius: 10px; cursor: pointer;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.5);
      transition: background 0.2s, transform 0.1s;
    }
    button:hover { background: #dc2626; transform: scale(1.04); }
    button:active { transform: scale(0.97); }
  </style>
</head>
<body>
  <h2>⚠️ TỰ ĐỘNG TẮT MÁY TÍNH</h2>
  <p>${subtitle}</p>
  <div class="timer" id="count">${countdownSeconds}s</div>
  <button id="btnCancel">🛑 HỦY TẮT MÁY (CANCEL)</button>
  <script>
    const { ipcRenderer } = require('electron');
    let count = ${countdownSeconds};
    const timerEl = document.getElementById('count');
    const iv = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(iv);
        timerEl.textContent = 'Đang tắt máy...';
      } else {
        timerEl.textContent = count + 's';
      }
    }, 1000);
    document.getElementById('btnCancel').onclick = () => {
      clearInterval(iv);
      ipcRenderer.send('cancel-auto-shutdown');
    };
  </script>
</body>
</html>`;
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  } catch (e) {
    logMain('[AutoShutdown] show banner error:', e);
  }
}

async function executeSafeShutdownSequence(options = {}) {
  const check = evaluateAutoShutdownEligibility(options);
  if (!check.eligible) {
    logMain(`[AutoShutdown] Ineligible for shutdown: ${check.reason}`);
    return false;
  }

  const { config, todayStr } = check;

  // Nếu đây là lệnh từ Tiền Ship (không phải Test Menu, không phải do Autofertig đã xử lý xong hết đơn)
  if (options.source !== 'test-menu' && options.triggeredBy !== 'autofertig_drain' && options.immediate !== true) {
    const remainingInAutofertig = await queryAutofertigRemainingOrderCount();
    if (remainingInAutofertig > 0) {
      logMain(`[AutoShutdown] Tiền Ship gửi xong báo cáo ngày ${todayStr}, nhưng Autofertig còn ${remainingInAutofertig} đơn đang chờ. Bàn giao chìa khóa tắt máy cho Autofertig.`);
      _autofertigHoldsShutdownKey = true;
      _pendingAutofertigShutdownOptions = { ...options, ...check };
      return true;
    }
  }

  const countdown = options.immediate === true || options.countdownSeconds === 0
    ? 0
    : (options.countdownSeconds != null ? Number(options.countdownSeconds) : (config.countdownSeconds || 60));

  lastShutdownTriggeredDate = todayStr;
  _autofertigHoldsShutdownKey = false;
  _pendingAutofertigShutdownOptions = null;
  logMain(`[AutoShutdown] Starting auto-shutdown sequence for ${todayStr}. TriggeredBy: ${options.triggeredBy || options.source || 'tienship'}. Countdown: ${countdown}s`);

  // Flush báo cáo 24h & đồng bộ lần cuối
  try { write24hSummaryReport(); } catch (_) {}

  const { exec } = require('child_process');
  const cmd = countdown === 0
    ? 'shutdown /s /f /t 0'
    : `shutdown /s /t ${countdown} /c "ThaiAsia: Da gui bao cao Tien Ship & hoan tat don Takeaway. Tu dong tat may trong ${countdown}s."`;

  exec(cmd, (err) => {
    if (err) {
      logMain('[AutoShutdown] Exec shutdown command error:', err.message);
    } else {
      logMain('[AutoShutdown] Exec shutdown command succeeded');
    }
  });

  if (countdown > 0) {
    showShutdownBanner(countdown, todayStr, options.triggeredBy || 'tienship');
  }
  return true;
}

// ————— Persistent store: survive power loss / app restart ——————————————————————
// ADMIN_SENT_KEY lưu mã đơn đặt trước (xanh nước biển) đã gửi admin.
// Khi mất điện / tắt app, sharedStore bị xóa → đơn tái xuất hiện sẽ bị gửi lại.
// Giải pháp: ghi ra file JSON mỗi khi cập nhật, nạp lại khi khởi động.
const PERSIST_KEYS = [
  'thaiasia_wolt_web_state_v1',        // state/dedupe Wolt Web, toi da 24h
  'thaiasia_admin_sent_scheduled_v9',  // mã đơn đặt trước 24h TTL
  'thaiasia_sent_orders_dedup_v9',     // mã đơn đã gửi 5 phút TTL
];
const PERSISTENT_STORE_PATH = path.join(app.getPath('userData'), 'persistent-store.json');
const PERSISTENT_STORE_BAK_PATH = path.join(app.getPath('userData'), 'persistent-store.bak.json');
const PERSISTENT_STORE_TMP_PATH = path.join(app.getPath('userData'), 'persistent-store.tmp.json');
const PERSIST_WRITE_COALESCE_MS = 150;
let persistSaveTimer = null;
let persistSavePending = false;
let persistLastSavedAt = 0;

function buildPersistentStoreSnapshot() {
  const out = {};
  const now = Date.now();
  for (const k of PERSIST_KEYS) {
    if (!sharedStore.has(k)) continue;
    const v = sharedStore.get(k);
    if (Array.isArray(v)) {
      // Gi? entries c� TTL c�n h?n (t?i da 24h)
      out[k] = v.filter(e => e && e.ts && (now - e.ts) < 24 * 60 * 60 * 1000);
      continue;
    }
    out[k] = v;
  }
  return out;
}

function readPersistentStoreFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') return null;
  return data;
}

function loadPersistentStore() {
  try {
    let data = null;
    try {
      data = readPersistentStoreFile(PERSISTENT_STORE_PATH);
    } catch (mainErr) {
      console.error('[ThaiAsia] loadPersistentStore main file parse error:', mainErr);
    }

    // Power-loss recovery: fallback sang .bak n?u file ch�nh b? h?ng.
    if (!data) {
      try {
        data = readPersistentStoreFile(PERSISTENT_STORE_BAK_PATH);
        if (data) {
          fs.writeFileSync(PERSISTENT_STORE_PATH, JSON.stringify(data), 'utf8');
          console.log('[ThaiAsia] Persistent store recovered from backup.');
        }
      } catch (bakErr) {
        console.error('[ThaiAsia] loadPersistentStore backup parse error:', bakErr);
      }
    }

    if (!data) return;
    for (const [k, v] of Object.entries(data)) sharedStore.set(k, v);
    console.log('[ThaiAsia] Persistent store loaded:', Object.keys(data).length, 'keys');
  } catch (e) { console.error('[ThaiAsia] loadPersistentStore error:', e); }
}

function savePersistentStore() {
  try {
    const out = buildPersistentStoreSnapshot();
    const json = JSON.stringify(out);

    // Atomic write: ghi ra tmp tru?c, sau d� rename -> file ch�nh.
    fs.writeFileSync(PERSISTENT_STORE_TMP_PATH, json, 'utf8');

    let renamed = false;
    for (let i = 0; i < 3; i++) {
      try {
        fs.renameSync(PERSISTENT_STORE_TMP_PATH, PERSISTENT_STORE_PATH);
        renamed = true;
        break;
      } catch (renameErr) {
        // Windows c� th? tr? EPERM n?u file ch�nh dang t?m b? lock.
        if (!renameErr || (renameErr.code !== 'EPERM' && renameErr.code !== 'EACCES')) throw renameErr;
        try { if (fs.existsSync(PERSISTENT_STORE_PATH)) fs.unlinkSync(PERSISTENT_STORE_PATH); } catch (_) {}
      }
    }
    if (!renamed) {
      // Fallback cu?i: d?m b?o v?n luu du?c tr?ng th�i thay v� b? m?t b?n ghi.
      fs.writeFileSync(PERSISTENT_STORE_PATH, json, 'utf8');
      try { if (fs.existsSync(PERSISTENT_STORE_TMP_PATH)) fs.unlinkSync(PERSISTENT_STORE_TMP_PATH); } catch (_) {}
    }

    // Lu�n c� backup h?p l? d? recover n?u file ch�nh h?ng sau m?t di?n.
    fs.writeFileSync(PERSISTENT_STORE_BAK_PATH, json, 'utf8');
  } catch (e) {
    try { if (fs.existsSync(PERSISTENT_STORE_TMP_PATH)) fs.unlinkSync(PERSISTENT_STORE_TMP_PATH); } catch (_) {}
    console.error('[ThaiAsia] savePersistentStore error:', e);
  }
}

function flushPersistentStoreSaveNow() {
  if (persistSaveTimer) {
    clearTimeout(persistSaveTimer);
    persistSaveTimer = null;
  }
  if (!persistSavePending) return;
  persistSavePending = false;
  savePersistentStore();
  persistLastSavedAt = Date.now();
}

function requestPersistentStoreSave(immediate = false) {
  persistSavePending = true;
  if (immediate && persistSaveTimer) {
    clearTimeout(persistSaveTimer);
    persistSaveTimer = null;
  }
  if (persistSaveTimer) return;
  const elapsedMs = Date.now() - persistLastSavedAt;
  const delayMs = immediate ? 0 : Math.max(0, PERSIST_WRITE_COALESCE_MS - elapsedMs);
  persistSaveTimer = setTimeout(() => {
    persistSaveTimer = null;
    flushPersistentStoreSaveNow();
  }, delayMs);
}

function safeFlushStorageData(ses) {

  try {
    const maybePromise = ses && ses.flushStorageData ? ses.flushStorageData() : null;
    if (maybePromise && typeof maybePromise.then === 'function') {
      return maybePromise.catch(() => {});
    }
  } catch (_) {}
  return Promise.resolve();
}

loadPersistentStore(); // Náº¡p ngay khi main.js khá»Ÿi Ä‘á»™ng

ipcMain.handle('gm-get', (_, key, defaultValue) => {
  return sharedStore.has(key) ? sharedStore.get(key) : defaultValue;
});

ipcMain.handle('gm-set', (_, key, value) => {
  sharedStore.set(key, value);
  if (PERSIST_KEYS.includes(key)) requestPersistentStoreSave(); // coalesce writes to reduce main-thread stalls
});

ipcMain.handle('gm-delete', (_, key) => {
  sharedStore.delete(key);
  if (PERSIST_KEYS.includes(key)) requestPersistentStoreSave();
});

ipcMain.handle('gm-xmlhttp-request', (_, options) => {
  return new Promise((resolve, reject) => {
    const requestOptions = options || {};
    const url = String(requestOptions.url || '');
    if (!/^https?:\/\//i.test(url)) {
      reject(new Error('Invalid GM_xmlhttpRequest URL'));
      return;
    }

    const method = String(requestOptions.method || 'GET').toUpperCase();
    const headers = requestOptions.headers && typeof requestOptions.headers === 'object'
      ? requestOptions.headers
      : {};
    const data = requestOptions.data == null ? '' : String(requestOptions.data);
    const timeoutMs = Math.max(0, Number(requestOptions.timeout) || 0);

    let settled = false;
    let timeoutId = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      fn(value);
    };

    try {
      const req = net.request({ method, url });
      for (const [name, value] of Object.entries(headers)) {
        if (value == null) continue;
        req.setHeader(String(name), String(value));
      }
      req.on('response', (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          settle(resolve, {
            status: response.statusCode || 0,
            statusText: response.statusMessage || '',
            responseHeaders: response.headers || {},
            responseText: Buffer.concat(chunks).toString('utf8'),
            finalUrl: response.url || url,
          });
        });
      });
      req.on('error', (error) => settle(reject, error));
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          try { req.abort(); } catch (_) {}
          settle(reject, new Error(`GM_xmlhttpRequest timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      if (data) req.write(data);
      req.end();
    } catch (error) {
      settle(reject, error);
    }
  });
});

ipcMain.on('takeaway-health', (_, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const page = String(payload.page || '');
  if (page !== 'liveOrderWin' && page !== 'fertigWin') return;
  noteTakeawayRuntimePayload(payload, Date.now());
});

// Each admin request owns its own BrowserWindow and is bound to one order payload.
// Multiple sources can open the same create URL at the same time without replacing
// each other or reading whichever order happens to be globally active last.
const BRIDGE_ACTIVE_ORDER_KEY = 'thaiasia_takeaway_order_bridge_active_v9';
const BRIDGE_ORDER_STORAGE_PREFIX = 'thaiasia_takeaway_order_bridge_v9';
const adminWindows = new Map(); // requestId -> BrowserWindow
const adminWindowStates = new Map(); // webContents.id -> submit lifecycle state
let adminRequestSequence = 0;

function normalizeAdminOpenRequest(rawRequest, senderId = 0) {
  const row = rawRequest && typeof rawRequest === 'object'
    ? rawRequest
    : { url: rawRequest };
  const url = String(row.url || '');
  const requestedId = String(row.requestId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, '_')
    .slice(0, 160);
  const requestId = requestedId
    || `admin-${Number(senderId) || 0}-${Date.now()}-${++adminRequestSequence}`;
  const requestedStorageKey = String(row.storageKey || '').trim();
  const show = row.show === true || row.active === true;
  return { url, requestId, requestedStorageKey, show };
}

function isBridgeOrderStorageKey(value) {
  const key = String(value || '');
  return key === BRIDGE_ORDER_STORAGE_PREFIX
    || key.startsWith(`${BRIDGE_ORDER_STORAGE_PREFIX}_`);
}

function resolveAdminOrderBinding(requestedStorageKey) {
  const requested = String(requestedStorageKey || '');
  if (isBridgeOrderStorageKey(requested) && sharedStore.has(requested)) return requested;
  const active = String(sharedStore.get(BRIDGE_ACTIVE_ORDER_KEY) || '');
  if (isBridgeOrderStorageKey(active) && sharedStore.has(active)) return active;
  return '';
}

function emitAdminWindowDiag(action, details = {}) {
  logMain('[ThaiAsiaDiag] ' + JSON.stringify({
    v: 1,
    module: 'allinone',
    eventType: 'order_activity',
    ts: new Date().toISOString(),
    ...details,
    page: 'adminWin',
    action,
    orderCode: String(details.orderCode || '')
  }));
}

function isAdminCreateUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return /(^|\.)api\.thaiasiasushibar\.de$/i.test(parsed.hostname)
      && /\/admin\/orders\/create\b/i.test(parsed.pathname);
  } catch (_) { return false; }
}

function isAdminOrderSuccessUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return /(^|\.)api\.thaiasiasushibar\.de$/i.test(parsed.hostname)
      && /\/admin\/orders(?:\/|$)/i.test(parsed.pathname)
      && !/\/admin\/orders\/create\b/i.test(parsed.pathname);
  } catch (_) { return false; }
}

function markAdminPayloadAutoActionsDone(orderCode) {
  const safe = String(orderCode || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!safe) return;
  const key = `thaiasia_takeaway_order_bridge_v9_${safe}`;
  const payload = sharedStore.get(key);
  if (!payload || typeof payload !== 'object') return;
  sharedStore.set(key, {
    ...payload,
    __autoFill: false,
    __autoSubmit: false,
    __autoActionAt: null
  });
}

function persistWoltAdminConfirmation(boundStorageKey, orderCode) {
  if (!isBridgeOrderStorageKey(boundStorageKey)) return;
  const payload = sharedStore.get(String(boundStorageKey));
  if (payload && payload.__woltPreviewOnly === true) return;
  const identity = payload && typeof payload === 'object' ? String(payload.__woltIdentity || '') : '';
  if (!identity) return;
  const stateKey = 'thaiasia_wolt_web_state_v1';
  const current = sharedStore.get(stateKey);
  const rows = Array.isArray(current) ? current : [];
  const next = rows.filter((row) => row && row.identity !== identity);
  next.push({
    identity,
    orderCode: String(orderCode || (payload && payload.orderCode) || ''),
    state: 'admin_confirmed',
    storageKey: String(boundStorageKey),
    ts: Date.now()
  });
  sharedStore.set(stateKey, next.slice(-200));
  requestPersistentStoreSave(true);
}

const ADMIN_WINDOW_TIMEOUT_MS = 30 * 1000;
const ADMIN_WINDOW_MAX_ATTEMPTS = 3;
const adminOrderRetries = new Map(); // orderKey -> retry tracking object

function safelyShowAdminWindow(adminWin) {
  try {
    if (!adminWin || adminWin.isDestroyed()) return;
    adminWin.setSkipTaskbar(false);
    adminWin.show();
    adminWin.focus();
    if (typeof adminWin.moveTop === 'function') adminWin.moveTop();
  } catch (_) {}
}

function safelyShowCallerWindow(openerWebContentsId) {
  try {
    if (!openerWebContentsId) return;
    const openerWc = webContents.fromId(openerWebContentsId);
    if (!openerWc || openerWc.isDestroyed()) return;
    const openerWin = BrowserWindow.fromWebContents(openerWc);
    if (openerWin && !openerWin.isDestroyed()) {
      if (openerWin.isMinimized()) openerWin.restore();
      openerWin.show();
      openerWin.focus();
      if (typeof openerWin.moveTop === 'function') openerWin.moveTop();
    }
  } catch (_) {}
}

function getAdminOrderKey(orderCode, storageKey, requestId) {
  if (orderCode) return `code_${String(orderCode).trim().toLowerCase()}`;
  if (storageKey) return `key_${String(storageKey).trim()}`;
  return `req_${String(requestId || '').trim()}`;
}

function clearAdminRetryRecord(orderKey) {
  if (!orderKey) return;
  const record = adminOrderRetries.get(orderKey);
  if (record) {
    if (record.watchdogTimer) {
      clearTimeout(record.watchdogTimer);
      record.watchdogTimer = null;
    }
    adminOrderRetries.delete(orderKey);
  }
}

function closeConfirmedAdminWindow(adminWin, state, confirmation) {
  if (!adminWin || adminWin.isDestroyed() || !state || state.closeScheduled) return;
  state.closeScheduled = true;
  state.confirmed = true;
  state.confirmation = confirmation || state.confirmation || '';

  if (state.orderKey) {
    clearAdminRetryRecord(state.orderKey);
  }

  markAdminPayloadAutoActionsDone(state.orderCode);
  persistWoltAdminConfirmation(state.storageKey, state.orderCode);

  if (state.openerWebContentsId) {
    try {
      const openerWc = webContents.fromId(state.openerWebContentsId);
      if (openerWc && !openerWc.isDestroyed()) {
        openerWc.send('admin-submit-result', {
          ok: true,
          requestId: state.requestId,
          orderCode: state.orderCode,
          confirmation: state.confirmation
        });
      }
    } catch (_) {}
  }

  setTimeout(() => {
    if (!adminWin.isDestroyed()) adminWin.destroy();
  }, 3000);
}

function handleAdminWindowTimeout(orderKey, requestId, adminWebContentsId) {
  const retryRecord = adminOrderRetries.get(orderKey);
  if (!retryRecord || retryRecord.requestId !== requestId) return;
  adminOrderRetries.delete(orderKey);

  const adminState = adminWindowStates.get(adminWebContentsId);
  if (adminState && adminState.confirmed) return;

  const currentAttempt = retryRecord.attempt || 1;
  const adminWin = retryRecord.adminWin;

  if (currentAttempt < ADMIN_WINDOW_MAX_ATTEMPTS) {
    emitAdminWindowDiag('admin_timeout_retry', {
      orderCode: retryRecord.orderCode,
      attempt: currentAttempt,
      maxAttempts: ADMIN_WINDOW_MAX_ATTEMPTS,
      nextAttempt: currentAttempt + 1,
      timeoutMs: ADMIN_WINDOW_TIMEOUT_MS
    });
    logMain(`[AdminWindow] attempt ${currentAttempt}/${ADMIN_WINDOW_MAX_ATTEMPTS} timed out after ${ADMIN_WINDOW_TIMEOUT_MS / 1000}s for #${retryRecord.orderCode || '-'}. Retrying attempt ${currentAttempt + 1}...`);

    if (adminState) adminState.confirmed = true;
    try {
      if (adminWin && !adminWin.isDestroyed()) {
        adminWin.destroy();
      }
    } catch (_) {}

    openAdminWindowInternal(retryRecord.rawRequest, retryRecord.senderId, currentAttempt + 1);
  } else {
    emitAdminWindowDiag('admin_timeout_exhausted', {
      orderCode: retryRecord.orderCode,
      attempts: currentAttempt,
      maxAttempts: ADMIN_WINDOW_MAX_ATTEMPTS,
      totalDurationMs: currentAttempt * ADMIN_WINDOW_TIMEOUT_MS
    });
    logMain(`[AdminWindow] ALL ${currentAttempt} attempts timed out for #${retryRecord.orderCode || '-'}. Popping up Admin and caller windows for manual resolution.`);

    if (adminWin && !adminWin.isDestroyed()) {
      safelyShowAdminWindow(adminWin);
    }
    safelyShowCallerWindow(retryRecord.senderId);
  }
}

function openAdminWindowInternal(rawRequest, senderId = 0, attempt = 1) {
  const request = normalizeAdminOpenRequest(rawRequest, senderId);
  if (!isAdminCreateUrl(request.url)) {
    emitAdminWindowDiag('admin_open_rejected', {
      reason: 'invalid_url',
      url: shortenUrlForLog(request.url)
    });
    return null;
  }

  let requestId = request.requestId;
  if (attempt > 1) {
    requestId = `${request.requestId}-retry${attempt}`;
  }
  while (adminWindows.has(requestId)) {
    requestId = `${requestId}-${++adminRequestSequence}`;
  }
  const storageKey = resolveAdminOrderBinding(request.requestedStorageKey);
  const boundPayload = storageKey ? sharedStore.get(storageKey) : null;
  const boundOrderCode = boundPayload && typeof boundPayload === 'object'
    ? String(boundPayload.orderCode || '')
    : '';
  const orderKey = getAdminOrderKey(boundOrderCode, storageKey, request.requestId);

  const shouldShow = request.show === true;
  const isAuto = !shouldShow && (!boundPayload || boundPayload.__autoSubmit !== false);

  const adminWin = new BrowserWindow({
    width: 1200,
    height: 900,
    show: shouldShow,
    skipTaskbar: !shouldShow,
    title: `[Admin Order] Đang điền đơn ${boundOrderCode || 'Đơn hàng'} - ThaiAsia`,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-admin.js'),
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  if (shouldShow) {
    try {
      adminWin.show();
      adminWin.focus();
      if (typeof adminWin.moveTop === 'function') adminWin.moveTop();
    } catch (_) {}
  }
  installPersistentZoom(adminWin, 'adminWin');
  installKeyboardZoomShortcuts(adminWin, 'adminWin', 'adminWin');
  const adminWebContentsId = adminWin.webContents.id;
  const adminState = {
    openedAt: Date.now(),
    requestId,
    url: request.url,
    storageKey,
    openerWebContentsId: senderId,
    orderCode: boundOrderCode,
    submitStartedAt: 0,
    confirmed: false,
    closeScheduled: false,
    confirmation: '',
    attempt,
    orderKey,
    isAuto
  };
  adminWindowStates.set(adminWebContentsId, adminState);

  let watchdogTimer = null;
  if (isAuto) {
    watchdogTimer = setTimeout(() => {
      handleAdminWindowTimeout(orderKey, requestId, adminWebContentsId);
    }, ADMIN_WINDOW_TIMEOUT_MS);

    adminOrderRetries.set(orderKey, {
      orderKey,
      orderCode: boundOrderCode,
      rawRequest,
      senderId,
      attempt,
      maxAttempts: ADMIN_WINDOW_MAX_ATTEMPTS,
      watchdogTimer,
      adminWin,
      requestId,
      adminWebContentsId
    });
  }

  adminWin.webContents.on('dom-ready', () => {
    injectAutoLoginHelper(adminWin, 'admin');
  });

  adminWin.webContents.on('did-fail-load', (_, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    emitAdminWindowDiag('admin_load_failed', {
      orderCode: adminState.orderCode,
      errorCode: code,
      errorDescription: String(desc || '').slice(0, 240),
      url: shortenUrlForLog(failedUrl),
      attempt,
      maxAttempts: ADMIN_WINDOW_MAX_ATTEMPTS
    });

    if (isAuto && attempt < ADMIN_WINDOW_MAX_ATTEMPTS && !adminState.confirmed) {
      if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null; }
      emitAdminWindowDiag('admin_load_failed_retry', {
        orderCode: adminState.orderCode,
        errorCode: code,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: ADMIN_WINDOW_MAX_ATTEMPTS
      });
      adminState.confirmed = true;
      try { if (!adminWin.isDestroyed()) adminWin.destroy(); } catch (_) {}
      setTimeout(() => {
        openAdminWindowInternal(rawRequest, senderId, attempt + 1);
      }, 500);
      return;
    }

    safelyShowAdminWindow(adminWin);
    if (isAuto && attempt >= ADMIN_WINDOW_MAX_ATTEMPTS) {
      safelyShowCallerWindow(senderId);
    }
  });

  const handleAdminNavigation = (_event, nextUrl) => {
    if (!adminState.submitStartedAt || adminState.confirmed) return;
    if (isAdminOrderSuccessUrl(nextUrl)) {
      emitAdminWindowDiag('admin_submit_confirmed', {
        orderCode: adminState.orderCode,
        confirmation: 'main_navigation',
        durationMs: Math.max(0, Date.now() - adminState.submitStartedAt),
        url: shortenUrlForLog(nextUrl),
        attempt
      });
      closeConfirmedAdminWindow(adminWin, adminState, 'main_navigation');
    } else if (!isAdminCreateUrl(nextUrl)) {
      emitAdminWindowDiag('admin_submit_navigation_unconfirmed', {
        orderCode: adminState.orderCode,
        durationMs: Math.max(0, Date.now() - adminState.submitStartedAt),
        url: shortenUrlForLog(nextUrl),
        attempt
      });
      safelyShowAdminWindow(adminWin);
      if (isAuto) safelyShowCallerWindow(senderId);
    }
  };

  adminWin.webContents.on('did-navigate', handleAdminNavigation);
  adminWin.webContents.on('did-navigate-in-page', handleAdminNavigation);
  adminWin.loadURL(request.url);
  adminWindows.set(requestId, adminWin);

  emitAdminWindowDiag('admin_window_opened', {
    orderCode: boundOrderCode,
    requestId,
    storageKeyBound: !!storageKey,
    concurrentWindowCount: adminWindows.size,
    attempt,
    maxAttempts: ADMIN_WINDOW_MAX_ATTEMPTS
  });
  logMain(`[AdminWindow] opened admin window request=${requestId} order=${boundOrderCode || '-'} attempt=${attempt}/${ADMIN_WINDOW_MAX_ATTEMPTS} url=${shortenUrlForLog(request.url)}`);

  adminWin.on('closed', () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    const currentRetry = adminOrderRetries.get(orderKey);
    if (currentRetry && currentRetry.requestId === requestId) {
      adminOrderRetries.delete(orderKey);
    }

    if (adminState && !adminState.confirmed && adminState.openerWebContentsId) {
      try {
        const openerWc = webContents.fromId(adminState.openerWebContentsId);
        if (openerWc && !openerWc.isDestroyed()) {
          openerWc.send('admin-submit-result', {
            ok: false,
            requestId: adminState.requestId,
            orderCode: adminState.orderCode,
            reason: 'admin_window_closed_unconfirmed',
            attempt
          });
        }
      } catch (_) {}
    }
    emitAdminWindowDiag('admin_window_closed', {
      orderCode: adminState.orderCode,
      confirmed: !!adminState.confirmed,
      confirmation: adminState.confirmation || '',
      windowAgeMs: Math.max(0, Date.now() - adminState.openedAt),
      attempt
    });
    adminWindowStates.delete(adminWebContentsId);
    if (adminWindows.get(requestId) === adminWin) adminWindows.delete(requestId);
  });

  if (adminWindows.size > 5) {
    emitAdminWindowDiag('admin_window_pressure', {
      orderCode: boundOrderCode,
      concurrentWindowCount: adminWindows.size
    });
  }

  return adminWin;
}

ipcMain.handle('admin-payload-binding-get', (event) => {
  const state = adminWindowStates.get(event.sender.id);
  return {
    bound: !!state,
    storageKey: state ? String(state.storageKey || '') : '',
    requestId: state ? String(state.requestId || '') : ''
  };
});

ipcMain.on('open-admin-window', (event, rawRequest) => {
  openAdminWindowInternal(rawRequest, event.sender.id, 1);
});

ipcMain.handle('simulate-click', async (event, coords) => {
  const wc = event.sender;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'sender_destroyed' };
  try {
    const win = BrowserWindow.fromWebContents(wc);
    if (win && !win.isDestroyed()) {
      try { win.focus(); } catch (_) {}
      // Give Windows/Flutter time to apply focus before sending pointer input.
      await new Promise(r => setTimeout(r, 250));
    }
    const requestedX = Math.round(coords && coords.x || 0);
    const requestedY = Math.round(coords && coords.y || 0);
    // DOM bounds are expressed in page CSS pixels. sendInputEvent expects the
    // visible WebContents coordinate, so page zoom must be applied first.
    // Without this conversion a 55% Wolt page sends a click almost twice as
    // far right/down as the visible Bereit button.
    const zoomFactor = (win && !win.isDestroyed() && await getCurrentZoomFactor(win)) || 1;
    const x = Math.round(requestedX * zoomFactor);
    const y = Math.round(requestedY * zoomFactor);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    await new Promise(r => setTimeout(r, 140));
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 170));
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    const result = {
      ok: true,
      requestedPoint: { x: requestedX, y: requestedY },
      inputPoint: { x, y },
      zoomFactor
    };
    logMain('[WoltNativeClick] dispatched:', JSON.stringify(result));
    return result;
  } catch (error) {
    const result = { ok: false, error: error && error.message ? error.message : String(error) };
    logMain('[WoltNativeClick] failed:', JSON.stringify(result));
    return result;
  }
});

ipcMain.handle('wolt-wake-renderer', async (event, options = {}) => {
  const wc = event.sender;
  if (!wc || wc.isDestroyed()) return { ok: false, error: 'sender_destroyed' };
  try {
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed()) return { ok: false, error: 'window_destroyed' };

    const action = String(options.action || 'gentle_wake');
    const orderNumber = String(options.orderNumber || '');

    if (action === 'force_focus') {
      const currentFocused = BrowserWindow.getFocusedWindow();
      const prevWindowId = currentFocused && !currentFocused.isDestroyed() && currentFocused !== win ? currentFocused.id : null;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      logMain(`[WoltWake] force_focus executed for #${orderNumber}. prevWindowId: ${prevWindowId}`);
      return { ok: true, method: 'force_focus', prevWindowId };
    }

    // gentle_wake: đảm bảo backgroundThrottling false, showInactive và gửi mouseMove đánh thức rendering loop
    if (typeof wc.setBackgroundThrottling === 'function') {
      wc.setBackgroundThrottling(false);
    }
    if (typeof win.showInactive === 'function') {
      try { win.showInactive(); } catch (_) {}
    }
    wc.sendInputEvent({ type: 'mouseMove', x: 100, y: 100 });
    logMain(`[WoltWake] gentle_wake ping sent for #${orderNumber}`);
    return { ok: true, method: 'gentle_wake' };
  } catch (error) {
    const result = { ok: false, error: error && error.message ? error.message : String(error) };
    logMain('[WoltWake] failed:', JSON.stringify(result));
    return result;
  }
});

ipcMain.handle('wolt-restore-focus', async (_event, token = {}) => {
  try {
    const prevWindowId = token && token.prevWindowId;
    if (prevWindowId) {
      const prevWin = BrowserWindow.fromId(prevWindowId);
      if (prevWin && !prevWin.isDestroyed()) {
        if (prevWin.isMinimized()) prevWin.restore();
        prevWin.show();
        prevWin.focus();
        logMain(`[WoltWake] focus restored to window #${prevWindowId}`);
        return { ok: true, restoredId: prevWindowId };
      }
    }
    return { ok: true, noop: true };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.on('admin-submit-event', (event, payload) => {
  const adminWin = BrowserWindow.fromWebContents(event.sender);
  if (!adminWin || adminWin.isDestroyed()) return;
  const row = payload && typeof payload === 'object' ? payload : {};
  const details = row.details && typeof row.details === 'object' ? row.details : {};
  const action = String(row.action || details.action || '').slice(0, 100);
  if (!/^admin_[a-z0-9_]+$/i.test(action)) return;
  const state = adminWindowStates.get(event.sender.id);
  const orderCode = String(details.orderCode || (state && state.orderCode) || '').slice(0, 80);
  if (state) {
    if (orderCode) state.orderCode = orderCode;
    if (action === 'admin_submit_started') state.submitStartedAt = Date.now();
    if (action === 'admin_submit_confirmed') {
      state.confirmed = true;
      state.confirmation = String(details.confirmation || 'renderer_confirmation');
      if (state.orderKey) {
        clearAdminRetryRecord(state.orderKey);
      }
    }
  }
  emitAdminWindowDiag(action, {
    ...details,
    orderCode,
    source: 'renderer:adminWin',
    attempt: state ? state.attempt : 1
  });
  if (action === 'admin_submit_confirmed' && state) {
    closeConfirmedAdminWindow(adminWin, state, state.confirmation);
  } else if (/failed|unconfirmed|timeout/i.test(action)) {
    safelyShowAdminWindow(adminWin);
    if (state && state.isAuto && state.attempt >= ADMIN_WINDOW_MAX_ATTEMPTS) {
      safelyShowCallerWindow(state.openerWebContentsId);
    }
  }
});

ipcMain.on('show-current-admin-window', (event) => {
  const adminWin = BrowserWindow.fromWebContents(event.sender);
  safelyShowAdminWindow(adminWin);
});

ipcMain.on('close-current-admin-window', (event) => {
  const adminWin = BrowserWindow.fromWebContents(event.sender);
  if (!adminWin || adminWin.isDestroyed()) return;
  const state = adminWindowStates.get(event.sender.id);
  if (state && !state.confirmed) {
    emitAdminWindowDiag('admin_close_blocked_unconfirmed', {
      orderCode: state.orderCode,
      submitPending: !!state.submitStartedAt
    });
    safelyShowAdminWindow(adminWin);
    return;
  }
  adminWin.destroy();
});

// Close the exact window represented by the GM_openInTab handle. Legacy callers
// that only send a URL are limited to their own most recent matching request.
ipcMain.on('close-admin-window', (event, rawRequest) => {
  const row = rawRequest && typeof rawRequest === 'object'
    ? rawRequest
    : { url: rawRequest };
  const requestId = String(row.requestId || '');
  if (requestId) {
    const win = adminWindows.get(requestId);
    if (win && !win.isDestroyed()) win.destroy();
    adminWindows.delete(requestId);
    return;
  }

  const url = String(row.url || '');
  const candidates = [...adminWindowStates.entries()]
    .filter(([, state]) => state
      && state.openerWebContentsId === event.sender.id
      && state.url === url)
    .sort((a, b) => Number(b[1].openedAt || 0) - Number(a[1].openedAt || 0));
  if (!candidates.length) return;
  const [webContentsId, state] = candidates[0];
  const win = adminWindows.get(state.requestId);
  if (win && !win.isDestroyed()) win.destroy();
  adminWindows.delete(state.requestId);
  adminWindowStates.delete(webContentsId);
});

// Dá» n sharedStore má»—i 30 phÃºt: xÃ³a key cÅ© hÆ¡n 2 tiáº¿ng â†’ chá»‘ng memory leak
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [k, v] of sharedStore.entries()) {
    if (v && typeof v === 'object' && v.__autoActionAt && v.__autoActionAt < cutoff) {
      sharedStore.delete(k);
    }
  }
  // Giá»›i háº¡n tá»‘i Ä‘a 500 entries
  if (sharedStore.size > 500) {
    const toDelete = sharedStore.size - 500;
    let i = 0;
    for (const k of sharedStore.keys()) {
      if (i++ >= toDelete) break;
      sharedStore.delete(k);
    }
  }
  requestPersistentStoreSave(); // Ä‘á»“ng bá»™ file sau má»—i láº§n dá» n
}, 30 * 60 * 1000);

let woltWin = null;
let liveOrderWin = null;
let fertigWin = null;
let uberEatsWin = null;
let tienShipWin = null;

const appStartTime = Date.now();
ipcMain.handle('get-app-info', () => {
  return {
    name: 'ThaiAsia All In One',
    version: app.getVersion(),
    cwd: process.cwd(),
    env: process.env.NODE_ENV || 'production',
    startTime: appStartTime,
    uptime: Math.floor((Date.now() - appStartTime) / 1000)
  };
});

let isWoltLoggingIn = false;
async function performWoltNativeLogin(wc) {
  if (isWoltLoggingIn) return;
  if (!wc || wc.isDestroyed()) return;
  isWoltLoggingIn = true;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    logMain('[WoltLogin] Starting login polling...');
    // Poll up to 20 times (10s) for the login fields to appear
    let found = false;
    for (let i = 0; i < 20; i++) {
      if (wc.isDestroyed()) return;
      found = await wc.executeJavaScript(`
        (function() {
          var u = document.querySelector('input[aria-label="Benutzername"]') || Array.from(document.querySelectorAll('input, flt-semantics')).find(function(el) { return (el.getAttribute('aria-label') || '').trim() === 'Benutzername'; });
          var p = document.querySelector('input[aria-label="Passwort"]') || document.querySelector('input#current-password') || Array.from(document.querySelectorAll('input, flt-semantics')).find(function(el) { return (el.getAttribute('aria-label') || '').trim() === 'Passwort'; });
          return Boolean(u && p);
        })()
      `).catch(() => false);
      if (found) break;
      await sleep(500);
    }

    if (!found) {
      logMain('[WoltLogin] Login fields not found (already logged in or different page).');
      return;
    }

    // Wait a brief moment for Flutter layout to settle
    await sleep(600);
    if (wc.isDestroyed()) return;

    // 1. Focus and select username field
    const userFocused = await wc.executeJavaScript(`
      (function() {
        var u = document.querySelector('input[aria-label="Benutzername"]') || Array.from(document.querySelectorAll('input, flt-semantics')).find(function(el) { return (el.getAttribute('aria-label') || '').trim() === 'Benutzername'; });
        if (u) {
          u.focus();
          u.select();
          try { u.setSelectionRange(0, 999); } catch(e) {}
          console.log('[WoltLogin] Focused username input');
          return true;
        }
        return false;
      })()
    `).catch(() => false);

    if (!userFocused) return;
    await sleep(200);

    // Atomically insert username 'thaiss'
    await wc.insertText('thaiss');
    await sleep(200);

    // Verify username and fallback if needed
    await wc.executeJavaScript(`
      (function() {
        var u = document.querySelector('input[aria-label="Benutzername"]') || Array.from(document.querySelectorAll('input, flt-semantics')).find(function(el) { return (el.getAttribute('aria-label') || '').trim() === 'Benutzername'; });
        if (u && u.value !== 'thaiss') {
          u.focus();
          u.select();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, 'thaiss');
        }
        console.log('[WoltLogin] Username final value:', u ? u.value : 'null');
      })()
    `).catch(() => {});
    await sleep(300);

    // 2. Focus and select password field
    const passFocused = await wc.executeJavaScript(`
      (function() {
        var p = document.querySelector('input[aria-label="Passwort"]') || document.querySelector('input#current-password') || Array.from(document.querySelectorAll('input, flt-semantics')).find(function(el) { return (el.getAttribute('aria-label') || '').trim() === 'Passwort'; });
        if (p) {
          p.focus();
          p.select();
          try { p.setSelectionRange(0, 999); } catch(e) {}
          console.log('[WoltLogin] Focused password input');
          return true;
        }
        return false;
      })()
    `).catch(() => false);

    if (!passFocused) return;
    await sleep(200);

    // Atomically insert password 'z35x9hwkyb'
    await wc.insertText('z35x9hwkyb');
    await sleep(200);

    // Verify password and fallback if needed
    await wc.executeJavaScript(`
      (function() {
        var p = document.querySelector('input[aria-label="Passwort"]') || document.querySelector('input#current-password') || Array.from(document.querySelectorAll('input, flt-semantics')).find(function(el) { return (el.getAttribute('aria-label') || '').trim() === 'Passwort'; });
        if (p && p.value !== 'z35x9hwkyb') {
          p.focus();
          p.select();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, 'z35x9hwkyb');
        }
        console.log('[WoltLogin] Password final length:', p ? p.value.length : 'null');
      })()
    `).catch(() => {});
    await sleep(400);

    // 3. Submit via Return key
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await sleep(300);

    // 4. Submit via button click
    const btnPos = await wc.executeJavaScript(`
      (function() {
        var btn = Array.from(document.querySelectorAll('flt-semantics, button, [role="button"]')).find(function(el) {
          var txt = (el.textContent || '').trim();
          var aria = (el.getAttribute('aria-label') || '').trim();
          return txt === 'Einloggen' || aria === 'Einloggen';
        });
        if (btn) {
          var r = btn.getBoundingClientRect();
          var cx = Math.round(r.left + r.width / 2);
          var cy = Math.round(r.top + r.height / 2);
          try {
            ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(function(t) {
              btn.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
            });
          } catch(e) {}
          return { x: cx, y: cy };
        }
        return null;
      })()
    `).catch(() => null);

    if (btnPos && btnPos.x > 0 && btnPos.y > 0) {
      wc.sendInputEvent({ type: 'mouseDown', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: btnPos.x, y: btnPos.y, button: 'left', clickCount: 1 });
    }

    logMain('[WoltLogin] Completed Wolt native login submission.');
  } catch (err) {
    logMain('[WoltLogin] Error:', err);
  } finally {
    setTimeout(() => { isWoltLoggingIn = false; }, 5000);
  }
}

ipcMain.on('thaiasia-wolt-native-autologin', async () => {
  if (typeof woltWin === 'undefined' || !woltWin || woltWin.isDestroyed()) return;
  performWoltNativeLogin(woltWin.webContents);
});

ipcMain.on('tienship-report-sent', (_, details) => {
  logMain('[AutoShutdown] Received tienship-report-sent IPC:', JSON.stringify(details || {}));
  executeSafeShutdownSequence(details || {});
});

ipcMain.on('cancel-auto-shutdown', () => {
  logMain('[AutoShutdown] Received cancel-auto-shutdown IPC');
  cancelWindowsShutdown();
});

ipcMain.handle('get-auto-shutdown-config', () => readAutoShutdownConfig());

ipcMain.handle('set-auto-shutdown-config', (_, cfg) => {
  writeAutoShutdownConfig(cfg);
  return readAutoShutdownConfig();
});

const DEFAULT_PLATFORM_CREDENTIALS = {
  takeaway: {
    user: 'thaiasiasushibar',
    pass: 'Thaiasiasushibar@321'
  },
  wolt: {
    user: 'thaiss',
    pass: 'z35x9hwkyb'
  },
  ubereats: {
    user: 'thai-asia-sushi-bar@ubereats.com',
    pass: 'Thaiasiasushibar@321'
  },
  admin: {
    user: 'chinthaiba',
    pass: 'chinthaiba@321'
  }
};

function injectAutoLoginHelper(browserWin, serviceKey) {
  if (!browserWin || browserWin.isDestroyed()) return;
  const creds = DEFAULT_PLATFORM_CREDENTIALS[serviceKey];
  if (!creds) return;

  const script = `(function() {
    try {
      const userVal = ${JSON.stringify(creds.user)};
      const passVal = ${JSON.stringify(creds.pass)};
      const service = ${JSON.stringify(serviceKey)};

      function setNativeInputValue(el, val) {
        if (!el || val === undefined || val === null) return;
        el.focus();
        const prev = el.value;
        el.value = val;
        if (el._valueTracker) {
          try { el._valueTracker.setValue(prev); } catch (_) {}
        }
        try {
          const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : Object.getPrototypeOf(el);
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && descriptor.set) descriptor.set.call(el, val);
        } catch (_) {}
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
        el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
      }

      function clickBtn(btn) {
        if (!btn) return;
        btn.focus();
        ['mouseenter', 'mouseover', 'mousedown', 'mouseup', 'click'].forEach(evt => {
          try { btn.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })); } catch (_) {}
        });
        if (typeof btn.click === 'function') btn.click();
      }

      let lastActionAt = 0;

      function attemptFill() {
        const allInputs = Array.from(document.querySelectorAll('input')).filter(el => {
          try {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && el.type !== 'hidden' && !el.disabled;
          } catch (_) { return false; }
        });
        if (allInputs.length === 0) return;

        const passInput = allInputs.find(el => el.type === 'password' || (el.placeholder && el.placeholder.toLowerCase().includes('pass')) || el.name === 'password' || el.id === 'PASSWORD' || el.id === 'current-password')
          || document.querySelector('input[aria-label="Passwort"]');
        const userInput = document.querySelector('input[aria-label="Benutzername"]')
          || allInputs.find(el => el !== passInput && (
            (el.placeholder && (el.placeholder.toLowerCase().includes('benutzer') || el.placeholder.toLowerCase().includes('user') || el.placeholder.toLowerCase().includes('email'))) ||
            el.type === 'text' || el.type === 'email' || !el.type || el.name === 'textInput' || el.id === 'PHONE_NUMBER_or_EMAIL_ADDRESS' || el.name.toLowerCase().includes('user') || el.name.toLowerCase().includes('login')
          )) || (!passInput ? allInputs[0] : null);

        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(el => {
          try {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
          } catch (_) { return false; }
        });

        if (service === 'ubereats') {
          const forwardBtn = document.querySelector('#forward-button') || buttons.find(b => {
            const txt = (b.textContent || b.value || '').toLowerCase();
            return txt.includes('tiếp theo') || txt.includes('next') || txt.includes('weiter') || txt.includes('continue') || txt.includes('đăng nhập') || txt.includes('log in') || b.type === 'submit';
          }) || buttons[0];

          if (userInput && !passInput) {
            if (userInput.value !== userVal) setNativeInputValue(userInput, userVal);
            if (Date.now() - lastActionAt > 2000 && forwardBtn) {
              lastActionAt = Date.now();
              setTimeout(() => clickBtn(forwardBtn), 400);
            }
            return;
          }
          if (passInput) {
            if (passInput.value !== passVal) setNativeInputValue(passInput, passVal);
            if (Date.now() - lastActionAt > 2000 && forwardBtn) {
              lastActionAt = Date.now();
              setTimeout(() => clickBtn(forwardBtn), 400);
            }
            return;
          }
          return;
        }

        if (userInput && passInput) {
          if (userInput.value !== userVal) setNativeInputValue(userInput, userVal);
          if (passInput.value !== passVal) setNativeInputValue(passInput, passVal);

          if (Date.now() - lastActionAt > 2500) {
            // For Flutter/Wolt: Einloggen is an flt-semantics element, not a real button
            const submitBtn = buttons.find(b => {
              const txt = (b.textContent || b.value || '').toLowerCase();
              return txt.includes('einloggen') || txt.includes('log in') || txt.includes('sign in') || txt.includes('anmelden') || txt.includes('đăng nhập') || b.type === 'submit';
            }) || Array.from(document.querySelectorAll('flt-semantics')).find(el =>
              (el.textContent || '').trim() === 'Einloggen'
            ) || buttons[0];

            if (submitBtn) {
              lastActionAt = Date.now();
              setTimeout(() => clickBtn(submitBtn), 500);
            }
          }
        }
      }

      setInterval(attemptFill, 1000);
      attemptFill();
    } catch (_) {}
  })();`;

  browserWin.webContents.executeJavaScript(script).catch(() => {});
}

function createWindow() {
  migrateZoomPreferenceKey(LIVE_ORDERS_ZOOM_KEY, ['liveOrderWin', 'fertigWin']);

  function getWindowUrl(browserWin) {
    try { return browserWin.webContents.getURL() || 'about:blank'; } catch (_) { return 'destroyed'; }
  }
  function getWindowUrlShort(browserWin) {
    return shortenUrlForLog(getWindowUrl(browserWin));
  }

  function scheduleWindowReload(browserWin, label, reason, delayMs = 0, ignoreCache = false) {
    const runReload = () => {
      if (!browserWin || browserWin.isDestroyed()) return;
      const method = ignoreCache ? 'reloadIgnoringCache()' : 'reload()';
      logMain(`[Reload] ${label} -> ${method} reason=${clipLogText(reason, 200)} currentUrl=${getWindowUrlShort(browserWin)}`);
      try {
        if (ignoreCache && browserWin.webContents && !browserWin.webContents.isDestroyed()) {
          browserWin.webContents.reloadIgnoringCache();
        } else {
          browserWin.reload();
        }
      } catch (err) {
        logMain(`[Reload] ${label} ${method} failed:`, err);
      }
    };
    if (delayMs > 0) {
      logMain(`[Reload] ${label} scheduled in ${delayMs}ms reason=${clipLogText(reason, 200)}`);
      setTimeout(runReload, delayMs);
      return;
    }
    runReload();
  }

  function scheduleWindowReloadWhenIdle(browserWin, label, reason, delayMs = 0) {
    const checkAndReload = async () => {
      if (!browserWin || browserWin.isDestroyed()) return;
      let processing = null;
      try {
        const wc = browserWin.webContents;
        if (wc && !wc.isDestroyed()) {
          processing = await Promise.race([
            wc.executeJavaScript('Boolean(window.__thaiasiaOrderProcessing)', true),
            new Promise((resolve) => setTimeout(() => resolve(null), 1500))
          ]);
        }
      } catch (_) {}
      if (processing !== false) {
        emitMainDiag('live_push', {
          page: label,
          action: 'reload_deferred_processing',
          reason,
          processingState: processing === true ? 'processing' : 'unknown'
        });
        setTimeout(checkAndReload, 15 * 1000);
        return;
      }
      scheduleWindowReload(browserWin, label, reason);
    };
    setTimeout(checkAndReload, Math.max(0, delayMs));
  }

  function loadWindowUrl(browserWin, label, url, reason, delayMs = 0) {
    const runLoad = () => {
      if (!browserWin || browserWin.isDestroyed()) return;
      try { browserWin.loadURL(url); } catch (err) { logMain(`[Recovery] ${label} loadURL failed:`, err); }
    };
    if (delayMs > 0) {
      setTimeout(runLoad, delayMs);
      return;
    }
    runLoad();
  }

  function attachWindowDiagnostics(browserWin, label) {
    browserWin.on('unresponsive', () => {
      logMain(`[Health] ${label} window became unresponsive at ${getWindowUrlShort(browserWin)}`);
    });
    browserWin.on('responsive', () => {
      logMain(`[Health] ${label} window responsive again at ${getWindowUrlShort(browserWin)}`);
    });
    browserWin.webContents.on('render-process-gone', (_, details) => {
      logMain(`[Crash] ${label} render-process-gone`, {
        reason: details && details.reason,
        exitCode: details && details.exitCode,
        url: getWindowUrlShort(browserWin)
      });
    });
    browserWin.webContents.on('did-fail-load', (_, code, desc, url, isMainFrame) => {
      if (code === -3 || !isMainFrame) return;
      logMain(`[Load] ${label} did-fail-load code=${code} desc=${clipLogText(desc, 120)} url=${shortenUrlForLog(url)}`);
    });
    browserWin.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key && input.key.toLowerCase() === 'r'))) {
        logMain(`[Reload] ${label} reloaded manually by user (F5/Ctrl+R)`);
      }
    });
    browserWin.webContents.on('console-message', (_, level, message, line, sourceId) => {
      if (!shouldForwardRendererMessage(level, message)) return;
      const text = String(message || '');
      const rendered = text.toLowerCase().includes('[thaiasiadiag]')
        ? text
        : clipLogText(text, 220);
      logMain(`[Renderer:${label}][${consoleLevelName(level)}] ${rendered} @${sourceId || 'unknown'}:${line}`);
    });
  }

  function emitMainDiag(eventType, payload) {
    logMain('[ThaiAsiaDiag] ' + JSON.stringify({
      v: 1,
      module: 'main',
      eventType,
      ts: new Date().toISOString(),
      ...(payload || {})
    }));
  }

  function wakeTakeawayWindow(browserWin, label, reason) {
    if (!browserWin || browserWin.isDestroyed()) return false;
    try {
      if (label !== 'fertigWin' && label !== 'tienShipWin') {
        if (typeof browserWin.showInactive === 'function') browserWin.showInactive();
        else browserWin.show();
      }
    } catch (_) {}
    try {
      const wc = browserWin.webContents;
      if (wc && !wc.isDestroyed()) {
        if (typeof wc.setBackgroundThrottling === 'function') wc.setBackgroundThrottling(false);
        wc.executeJavaScript(`
          (function() {
            try { window.dispatchEvent(new Event('focus')); } catch (_) {}
            try { window.dispatchEvent(new Event('online')); } catch (_) {}
            try { document.dispatchEvent(new Event('visibilitychange')); } catch (_) {}
            try { document.body && document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 2, clientY: 2 })); } catch (_) {}
            return true;
          })();
        `, true).catch(() => {});
      }
    } catch (_) {}
    emitMainDiag('live_push', { page: label, action: 'main_wake', reason });
    return true;
  }

  function softRefreshTakeawayWindow(browserWin, label, reason) {
    if (!browserWin || browserWin.isDestroyed()) return false;
    try {
      const wc = browserWin.webContents;
      if (!wc || wc.isDestroyed()) return false;
      if (typeof wc.setBackgroundThrottling === 'function') wc.setBackgroundThrottling(false);
      wc.executeJavaScript(`
        (function() {
          try { window.dispatchEvent(new Event('focus')); } catch (_) {}
          try { window.dispatchEvent(new Event('online')); } catch (_) {}
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
          try { document.dispatchEvent(new Event('visibilitychange')); } catch (_) {}
          try { document.body && document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 8, clientY: 8 })); } catch (_) {}
          try {
            var url = String(location.href || '');
            history.replaceState(history.state, document.title, url);
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
          } catch (_) {}
          return true;
        })();
      `, true).catch(() => {});
      emitMainDiag('live_push', { page: label, action: 'main_soft_refresh', reason });
    } catch (_) {
      return false;
    }
  }

  function getFocusedOperationalLabel(windowsByLabel) {
    const focused = BrowserWindow.getFocusedWindow();
    if (!focused) return '';
    for (const [label, browserWin] of Object.entries(windowsByLabel || {})) {
      if (browserWin && browserWin === focused) return label;
    }
    return '';
  }

  function closeOperationalTabFromMenu(label, windowsByLabel, reason = 'menu-close-tab') {
    const displayName = operationalTabLabels[label] || label;
    if (!label || !Object.prototype.hasOwnProperty.call(operationalTabLabels, label)) {
      logMain(`[Menu] Ignored close tab request for unknown label=${label || ''}`);
      return false;
    }
    if (isOperationalTabDisabled(label)) {
      logMain(`[Menu] Tab already disabled label=${label}`);
      return false;
    }

    const browserWin = windowsByLabel && windowsByLabel[label];
    userDisabledOperationalTabs.add(label);
    if (windowsByLabel && Object.prototype.hasOwnProperty.call(windowsByLabel, label)) {
      delete windowsByLabel[label];
    }
    logMain(`[OperationalWindow] user disabled tab label=${label} name=${displayName} reason=${reason}`);
    emitMainDiag('operational_window', {
      page: label,
      action: 'user_disable_tab',
      reason,
      displayName
    });
    flushMainLogBufferSyncFallback();
    flushImportantEventBufferSyncFallback();

    try {
      if (browserWin && !browserWin.isDestroyed()) {
        browserWin.destroy();
      }
    } catch (err) {
      logMain(`[Menu] Failed to destroy disabled tab label=${label}:`, err);
    }
    return true;
  }

  function installOperationalTabMenu(windowsByLabel) {
    const switchToTab = (label) => {
      const target = windowsByLabel && windowsByLabel[label];
      if (target && !target.isDestroyed()) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      }
    };

    const tabSwitchItems = [
      {
        label: '1. Wolt (Lấy đơn Wolt)',
        accelerator: 'Ctrl+1',
        click: () => switchToTab('woltWin')
      },
      {
        label: '2. Live Orders (Nhận đơn Takeaway)',
        accelerator: 'Ctrl+2',
        click: () => switchToTab('liveOrderWin')
      },
      {
        label: '3. Auto Fertig (Tự động hoàn thành)',
        accelerator: 'Ctrl+3',
        click: () => switchToTab('fertigWin')
      },
      {
        label: '4. Uber Eats (Lấy đơn Uber)',
        accelerator: 'Ctrl+4',
        click: () => switchToTab('uberEatsWin')
      },
      {
        label: '5. Tiền Ship (Báo cáo Admin)',
        accelerator: 'Ctrl+5',
        click: () => switchToTab('tienShipWin')
      }
    ];

    const closeSpecificItems = Object.entries(operationalTabLabels)
      .filter(([label]) => Object.prototype.hasOwnProperty.call(windowsByLabel || {}, label))
      .map(([label, displayName]) => ({
        label: `${displayName}${isOperationalTabDisabled(label) ? ' (đã tắt)' : ''}`,
        enabled: !isOperationalTabDisabled(label),
        click: () => {
          closeOperationalTabFromMenu(label, windowsByLabel, 'menu-close-specific-tab');
          installOperationalTabMenu(windowsByLabel);
        }
      }));

    const template = [
      {
        label: '📁 Tabs (Chuyển Tab)',
        submenu: tabSwitchItems
      },
      {
        label: 'File',
        submenu: [
          {
            label: 'Tắt tab hiện tại',
            accelerator: 'CmdOrCtrl+Shift+W',
            click: () => {
              const label = getFocusedOperationalLabel(windowsByLabel);
              if (!label) return;
              closeOperationalTabFromMenu(label, windowsByLabel, 'menu-close-current-tab');
              installOperationalTabMenu(windowsByLabel);
            }
          },
          {
            label: 'Tắt 1 tab',
            submenu: closeSpecificItems
          },
          { type: 'separator' },
          {
            label: 'Khởi động lại app (mở lại tab đã tắt)',
            click: () => triggerRelaunch('menu-restart-open-disabled-tabs')
          },
          { type: 'separator' },
          {
            label: 'Thoát app',
            click: () => quitAppAndStopWatchdog('menu-quit-app')
          }
        ]
      },
      {
        label: 'Auto Update',
        submenu: [
          {
            label: `Phiên bản hiện tại: ${app.getVersion()}`,
            enabled: false
          },
          { type: 'separator' },
          {
            label: 'Cấu hình GitHub…',
            click: () => autoUpdateManager && autoUpdateManager.openSettingsWindow()
          },
          {
            label: 'Kiểm tra cập nhật ngay',
            click: () => autoUpdateManager && autoUpdateManager.checkNow({ interactive: true })
          }
        ]
      },
      {
        label: 'Tắt máy (Auto Shutdown)',
        submenu: [
          {
            label: `Tự động tắt máy sau khi gửi Báo Cáo: ${readAutoShutdownConfig().enabled ? 'ĐANG BẬT ✅' : 'ĐANG TẮT ❌'}`,
            type: 'checkbox',
            checked: readAutoShutdownConfig().enabled,
            click: (item) => {
              const curr = readAutoShutdownConfig();
              curr.enabled = !!item.checked;
              writeAutoShutdownConfig(curr);
              logMain(`[AutoShutdown] Toggle auto shutdown: ${curr.enabled}`);
              installOperationalTabMenu(windowsByLabel);
            }
          },
          { type: 'separator' },
          {
            label: '🧪 Thử nghiệm tắt máy ngay lập tức (Test shutdown /t 0)',
            click: () => {
              const confirmed = dialog.showMessageBoxSync({
                type: 'warning',
                buttons: ['Tắt máy ngay lập tức', 'Hủy'],
                defaultId: 0,
                cancelId: 1,
                title: 'Xác nhận test tắt máy ngay',
                message: 'Máy tính sẽ thực hiện lệnh tắt máy ngay lập tức (shutdown /s /f /t 0).\n\nBạn có chắc chắn muốn test tắt máy ngay không?'
              });
              if (confirmed === 0) {
                executeSafeShutdownSequence({ force: true, immediate: true, countdownSeconds: 0, reportDate: 'TEST-THỬ-NGHIỆM' });
              }
            }
          },
          {
            label: '🛑 HỦY lệnh tắt máy ngay lập tức (shutdown /a)',
            click: () => {
              cancelWindowsShutdown();
            }
          }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          {
            label: 'Tải lại trang (Reload)',
            accelerator: 'F5',
            click: (_, browserWindow) => {
              const target = browserWindow || BrowserWindow.getFocusedWindow();
              if (!target || target.isDestroyed() || !target.webContents || target.webContents.isDestroyed()) return;
              logMain(`[Reload] ${target.getTitle ? target.getTitle() : 'window'} F5 -> reload()`);
              target.webContents.reload();
            }
          },
          {
            label: 'Tải lại bỏ cache (Hard Reload)',
            accelerator: 'Ctrl+F5',
            click: (_, browserWindow) => {
              const target = browserWindow || BrowserWindow.getFocusedWindow();
              if (!target || target.isDestroyed() || !target.webContents || target.webContents.isDestroyed()) return;
              logMain(`[Reload] ${target.getTitle ? target.getTitle() : 'window'} Ctrl+F5 -> reloadIgnoringCache()`);
              target.webContents.reloadIgnoringCache();
            }
          },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'close' }
        ]
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Mở thư mục reports',
            click: () => logMain(`[Menu] Reports folder: ${APP_REPORTS_DIR}`)
          }
        ]
      }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function startTakeawayKeepAliveMonitor(windowsByLabel) {
    const CHECK_INTERVAL_MS = 2500;
    const RENDERER_DEAD_MS = 35 * 1000;
    const ORDER_SOCKET_WAKE_MS = 55 * 1000;
    const ORDER_SOCKET_SOFT_MS = 70 * 1000;
    const ORDER_SOCKET_RELOAD_MS = 90 * 1000;
    const SOCKET_DISCONNECTED_RELOAD_MS = 20 * 1000;
    const ORDER_SOCKET_MISSING_WAKE_MS = 60 * 1000;
    const ORDER_SOCKET_MISSING_SOFT_MS = 80 * 1000;
    const ORDER_SOCKET_MISSING_RELOAD_MS = 100 * 1000;
    const BUSINESS_PARITY_GRACE_MS = 5 * 1000;
    const BUSINESS_PARITY_LOOKBACK_MS = 45 * 1000;
    const BUSINESS_PARITY_MATCH_MS = 6 * 1000;
    const VISIBLE_ORDER_UNHANDLED_MS = 12 * 1000;
    const SERVER_ORDER_DOM_GRACE_MS = 5 * 1000;
    const SERVER_ORDER_PROCESS_GRACE_MS = 12 * 1000;
    const SERVER_ORDER_SECOND_RECOVERY_MS = 15 * 1000;
    const SERVER_ORDER_RECOVERY_COOLDOWN_MS = 60 * 1000;
    const CANARY_AUTH_FAILURE_GRACE_MS = 20 * 1000;
    const CANARY_GENERAL_FAILURE_GRACE_MS = 45 * 1000;
    const CANARY_ENDPOINT_MISSING_GRACE_MS = 90 * 1000;
    const CANARY_COMBINED_FAILURE_GRACE_MS = 45 * 1000;
    const CANARY_LIVE_CHANNEL_FRESH_MS = 2 * 60 * 1000;
    const CANARY_POLICY_LOG_COOLDOWN_MS = 5 * 60 * 1000;
    const CANARY_SECOND_RECOVERY_MS = 30 * 1000;
    const CANARY_REPEAT_RECOVERY_MS = 2 * 60 * 1000;
    const RELOAD_COOLDOWN_MS = 30 * 1000;
    const URGENT_RELOAD_COOLDOWN_MS = 15 * 1000;
    const ACTION_LOG_COOLDOWN_MS = 30 * 1000;
    const recoveryByPage = new Map();
    const canaryRecovery = {
      stage: 0,
      recoveryAt: 0,
      reason: ''
    };
    let monitorBusy = false;

    async function readRendererSafetyState(browserWin, trackedOrderCodes = []) {
      if (!browserWin || browserWin.isDestroyed()) return null;
      try {
        const wc = browserWin.webContents;
        if (!wc || wc.isDestroyed()) return null;
        const codesJson = JSON.stringify(
          trackedOrderCodes.map(normalizeTakeawayOrderCode).filter(Boolean).slice(0, 20)
        );
        return await Promise.race([
          wc.executeJavaScript(`
            (function () {
              var acceptButtonCount = 0;
              var visibleOrderCodes = [];
              try {
                acceptButtonCount = Array.from(document.querySelectorAll('button,a,div[role="button"],span[role="button"]'))
                  .filter(function (el) {
                    return /^(annehmen|accept)$/i.test(String(el.innerText || el.textContent || '').trim());
                  }).length;
              } catch (_) {}
              try {
                var bodyText = String(document.body && (document.body.innerText || document.body.textContent) || '').toUpperCase();
                var trackedCodes = ${codesJson};
                visibleOrderCodes = trackedCodes.filter(function (code) { return bodyText.indexOf(code) >= 0; });
              } catch (_) {}
              return {
                processing: Boolean(window.__thaiasiaOrderProcessing),
                acceptButtonCount: acceptButtonCount,
                visibleOrderCodes: visibleOrderCodes
              };
            })()
          `, true),
          new Promise((resolve) => setTimeout(() => resolve(null), 1500))
        ]);
      } catch (_) {
        return null;
      }
    }

    function getRecovery(label) {
      const current = recoveryByPage.get(label) || {
        reason: '',
        firstDetectedAt: 0,
        lastWakeAt: 0,
        lastSoftAt: 0,
        lastReloadAt: 0,
        lastDeferredLogAt: 0,
        handledStrongEvidenceAt: 0,
        handledCrossBusinessAt: 0,
        visibleOrderFirstSeenAt: 0
      };
      recoveryByPage.set(label, current);
      return current;
    }

    function resetWeakRecovery(recovery) {
      recovery.reason = '';
      recovery.firstDetectedAt = 0;
      recovery.lastWakeAt = 0;
      recovery.lastSoftAt = 0;
    }

    async function requestHealthReload(browserWin, label, reason, details, recoveryMode = 'reload') {
      const nowTs = Date.now();
      const recovery = getRecovery(label);
      const urgent = /^strong-evidence:|^cross-tab-business-stream-mismatch$|^visible-order-unhandled$|^server-order-|^orders-canary-/.test(reason);
      const reloadCooldownMs = urgent ? URGENT_RELOAD_COOLDOWN_MS : RELOAD_COOLDOWN_MS;
      if (nowTs - recovery.lastReloadAt < reloadCooldownMs) return false;

      const runtime = livePushRuntimeState.get(label) || {};
      const rendererStates = {};
      let processingPage = '';
      for (const [candidateLabel, candidateWin] of Object.entries(windowsByLabel)) {
        const candidateState = await readRendererSafetyState(candidateWin);
        rendererStates[candidateLabel] = candidateState;
        const candidateRuntime = livePushRuntimeState.get(candidateLabel) || {};
        const heartbeatAt = Number(candidateRuntime.rendererHeartbeatAt || 0);
        const runtimeProcessingIsFresh = candidateRuntime.processing === true
          && heartbeatAt > 0
          && nowTs - heartbeatAt <= 20 * 1000;
        const candidateProcessing = candidateState
          ? candidateState.processing === true
          : runtimeProcessingIsFresh;
        if (candidateProcessing && !processingPage) processingPage = candidateLabel;
      }
      const rendererState = rendererStates[label] || null;
      if (processingPage) {
        if (nowTs - recovery.lastDeferredLogAt >= ACTION_LOG_COOLDOWN_MS) {
          recovery.lastDeferredLogAt = nowTs;
          emitMainDiag('live_push', {
            page: label,
            action: 'reload_deferred_processing',
            reason,
            processingPage,
            details: details || {}
          });
        }
        return false;
      }
      const liveAcceptButtonCount = label === 'liveOrderWin' && rendererState
        ? Number(rendererState.acceptButtonCount || 0)
        : 0;
      const serverOrderEvidence = /^server-order-/.test(reason);
      if (liveAcceptButtonCount > 0
          && reason !== 'visible-order-unhandled'
          && !serverOrderEvidence) {
        if (!recovery.visibleOrderFirstSeenAt) recovery.visibleOrderFirstSeenAt = nowTs;
        if (nowTs - recovery.lastDeferredLogAt >= ACTION_LOG_COOLDOWN_MS) {
          recovery.lastDeferredLogAt = nowTs;
          emitMainDiag('live_push', {
            page: label,
            action: 'reload_deferred_visible_order',
            reason,
            acceptButtonCount: liveAcceptButtonCount
          });
        }
        return false;
      }

      recovery.lastReloadAt = nowTs;
      const action = recoveryMode === 'load-url'
        ? 'browserWindow.loadURL'
        : 'webContents.reloadIgnoringCache';
      emitMainDiag('reload', {
        page: label,
        reason,
        action,
        details: details || {}
      });
      if (recoveryMode === 'load-url') {
        loadWindowUrl(
          browserWin,
          label,
          'https://live-orders.takeaway.com/orders',
          reason
        );
      } else {
        scheduleWindowReload(browserWin, label, reason, 0, true);
      }
      resetWeakRecovery(recovery);
      return true;
    }

    function findCrossTabBusinessMismatch(label, nowTs) {
      const sourceLabel = label === 'liveOrderWin' ? 'fertigWin' : 'liveOrderWin';
      const source = livePushRuntimeState.get(sourceLabel) || {};
      const target = livePushRuntimeState.get(label) || {};
      const targetProbeInstalledAt = Number(target.probeInstalledAt || 0);
      const sourceEvents = (Array.isArray(source.businessEvents) ? source.businessEvents : [])
        .filter((item) => {
          const eventAt = Number(item && item.at || 0);
          const age = nowTs - Number(item && item.at || 0);
          return eventAt >= targetProbeInstalledAt
            && age >= BUSINESS_PARITY_GRACE_MS
            && age <= BUSINESS_PARITY_LOOKBACK_MS;
        });
      if (!sourceEvents.length) return null;
      const targetEvents = Array.isArray(target.businessEvents) ? target.businessEvents : [];
      const unmatched = sourceEvents.filter((sourceEvent) => !targetEvents.some((targetEvent) => (
        targetEvent
        && targetEvent.eventName === sourceEvent.eventName
        && Math.abs(Number(targetEvent.at || 0) - Number(sourceEvent.at || 0)) <= BUSINESS_PARITY_MATCH_MS
      )));
      if (!unmatched.length) return null;

      // One missed creation event is enough to protect the receiving/accepting tab.
      const missedCreation = label === 'liveOrderWin'
        ? unmatched.find((item) => /(created|new|placed|received|incoming)/i.test(item.eventName))
        : null;
      if (missedCreation) {
        return {
          sourceLabel,
          evidenceAt: Number(missedCreation.at || 0),
          eventName: missedCreation.eventName,
          unmatchedCount: 1
        };
      }

      // Updates produced by Autofertig are not evidence that the receiving tab
      // missed a new order. Only a missed creation can reload liveOrderWin.
      if (label === 'liveOrderWin') return null;

      // For other updates require two independent misses. This avoids reloading
      // because one subscription legitimately received a single extra update.
      const missedUpdates = unmatched.filter((item) => /orderupdated/i.test(item.eventName));
      if (missedUpdates.length < 2) return null;
      const latest = missedUpdates[missedUpdates.length - 1];
      return {
        sourceLabel,
        evidenceAt: Number(latest.at || 0),
        eventName: latest.eventName,
        unmatchedCount: missedUpdates.length
      };
    }

    function resetCanaryRecovery() {
      canaryRecovery.stage = 0;
      canaryRecovery.recoveryAt = 0;
      canaryRecovery.reason = '';
    }

    function getCanaryTransportEvidence(runtime, nowTs) {
      const state = runtime || {};
      const rendererHeartbeatAt = Number(state.rendererHeartbeatAt || 0);
      const rendererFresh = rendererHeartbeatAt > 0
        && nowTs - rendererHeartbeatAt <= RENDERER_DEAD_MS;
      const channelHealthy = (socket) => {
        if (!socket || socket.open !== true) return false;
        const messageAgeMs = socket.lastMessageAgeMs == null ? null : Number(socket.lastMessageAgeMs);
        const openedAgeMs = socket.openedAgeMs == null ? null : Number(socket.openedAgeMs);
        if (Number.isFinite(messageAgeMs)) return messageAgeMs <= CANARY_LIVE_CHANNEL_FRESH_MS;
        return Number.isFinite(openedAgeMs) && openedAgeMs <= CANARY_LIVE_CHANNEL_FRESH_MS;
      };
      const orderSocketHealthy = channelHealthy(state.orderSocket);
      const mqttSocketHealthy = channelHealthy(state.mqttSocket);
      return {
        healthy: rendererFresh && (orderSocketHealthy || mqttSocketHealthy),
        rendererFresh,
        rendererHeartbeatAgeMs: rendererHeartbeatAt > 0 ? nowTs - rendererHeartbeatAt : null,
        orderSocketHealthy,
        mqttSocketHealthy
      };
    }

    async function evaluateCanaryAvailability(liveOrderWin, nowTs) {
      if (!liveOrderWin || liveOrderWin.isDestroyed()) return;
      if (!takeawayOrdersCanaryState.installed) return;

      const runtime = livePushRuntimeState.get('liveOrderWin') || {};
      if (runtime.pageOperational !== true) return;

      const installedAt = Number(takeawayOrdersCanaryState.installedAt || 0);
      const endpointCapturedAt = Number(takeawayOrdersCanaryState.endpointCapturedAt || 0);
      const lastPollOkAt = Number(takeawayOrdersCanaryState.lastPollOkAt || 0);
      const failureSince = Number(takeawayOrdersCanaryState.failureSince || 0);
      const lastFailureAt = Number(takeawayOrdersCanaryState.lastFailureAt || 0);
      const consecutiveFailures = Number(takeawayOrdersCanaryState.consecutiveFailures || 0);
      const lastError = String(takeawayOrdersCanaryState.lastError || '');
      const endpointMissing = !takeawayOrdersCanaryState.endpoint;
      const authFailure = /^HTTP_(401|403)$/.test(lastError);
      const failureIsCurrent = failureSince > 0
        && lastFailureAt >= lastPollOkAt
        && consecutiveFailures >= 3;

      if (!endpointMissing && !failureIsCurrent) {
        resetCanaryRecovery();
        return;
      }

      if (authFailure && failureIsCurrent
          && nowTs - Number(takeawayOrdersCanaryState.lastTokenRefreshTriggeredAt || 0) >= TAKEAWAY_CANARY_TOKEN_REFRESH_RETRY_MS) {
        takeawayOrdersCanaryState.lastTokenRefreshTriggeredAt = nowTs;
        if (typeof triggerTakeawayTokenRefresh === 'function') {
          try { triggerTakeawayTokenRefresh(); } catch (_) {}
        }
      }

      let unavailableSince = failureSince;
      let graceMs = authFailure
        ? CANARY_AUTH_FAILURE_GRACE_MS
        : CANARY_GENERAL_FAILURE_GRACE_MS;
      let reason = authFailure
        ? 'orders-canary-auth-unavailable'
        : 'orders-canary-unavailable';

      if (endpointMissing) {
        unavailableSince = endpointCapturedAt || installedAt;
        graceMs = CANARY_ENDPOINT_MISSING_GRACE_MS;
        reason = 'orders-canary-endpoint-missing';
      }
      if (!unavailableSince || nowTs - unavailableSince < graceMs) return;

      const transport = getCanaryTransportEvidence(runtime, nowTs);
      if (transport.healthy) {
        // A stale/expired canary token is not proof that the operational page is
        // dead. Keep trying token refresh, but preserve the healthy order stream.
        resetCanaryRecovery();
        if (nowTs - Number(takeawayOrdersCanaryState.lastPolicyLogAt || 0) >= CANARY_POLICY_LOG_COOLDOWN_MS) {
          takeawayOrdersCanaryState.lastPolicyLogAt = nowTs;
          emitMainDiag('live_push', {
            page: 'liveOrderWin',
            action: 'orders_canary_reload_suppressed_healthy',
            reason,
            lastError,
            consecutiveFailures,
            unavailableAgeMs: nowTs - unavailableSince,
            transport
          });
        }
        return;
      }

      // Reload only when canary failure and transport health failure are two
      // independent signals. The normal renderer/socket monitor remains active
      // and can recover first if it has stronger, more specific evidence.
      const probeInstalledAt = Number(runtime.probeInstalledAt || 0);
      if (!probeInstalledAt || nowTs - probeInstalledAt < CANARY_COMBINED_FAILURE_GRACE_MS) return;
      graceMs = Math.max(graceMs, CANARY_COMBINED_FAILURE_GRACE_MS);
      if (nowTs - unavailableSince < graceMs) return;
      reason = authFailure
        ? 'orders-canary-auth-and-transport-unhealthy'
        : (endpointMissing
          ? 'orders-canary-endpoint-and-transport-unhealthy'
          : 'orders-canary-and-transport-unhealthy');

      if (canaryRecovery.stage >= 2
          && nowTs - canaryRecovery.recoveryAt >= CANARY_REPEAT_RECOVERY_MS) {
        resetCanaryRecovery();
      }

      if (canaryRecovery.stage === 0) {
        const reloaded = await requestHealthReload(
          liveOrderWin,
          'liveOrderWin',
          reason,
          {
            lastError,
            consecutiveFailures,
            unavailableAgeMs: nowTs - unavailableSince,
            lastPollOkAgeMs: lastPollOkAt > 0 ? nowTs - lastPollOkAt : null
          }
        );
        if (reloaded) {
          canaryRecovery.stage = 1;
          canaryRecovery.recoveryAt = nowTs;
          canaryRecovery.reason = reason;
        }
        return;
      }

      if (canaryRecovery.stage === 1
          && nowTs - canaryRecovery.recoveryAt >= CANARY_SECOND_RECOVERY_MS) {
        const loaded = await requestHealthReload(
          liveOrderWin,
          'liveOrderWin',
          'orders-canary-still-unavailable',
          {
            firstReason: canaryRecovery.reason,
            lastError,
            consecutiveFailures,
            firstRecoveryAgeMs: nowTs - canaryRecovery.recoveryAt
          },
          'load-url'
        );
        if (loaded) {
          canaryRecovery.stage = 2;
          canaryRecovery.recoveryAt = nowTs;
        }
      }
    }

    async function evaluateServerOrderEvidence(liveOrderWin, nowTs) {
      if (!liveOrderWin || liveOrderWin.isDestroyed()) return;
      if (!takeawayOrdersCanaryState.endpoint) return;
      if (nowTs - Number(takeawayOrdersCanaryState.lastPollOkAt || 0) > 15 * 1000) return;

      for (const entry of takeawayOrdersCanaryState.pendingOrders.values()) {
        if (!entry || nowTs - Number(entry.lastSeenAt || 0) > 12 * 1000) continue;
        if (entry.acknowledgedAt > 0) continue;
        if (entry.cooldownUntil > nowTs) continue;
        if (entry.cooldownUntil > 0 && nowTs >= entry.cooldownUntil) {
          entry.recoveryStage = 0;
          entry.recoveryAt = 0;
          entry.cooldownUntil = 0;
          entry.domSeenAt = 0;
          entry.firstSeenAt = nowTs;
        }

        const code = normalizeTakeawayOrderCode(entry.code);
        if (!code) continue;
        const runtime = livePushRuntimeState.get('liveOrderWin') || {};
        const handled = String(runtime.lastOrderCode || '').toUpperCase() === code
          && Number(runtime.lastConfirmedOrderActivityAt || 0) >= Number(entry.firstSeenAt || 0);
        if (handled) {
          entry.acknowledgedAt = Number(runtime.lastConfirmedOrderActivityAt || nowTs);
          emitMainDiag('live_push', {
            page: 'liveOrderWin',
            action: 'server_order_acknowledged',
            orderCode: code,
            matchedBy: 'order_activity'
          });
          continue;
        }

        const rendererState = await readRendererSafetyState(liveOrderWin, [code]);
        const processing = rendererState && rendererState.processing === true;
        const acceptButtonCount = rendererState ? Number(rendererState.acceptButtonCount || 0) : 0;
        const visibleCodes = rendererState && Array.isArray(rendererState.visibleOrderCodes)
          ? rendererState.visibleOrderCodes
          : [];
        const visible = visibleCodes.includes(code);

        if (processing) continue;
        if (visible) {
          if (!entry.domSeenAt) entry.domSeenAt = nowTs;
          if (nowTs - entry.domSeenAt < SERVER_ORDER_PROCESS_GRACE_MS) continue;
        } else {
          entry.domSeenAt = 0;
          if (nowTs - Number(entry.firstSeenAt || nowTs) < SERVER_ORDER_DOM_GRACE_MS) continue;
        }

        if (entry.recoveryStage === 0) {
          const reloaded = await requestHealthReload(
            liveOrderWin,
            'liveOrderWin',
            visible ? 'server-order-visible-not-processing' : 'server-order-missing-from-dom',
            {
              orderCode: code,
              serverSeenAgeMs: nowTs - Number(entry.firstSeenAt || nowTs),
              visible
            }
          );
          if (reloaded) {
            entry.recoveryStage = 1;
            entry.recoveryAt = nowTs;
            entry.domSeenAt = 0;
          }
          return;
        }

        if (entry.recoveryStage === 1
            && nowTs - Number(entry.recoveryAt || nowTs) >= SERVER_ORDER_SECOND_RECOVERY_MS) {
          const currentRuntime = livePushRuntimeState.get('liveOrderWin') || {};
          const pageReloaded = Number(currentRuntime.probeInstalledAt || 0) > Number(entry.recoveryAt || 0);
          if (!pageReloaded) continue;
          const loaded = await requestHealthReload(
            liveOrderWin,
            'liveOrderWin',
            'server-order-missing-after-reload',
            {
              orderCode: code,
              firstRecoveryAt: Number(entry.recoveryAt || 0)
            },
            'load-url'
          );
          if (loaded) {
            entry.recoveryStage = 2;
            entry.recoveryAt = nowTs;
            entry.cooldownUntil = nowTs + SERVER_ORDER_RECOVERY_COOLDOWN_MS;
          }
          return;
        }
      }
    }

    async function evaluateWindow(label, browserWin, nowTs) {
      if (!browserWin || browserWin.isDestroyed()) return;
      const st = livePushRuntimeState.get(label);
      if (!st) return;
      const recovery = getRecovery(label);

      // Strong evidence: renderer stopped, or server/push has a concrete order
      // that did not reach DOM/processing within its grace period.
      if (Number(st.strongEvidenceAt || 0) > Number(recovery.handledStrongEvidenceAt || 0)) {
        const evidenceAt = Number(st.strongEvidenceAt);
        const reloaded = await requestHealthReload(
          browserWin,
          label,
          `strong-evidence:${st.strongEvidenceReason || 'unknown'}`,
          {
            evidenceAt,
            orderCode: st.strongEvidenceOrderCode || ''
          }
        );
        if (reloaded) recovery.handledStrongEvidenceAt = evidenceAt;
        return;
      }

      const crossMismatch = findCrossTabBusinessMismatch(label, nowTs);
      if (crossMismatch
          && crossMismatch.evidenceAt > Number(recovery.handledCrossBusinessAt || 0)) {
        const reloaded = await requestHealthReload(
          browserWin,
          label,
          'cross-tab-business-stream-mismatch',
          crossMismatch
        );
        if (reloaded) recovery.handledCrossBusinessAt = crossMismatch.evidenceAt;
        return;
      }

      const rendererHeartbeatAt = Number(st.rendererHeartbeatAt || 0);
      const probeInstalledAt = Number(st.probeInstalledAt || 0);
      const rendererHeartbeatAgeMs = rendererHeartbeatAt > 0
        ? nowTs - rendererHeartbeatAt
        : (probeInstalledAt > 0 ? nowTs - probeInstalledAt : 0);
      if (probeInstalledAt > 0 && rendererHeartbeatAgeMs >= RENDERER_DEAD_MS) {
        await requestHealthReload(browserWin, label, 'renderer-heartbeat-lost', {
          rendererHeartbeatAgeMs,
          heartbeatNeverReceived: rendererHeartbeatAt <= 0
        });
        return;
      }

      // A visible pending order must be picked up quickly. If the queue script
      // does not start, reload is safer than leaving an order unattended.
      if (label === 'liveOrderWin') {
        const acceptButtonCount = Number(st.acceptButtonCount || 0);
        if (acceptButtonCount > 0 && st.processing !== true) {
          if (!recovery.visibleOrderFirstSeenAt) recovery.visibleOrderFirstSeenAt = nowTs;
          const lastOrderActivityAt = Number(st.lastOrderActivityAt || 0);
          const lastOrderActivityAction = String(st.lastOrderActivityAction || '');
          if (lastOrderActivityAt > recovery.visibleOrderFirstSeenAt
              && /send_result|accept_|cycle_done|resume_accept/i.test(lastOrderActivityAction)) {
            recovery.visibleOrderFirstSeenAt = lastOrderActivityAt;
          }
          const visibleOrderAgeMs = nowTs - recovery.visibleOrderFirstSeenAt;
          if (visibleOrderAgeMs >= VISIBLE_ORDER_UNHANDLED_MS) {
            await requestHealthReload(browserWin, label, 'visible-order-unhandled', {
              acceptButtonCount,
              visibleOrderAgeMs,
              thresholdMs: VISIBLE_ORDER_UNHANDLED_MS
            });
            return;
          }
          return;
        } else {
          recovery.visibleOrderFirstSeenAt = 0;
        }
      }

      // Allow initial page/socket setup before judging the order channel.
      if (!probeInstalledAt || nowTs - probeInstalledAt < 30 * 1000) return;
      const probeAgeMs = nowTs - probeInstalledAt;
      const orderSocket = st.orderSocket || {};
      const socketPresent = !!orderSocket.present;
      const socketOpen = !!orderSocket.open;
      const socketEverOpened = Number(st.orderSocketOpenedAt || 0) > 0;
      const socketMissing = st.pageOperational === true && !socketPresent && !socketEverOpened;
      const messageAgeMs = orderSocket.lastMessageAgeMs == null ? null : Number(orderSocket.lastMessageAgeMs);
      const openedAgeMs = orderSocket.openedAgeMs == null ? null : Number(orderSocket.openedAgeMs);
      const disconnectedAgeMs = orderSocket.disconnectedAgeMs == null ? null : Number(orderSocket.disconnectedAgeMs);
      const effectiveMessageAgeMs = Number.isFinite(messageAgeMs) ? messageAgeMs : openedAgeMs;
      const missingOrDisconnected = (socketPresent && !socketOpen) || (!socketPresent && socketEverOpened);
      const messageStale = socketOpen && (
        Number.isFinite(effectiveMessageAgeMs) && effectiveMessageAgeMs >= ORDER_SOCKET_WAKE_MS
      );

      if (socketMissing && probeAgeMs < ORDER_SOCKET_MISSING_WAKE_MS) {
        resetWeakRecovery(recovery);
        return;
      }
      if ((!socketMissing && !socketPresent && !socketEverOpened)
          || (!socketMissing && !missingOrDisconnected && !messageStale)) {
        resetWeakRecovery(recovery);
        return;
      }

      const reason = socketMissing
        ? 'orders-socket-missing'
        : (missingOrDisconnected ? 'orders-socket-disconnected' : 'orders-socket-message-stale');
      if (recovery.reason !== reason) {
        resetWeakRecovery(recovery);
        recovery.reason = reason;
        recovery.firstDetectedAt = nowTs;
      }
      const detectedAgeMs = nowTs - recovery.firstDetectedAt;

      if (!recovery.lastWakeAt) {
        if (wakeTakeawayWindow(browserWin, label, `${reason}:first-detected`)) {
          recovery.lastWakeAt = nowTs;
        }
        return;
      }

      const shouldSoftRecover = socketMissing
        ? probeAgeMs >= ORDER_SOCKET_MISSING_SOFT_MS
        : (missingOrDisconnected
          ? detectedAgeMs >= 10 * 1000
          : Number.isFinite(effectiveMessageAgeMs) && effectiveMessageAgeMs >= ORDER_SOCKET_SOFT_MS);
      if (shouldSoftRecover && !recovery.lastSoftAt) {
        if (softRefreshTakeawayWindow(browserWin, label, `${reason}:wake-did-not-recover`)) {
          recovery.lastSoftAt = nowTs;
        }
        return;
      }

      const disconnectedTooLong = missingOrDisconnected
        && (Number.isFinite(disconnectedAgeMs)
          ? disconnectedAgeMs >= SOCKET_DISCONNECTED_RELOAD_MS
          : detectedAgeMs >= SOCKET_DISCONNECTED_RELOAD_MS);
      const messageStillStale = !missingOrDisconnected
        && Number.isFinite(effectiveMessageAgeMs)
        && effectiveMessageAgeMs >= ORDER_SOCKET_RELOAD_MS;
      const socketStillMissing = socketMissing && probeAgeMs >= ORDER_SOCKET_MISSING_RELOAD_MS;

      // Weak socket evidence only reaches reload after wake and soft recovery
      // both failed, giving two independent observations instead of one timer.
      if (recovery.lastSoftAt && (socketStillMissing || disconnectedTooLong || messageStillStale)) {
        await requestHealthReload(browserWin, label, `${reason}:recovery-failed`, {
          detectedAgeMs,
          probeAgeMs,
          messageAgeMs: Number.isFinite(messageAgeMs) ? messageAgeMs : null,
          openedAgeMs: Number.isFinite(openedAgeMs) ? openedAgeMs : null,
          disconnectedAgeMs: Number.isFinite(disconnectedAgeMs) ? disconnectedAgeMs : null
        });
      }
    }

    emitMainDiag('live_push', {
      page: 'liveOrderWin',
      action: 'evidence_recovery_policy_active',
      checkIntervalMs: CHECK_INTERVAL_MS,
      ordersCanaryPollMs: 5000,
      serverOrderDomGraceMs: SERVER_ORDER_DOM_GRACE_MS,
      serverOrderProcessGraceMs: SERVER_ORDER_PROCESS_GRACE_MS,
      serverOrderSecondRecoveryMs: SERVER_ORDER_SECOND_RECOVERY_MS,
      canaryAuthFailureGraceMs: CANARY_AUTH_FAILURE_GRACE_MS,
      canaryGeneralFailureGraceMs: CANARY_GENERAL_FAILURE_GRACE_MS,
      canaryCombinedFailureGraceMs: CANARY_COMBINED_FAILURE_GRACE_MS,
      canaryLiveChannelFreshMs: CANARY_LIVE_CHANNEL_FRESH_MS,
      canarySecondRecoveryMs: CANARY_SECOND_RECOVERY_MS,
      canaryRepeatRecoveryMs: CANARY_REPEAT_RECOVERY_MS,
      canaryFailSafeEnabled: true,
      visibleOrderUnhandledMs: VISIBLE_ORDER_UNHANDLED_MS,
      businessParityGraceMs: BUSINESS_PARITY_GRACE_MS,
      quietTimeReloadEnabled: false,
      globalProcessingReloadProtection: true
    });

    setInterval(async () => {
      if (monitorBusy) return;
      monitorBusy = true;
      try {
        const nowTs = Date.now();
        await evaluateCanaryAvailability(windowsByLabel.liveOrderWin, nowTs);
        await evaluateServerOrderEvidence(windowsByLabel.liveOrderWin, nowTs);
        for (const [label, browserWin] of Object.entries(windowsByLabel)) {
          await evaluateWindow(label, browserWin, nowTs);
        }
      } finally {
        monitorBusy = false;
      }
    }, CHECK_INTERVAL_MS);
  }

  let operationalWindowBounds = { width: 1280, height: 900 };
  try {
    const primaryDisplay = screen && screen.getPrimaryDisplay();
    if (primaryDisplay && primaryDisplay.workArea) {
      operationalWindowBounds = {
        x: primaryDisplay.workArea.x,
        y: primaryDisplay.workArea.y,
        width: primaryDisplay.workArea.width,
        height: primaryDisplay.workArea.height
      };
    }
  } catch (_) {}

  // Main app window
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,  // áº¨n ngay khi khá»Ÿi Ä‘á»™ng â€” khÃ´ng cáº§n thiáº¿t cho hoáº¡t Ä‘á»™ng hÃ ng ngÃ y
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  installPersistentZoom(win, 'mainWin');
  installKeyboardZoomShortcuts(win, 'mainWin', 'mainWin');
  win.loadFile(path.join(__dirname, 'index.html'));
  // Cháº·n Ä‘Ã³ng main window khá»i kill toÃ n app â€” áº©n xuá»‘ng thay vÃ¬ close
  win.on('close', (e) => {
    if (_userRequestedQuit || _relaunching || _quitting) return;
    e.preventDefault();
    win.hide();
  });
  // DevTools táº¯t trong production â€” Ä‘á»ƒ má»Ÿ sáº½ tich lÅ©y RAM vÃ´ háº¡n qua 24h

  // F12 toggle DevTools â€” dÃ¹ng before-input-event vÃ¬ globalShortcut bá»‹ web page cháº·n
  function enableF12DevTools(browserWin) {
    browserWin.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        if (browserWin.webContents.isDevToolsOpened()) {
          browserWin.webContents.closeDevTools();
        } else {
          browserWin.webContents.openDevTools();
        }
        event.preventDefault();
      }
    });
  }

  function protectOperationalWindow(browserWin, label, recoverUrl, isHidden = false) {
    browserWin.on('close', (e) => {
      if (isOperationalTabDisabled(label)) return;
      if (_userRequestedQuit || _relaunching) return;
      e.preventDefault();
      logMain(`[OperationalWindow] close blocked label=${label} url=${getWindowUrlShort(browserWin)}`);
      try { browserWin.hide(); } catch (_) {}
      setTimeout(() => {
        if (browserWin.isDestroyed()) return;
        try {
          const currentUrl = getWindowUrl(browserWin);
          if (recoverUrl && currentUrl === 'about:blank') {
            loadWindowUrl(browserWin, label, recoverUrl, 'protect-auto-reopen-blank');
          }
          if (!isHidden) {
            if (!browserWin.isMaximized()) browserWin.maximize();
            browserWin.show();
            browserWin.focus();
          }
        } catch (err) {
          logMain('[Protect] Reopen failed, forcing relaunch:', label, err);
          triggerRelaunch(`protect-reopen-failed:${label}`);
        }
      }, 400);
    });
    browserWin.on('closed', () => {
      if (isOperationalTabDisabled(label)) return;
      if (_userRequestedQuit || _relaunching) return;
      logMain(`[OperationalWindow] destroyed label=${label} recoverUrl=${recoverUrl || ''}`);
      flushMainLogBufferSyncFallback();
      flushImportantEventBufferSyncFallback();
    });
  }

  function startOperationalWindowSupervisor(windowsByLabel) {
    let checkBusy = false;
    let failureKey = '';
    let failureFirstSeenAt = 0;
    let lastDeferredLogAt = 0;
    logMain(`[OperationalWindow] supervisor active labels=${Object.keys(windowsByLabel).join(',')} intervalMs=3000`);

    async function hasSurvivingOrderProcessing() {
      for (const browserWin of Object.values(windowsByLabel)) {
        try {
          if (!browserWin || browserWin.isDestroyed()) continue;
          const wc = browserWin.webContents;
          if (!wc || wc.isDestroyed()) continue;
          const processing = await Promise.race([
            wc.executeJavaScript('Boolean(window.__thaiasiaOrderProcessing)', true),
            new Promise((resolve) => setTimeout(() => resolve(false), 1200))
          ]);
          if (processing === true) return true;
        } catch (_) {}
      }
      return false;
    }

    async function check() {
      if (checkBusy || _userRequestedQuit || _relaunching) return;
      checkBusy = true;
      try {
        const failure = findOperationalWindowFailure(windowsByLabel);
        if (!failure) {
          failureKey = '';
          failureFirstSeenAt = 0;
          return;
        }

        const nowTs = Date.now();
        const nextKey = `${failure.label}:${failure.reason}`;
        if (failureKey !== nextKey) {
          failureKey = nextKey;
          failureFirstSeenAt = nowTs;
          logMain(`[OperationalWindow] missing label=${failure.label} reason=${failure.reason}`);
          flushMainLogBufferSyncFallback();
          flushImportantEventBufferSyncFallback();
        }

        if (await hasSurvivingOrderProcessing()) {
          if (nowTs - lastDeferredLogAt >= 15 * 1000) {
            lastDeferredLogAt = nowTs;
            logMain(`[OperationalWindow] recovery deferred processing label=${failure.label} reason=${failure.reason}`);
          }
          return;
        }

        if (nowTs - failureFirstSeenAt < 1500) return;
        triggerRelaunch(`operational-window-missing:${failure.label}:${failure.reason}`);
      } finally {
        checkBusy = false;
      }
    }

    setTimeout(check, 1500);
    setInterval(check, 3000);
  }

  function keepWindowMaximized(browserWin) {
    const ensureMax = () => {
      try {
        if (!browserWin.isDestroyed() && !browserWin.isMaximized()) browserWin.maximize();
      } catch (_) {}
    };
    browserWin.on('ready-to-show', ensureMax);
    browserWin.on('show', ensureMax);
    browserWin.on('restore', () => setTimeout(ensureMax, 60));
    browserWin.on('focus', ensureMax);
    browserWin.webContents.on('dom-ready', () => setTimeout(ensureMax, 100));
    browserWin.webContents.on('did-finish-load', () => setTimeout(ensureMax, 150));
    ensureMax();
  }

  function setupOperationalWindowLifecycle(browserWin, label) {
    if (!browserWin || browserWin.isDestroyed()) return;
    try {
      browserWin.show();
    } catch (_) {}
  }

  enableF12DevTools(win);

  // ── Wolt Merchant Web ───────────────────────────────────────────────────────
  // Partition rieng giu login, cookies va Flutter storage sau khi khoi dong lai.
  const woltSession = session.fromPartition(WOLT_PARTITION);
  installWoltGermanLocaleHooks(WOLT_PARTITION);
  try {
    woltSession.setPermissionRequestHandler((webContents, permission, callback) => {
      let trustedWoltPage = false;
      try {
        const host = new URL(webContents.getURL()).hostname.toLowerCase();
        trustedWoltPage = host === 'wolt.com' || host.endsWith('.wolt.com');
      } catch (_) {}
      callback(trustedWoltPage && permission === 'notifications');
    });
  } catch (error) {
    logMain('[WoltWeb] notification permission handler failed:', error);
  }

  woltWin = new BrowserWindow({
    ...operationalWindowBounds,
    show: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-wolt.js'),
      additionalArguments: ['--thaiasia-page=woltWin'],
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      partition: WOLT_PARTITION,
      backgroundThrottling: false
    }
  });
  const woltWindowTitle = 'Wolt - ThaiAsia';
  try { woltWin.setTitle(woltWindowTitle); } catch (_) {}
  woltWin.on('page-title-updated', (e) => {
    e.preventDefault();
    woltWin.setTitle(woltWindowTitle);
  });
  woltWin.webContents.setWindowOpenHandler(({ url }) => {
    let trustedWoltUrl = false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      trustedWoltUrl = host === 'wolt.com' || host.endsWith('.wolt.com');
    } catch (_) {}
    if (!trustedWoltUrl) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 900,
        height: 760,
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          partition: WOLT_PARTITION
        }
      }
    };
  });
  installPersistentZoom(woltWin, 'woltWin');
  installKeyboardZoomShortcuts(woltWin, 'woltWin', 'woltWin');
  installOperationalReloadShortcut(woltWin, 'woltWin');
  attachWindowDiagnostics(woltWin, 'woltWin');
  protectOperationalWindow(woltWin, 'woltWin', WOLT_WEB_URL);
  keepWindowMaximized(woltWin);
  setupOperationalWindowLifecycle(woltWin, 'woltWin');
  loadWindowUrl(woltWin, 'woltWin', WOLT_WEB_URL, 'startup');
  enableF12DevTools(woltWin);

  woltWin.webContents.on('render-process-gone', (_, details) => {
    scheduleWindowReload(woltWin, 'woltWin', `render-process-gone:${details && details.reason}`, 3000);
  });
  woltWin.webContents.on('did-fail-load', (_, code, desc, url, isMainFrame) => {
    if (code !== -3 && isMainFrame) {
      scheduleWindowReload(woltWin, 'woltWin', `did-fail-load:${code}:${desc}:${url}`, 5000);
    }
  });
  woltWin.webContents.on('did-finish-load', () => {
    persistSessionCookies(WOLT_WEB_URL, WOLT_PARTITION);
    // Ha z-index cua flt-glass-pane (Flutter CanvasKit layer) xuong 2147483646
    // Panel cua chung ta dung z-index: 2147483647 nen se luon hien tren Flutter UI.
    // insertCSS inject o tang Electron, khong bi Flutter JS override.
    woltWin.webContents.insertCSS(
      'flt-glass-pane { z-index: 2147483646 !important; }'
    ).catch(() => {});
  });

  const woltBridgeScriptPath = path.join(__dirname, 'Wolt-Bridge.js');
  woltWin.webContents.on('dom-ready', () => {
    let currentHostname = '';
    try {
      currentHostname = new URL(woltWin.webContents.getURL()).hostname.toLowerCase();
    } catch (_) {}

    const isWoltDomain = currentHostname === 'wolt.com' || currentHostname.endsWith('.wolt.com');
    const isMerchantApp = currentHostname === 'merchant-app.wolt.com';

    // NOTE: injectAutoLoginHelper intentionally NOT called for Wolt.
    // Wolt is Flutter web — DOM value injection every 1s conflicts with
    // the dedicated woltAutoLogin flow below. One single clean attempt instead.

    if (!isWoltDomain) return;

    // Force tieng Duc: xoa cache locale Flutter/Wolt trong localStorage
    woltWin.webContents.executeJavaScript(`(function(){
      try {
        var toRemove = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && (k.includes('locale') || k.includes('language') || k.includes('lang_') ||
              k.includes('_lang') || k.includes('flutter.i18n') || k.includes('selectedLanguage') ||
              k === 'lang' || k === 'lng' || k === 'i18nextLng')) {
            toRemove.push(k);
          }
        }
        toRemove.forEach(function(k) { try { localStorage.removeItem(k); } catch(_) {} });
        try { localStorage.setItem('flutter.locale','de_DE'); } catch(_) {}
        try { localStorage.setItem('selectedLanguage','de'); } catch(_) {}
      } catch(_) {}
    })()`).catch(() => {});

    if (!isMerchantApp) return;

    fs.readFile(woltBridgeScriptPath, 'utf8', (err, data) => {
      if (err) {
        logMain('[WoltWeb] Failed to read Wolt-Bridge.js:', err);
        return;
      }
      if (woltWin.isDestroyed() || woltWin.webContents.isDestroyed()) return;
      woltWin.webContents.executeJavaScript(data).catch((error) => {
        logMain('[WoltWeb] Failed to inject Wolt-Bridge.js:', error);
      });
    });

    // Wolt auto-login: wait 3s after dom-ready, then start polling & native login
    if (isWoltDomain) {
      setTimeout(() => {
        if (!woltWin.isDestroyed()) {
          performWoltNativeLogin(woltWin.webContents);
        }
      }, 3000);
    }
  });

  function scheduleWoltNightlyReload() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 2, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      scheduleWindowReloadWhenIdle(woltWin, 'woltWin', 'nightly-3am');
      scheduleWoltNightlyReload();
    }, next - now);
  }
  scheduleWoltNightlyReload();

  woltWin.webContents.on('did-navigate-in-page', () => {
    let isMerchantApp = false;
    try {
      isMerchantApp = new URL(woltWin.webContents.getURL()).hostname.toLowerCase() === 'merchant-app.wolt.com';
    } catch (_) {}
    if (!isMerchantApp) return;
    fs.readFile(woltBridgeScriptPath, 'utf8', (err, data) => {
      if (err || !data) return;
      if (woltWin.isDestroyed() || woltWin.webContents.isDestroyed()) return;
      woltWin.webContents.executeJavaScript(data).catch(() => {});
    });
    // Check if navigation led back to login screen (e.g. after manual logout)
    setTimeout(() => {
      if (!woltWin.isDestroyed()) {
        performWoltNativeLogin(woltWin.webContents);
      }
    }, 1500);
  });


  // Live order window â€” uses preload-liveorder.js for GM_* polyfills
  // persist:live-orders partition: Electron tá»± lÆ°u toÃ n bá»™ storage (cookies, localStorage,
  // sessionStorage) vÃ o disk dÆ°á»›i userData/Partitions/live-orders/
  // â†’ modal training Live Orders chá»‰ hiá»‡n 1 láº§n dÃ u, khá»Ÿi Ä‘á»™ng láº¡i khÃ´ng hiá»‡n ná»¯a
  const LIVE_PARTITION = 'persist:live-orders';
  installTakeawayOrdersCanary(LIVE_PARTITION, emitMainDiag);
  liveOrderWin = new BrowserWindow({
    ...operationalWindowBounds,
    show: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-liveorder.js'),
      additionalArguments: ['--thaiasia-page=liveOrderWin'],
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      partition: LIVE_PARTITION,
      backgroundThrottling: false
    }
  });
  try { liveOrderWin.setTitle('Live Orders (Takeaway) - ThaiAsia'); } catch (_) {}
  liveOrderWin.on('page-title-updated', (e) => {
    e.preventDefault();
    liveOrderWin.setTitle('Live Orders (Takeaway) - ThaiAsia');
  });
  installPersistentZoom(liveOrderWin, 'liveOrderWin', LIVE_ORDERS_ZOOM_KEY);
  installKeyboardZoomShortcuts(liveOrderWin, LIVE_ORDERS_ZOOM_KEY, 'liveOrderWin');
  installOperationalReloadShortcut(liveOrderWin, 'liveOrderWin');
  attachWindowDiagnostics(liveOrderWin, 'liveOrderWin');
  protectOperationalWindow(liveOrderWin, 'liveOrderWin', 'https://live-orders.takeaway.com/orders');
  keepWindowMaximized(liveOrderWin);
  setupOperationalWindowLifecycle(liveOrderWin, 'liveOrderWin');
  loadWindowUrl(liveOrderWin, 'liveOrderWin', 'https://live-orders.takeaway.com/orders', 'startup');
  enableF12DevTools(liveOrderWin);
  // FIX: Reload khi renderer crash hoáº·c trang load tháº¥t báº¡i (máº¥t session)
  liveOrderWin.webContents.on('render-process-gone', (_, details) => {
    scheduleWindowReload(liveOrderWin, 'liveOrderWin', `render-process-gone:${details && details.reason}`, 3000);
  });
  liveOrderWin.webContents.on('did-fail-load', (_, code, desc, url, isMainFrame) => {
    if (code !== -3 && isMainFrame) { // -3 = aborted (user navigate), bá»  qua
      scheduleWindowReload(liveOrderWin, 'liveOrderWin', `did-fail-load:${code}:${desc}:${url}`, 5000);
    }
  });
  // FIX: Kiá»ƒm tra session má»—i 30 phÃºt - náº¿u láº¡c vá»  trang login thÃ¬ reload URL gá»‘c
  setInterval(() => {
    if (liveOrderWin.isDestroyed()) return;
    const currentUrl = liveOrderWin.webContents.getURL();
    if (currentUrl && !currentUrl.includes('live-orders.takeaway.com') && !currentUrl.includes('about:blank')) {
      loadWindowUrl(
        liveOrderWin,
        'liveOrderWin',
        'https://live-orders.takeaway.com/orders',
        `session-drift-check:currentUrl=${currentUrl}`
      );
    }
  }, 30 * 60 * 1000);
  liveOrderWin.webContents.on('did-finish-load', () => {
    persistSessionCookies('https://live-orders.takeaway.com', LIVE_PARTITION);
  });
  // Inject the electron-ready all-in-one script (includes Queue + Ãœbergabe)
  const scriptPath = path.join(__dirname, 'ThaiAsia-AllInOneapp.js');
  liveOrderWin.webContents.on('dom-ready', () => {
    // Bá»  qua mÃ n hÃ¬nh huáº¥n luyá»‡n: set trainings.isCompleted=true trong localStorage
    // trÆ°á»›c khi React app Ä‘á» c â†’ modal training khÃ´ng bao giá»  hiá»‡n
    liveOrderWin.webContents.executeJavaScript(`
      (function() {
        try {
          // Bá»  modal training
          const raw = localStorage.getItem('trainings');
          const data = raw ? JSON.parse(raw) : { state: {}, version: 0 };
          if (!data.state) data.state = {};
          if (!data.state.isCompleted) {
            data.state.isCompleted = true;
            data.state.completedTrainingsIds = data.state.completedTrainingsIds || [];
            data.state.completedAmount = data.state.completedAmount || 1;
            localStorage.setItem('trainings', JSON.stringify(data));
            console.log('[ThaiAsia] Training marked as completed');
          }
          // Giá»¯ tiáº¿ng Ä á»©c â€” luÃ´n force, khÃ´ng Ä‘á»ƒ trang reset vá»  tiáº¿ng Anh
          localStorage.setItem('lang', 'de');
          localStorage.setItem('orig_lang', 'de');
          // Bá»  modal "Need to press pause?" â€” luÃ´n force false + Ä‘Ã¡nh dáº¥u Ä‘Ã£ tháº¥y
          localStorage.setItem('isOnboardingVisible', 'false');
          localStorage.setItem('seenOnboardings', 'busy-mode');
        } catch(e) {}
      })();
    `);
    injectAutoLoginHelper(liveOrderWin, 'takeaway');
    fs.readFile(scriptPath, 'utf8', (err, data) => {
      if (!err) {
        liveOrderWin.webContents.executeJavaScript(data);
      } else {
        logMain('[Electron] Failed to read ThaiAsia-AllInOneapp.js:', err);
      }
    });
  });

  // Auto Fertig window — runs Autofertig.js on the Übergabe tab (chạy ngầm hoàn toàn)
  fertigWin = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    skipTaskbar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-liveorder.js'),
      additionalArguments: ['--thaiasia-page=fertigWin'],
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      partition: LIVE_PARTITION,
      backgroundThrottling: false
    }
  });
  try { fertigWin.setTitle('Auto Fertig - ThaiAsia'); } catch (_) {}
  fertigWin.on('page-title-updated', (e) => {
    e.preventDefault();
    fertigWin.setTitle('Auto Fertig - ThaiAsia');
  });
  installPersistentZoom(fertigWin, 'fertigWin', LIVE_ORDERS_ZOOM_KEY);
  installKeyboardZoomShortcuts(fertigWin, LIVE_ORDERS_ZOOM_KEY, 'fertigWin');
  installOperationalReloadShortcut(fertigWin, 'fertigWin');
  attachWindowDiagnostics(fertigWin, 'fertigWin');
  protectOperationalWindow(fertigWin, 'fertigWin', 'https://live-orders.takeaway.com/orders?tabmode=tudongfertig', true);
  loadWindowUrl(
    fertigWin,
    'fertigWin',
    'https://live-orders.takeaway.com/orders?tabmode=tudongfertig',
    'startup'
  );
  enableF12DevTools(fertigWin);
  // FIX: Reload khi fertigWin crash
  fertigWin.webContents.on('render-process-gone', (_, details) => {
    scheduleWindowReload(fertigWin, 'fertigWin', `render-process-gone:${details && details.reason}`, 3000);
  });
  fertigWin.webContents.on('did-fail-load', (_, code, desc, url, isMainFrame) => {
    if (code !== -3 && isMainFrame) {
      scheduleWindowReload(fertigWin, 'fertigWin', `did-fail-load:${code}:${desc}:${url}`, 5000);
    }
  });
  // Kiá»ƒm tra session fertigWin má»—i 30 phÃºt - náº¿u láº¡c vá»  login thÃ¬ reload URL gá»‘c
  setInterval(() => {
    if (fertigWin.isDestroyed()) return;
    const currentUrl = fertigWin.webContents.getURL();
    if (currentUrl && !currentUrl.includes('live-orders.takeaway.com') && !currentUrl.includes('about:blank')) {
      loadWindowUrl(
        fertigWin,
        'fertigWin',
        'https://live-orders.takeaway.com/orders?tabmode=tudongfertig',
        `session-drift-check:currentUrl=${currentUrl}`
      );
    }
  }, 30 * 60 * 1000);
  fertigWin.webContents.on('did-finish-load', () => {
    persistSessionCookies('https://live-orders.takeaway.com', LIVE_PARTITION);
  });
  const fertigScriptPath = path.join(__dirname, 'Autofertig.js');
  fertigWin.webContents.on('dom-ready', () => {
    // Bá»  qua mÃ n hÃ¬nh huáº¥n luyá»‡n (cÃ¹ng localStorage vá»›i liveOrderWin vÃ¬ cÃ¹ng partition)
    fertigWin.webContents.executeJavaScript(`
      (function() {
        try {
          // Bá»  modal training
          const raw = localStorage.getItem('trainings');
          const data = raw ? JSON.parse(raw) : { state: {}, version: 0 };
          if (!data.state) data.state = {};
          if (!data.state.isCompleted) {
            data.state.isCompleted = true;
            data.state.completedTrainingsIds = data.state.completedTrainingsIds || [];
            data.state.completedAmount = data.state.completedAmount || 1;
            localStorage.setItem('trainings', JSON.stringify(data));
          }
          // Giá»¯ tiáº¿ng Ä á»©c â€” luÃ´n force
          localStorage.setItem('lang', 'de');
          localStorage.setItem('orig_lang', 'de');
          // Bá»  modal "Need to press pause?" â€” luÃ´n force
          localStorage.setItem('isOnboardingVisible', 'false');
          localStorage.setItem('seenOnboardings', 'busy-mode');
        } catch(e) {}
      })();
    `);
    injectAutoLoginHelper(fertigWin, 'takeaway');
    fs.readFile(fertigScriptPath, 'utf8', (err, data) => {
      if (!err) {
        fertigWin.webContents.executeJavaScript(data);
      } else {
        logMain('[Electron] Failed to read Autofertig.js:', err);
      }
    });
  });

  startTakeawayKeepAliveMonitor({ liveOrderWin, fertigWin });

  // â”€â”€ UberEats window â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Cá»­a sá»• riÃªng Ä‘á»ƒ theo dÃµi vÃ  láº¥y Ä‘Æ¡n UberEats.
  // DÃ¹ng partition persist:ubereats â†’ login UberEats Ä‘Æ°á»£c giá»¯ giá»¯a cÃ¡c láº§n khá»Ÿi Ä‘á»™ng.
  const UBEREATS_PARTITION = 'persist:ubereats';
  installUberEatsLocaleHooks(UBEREATS_PARTITION);
  uberEatsWin = new BrowserWindow({
    ...operationalWindowBounds,
    show: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload:          path.join(__dirname, 'preload-ubereats.js'),
      nodeIntegration:  false,
      contextIsolation: false,
      sandbox:          false,
      partition:        UBEREATS_PARTITION,
      backgroundThrottling: false
    }
  });
  try { uberEatsWin.setTitle('Uber Eats - ThaiAsia'); } catch (_) {}
  uberEatsWin.on('page-title-updated', (e) => {
    e.preventDefault();
    uberEatsWin.setTitle('Uber Eats - ThaiAsia');
  });
  installPersistentZoom(uberEatsWin, 'uberEatsWin');
  installKeyboardZoomShortcuts(uberEatsWin, 'uberEatsWin', 'uberEatsWin');
  installOperationalReloadShortcut(uberEatsWin, 'uberEatsWin');
  attachWindowDiagnostics(uberEatsWin, 'uberEatsWin');
  protectOperationalWindow(uberEatsWin, 'uberEatsWin', 'https://merchants-beta.ubereats.com/orders/overview');
  keepWindowMaximized(uberEatsWin);
  setupOperationalWindowLifecycle(uberEatsWin, 'uberEatsWin');
  loadWindowUrl(
    uberEatsWin,
    'uberEatsWin',
    'https://merchants-beta.ubereats.com/orders/overview',
    'startup'
  );
  enableF12DevTools(uberEatsWin);

  // Tá»± reload khi crash
  uberEatsWin.webContents.on('render-process-gone', (_, details) => {
    scheduleWindowReload(uberEatsWin, 'uberEatsWin', `render-process-gone:${details && details.reason}`, 3000);
  });
  uberEatsWin.webContents.on('did-fail-load', (_, code, desc, url, isMainFrame) => {
    if (code !== -3 && isMainFrame) {
      scheduleWindowReload(uberEatsWin, 'uberEatsWin', `did-fail-load:${code}:${desc}:${url}`, 5000);
    }
  });

  // Kiá»ƒm tra session má»—i 30 phÃºt â€” náº¿u láº¡c vá»  trang khÃ¡c thÃ¬ reload
  setInterval(() => {
    if (uberEatsWin.isDestroyed()) return;
    const currentUrl = uberEatsWin.webContents.getURL();
    if (currentUrl &&
        !currentUrl.includes('ubereats.com') &&
        !currentUrl.includes('about:blank')) {
      loadWindowUrl(
        uberEatsWin,
        'uberEatsWin',
        'https://merchants-beta.ubereats.com/orders/overview',
        `session-drift-check:currentUrl=${currentUrl}`
      );
    }
  }, 30 * 60 * 1000);

  // Inject UberEats-Bridge.js sau má»—i dom-ready
  const uberEatsScriptPath = path.join(__dirname, 'UberEats-Bridge.js');
  uberEatsWin.webContents.on('dom-ready', () => {
    injectAutoLoginHelper(uberEatsWin, 'ubereats');
    fs.readFile(uberEatsScriptPath, 'utf8', (err, data) => {
      if (!err) {
        uberEatsWin.webContents.executeJavaScript(data);
      } else {
        logMain('[Electron] Failed to read UberEats-Bridge.js:', err);
      }
    });
  });

  // Tiền ship / daily report window — runs tienship.js on Admin orders list (chạy ngầm hoàn toàn).
  const TIENSHIP_URL = 'https://www.api.thaiasiasushibar.de/admin/orders?per_page=9999';
  tienShipWin = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    skipTaskbar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-tienship.js'),
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  try { tienShipWin.setTitle('ThaiAsia Tiền Ship Report'); } catch (_) {}
  installPersistentZoom(tienShipWin, 'tienShipWin');
  installKeyboardZoomShortcuts(tienShipWin, 'tienShipWin', 'tienShipWin');
  installOperationalReloadShortcut(tienShipWin, 'tienShipWin');
  attachWindowDiagnostics(tienShipWin, 'tienShipWin');
  protectOperationalWindow(tienShipWin, 'tienShipWin', TIENSHIP_URL, true);
  loadWindowUrl(tienShipWin, 'tienShipWin', TIENSHIP_URL, 'startup');
  enableF12DevTools(tienShipWin);

  tienShipWin.webContents.on('render-process-gone', (_, details) => {
    scheduleWindowReload(tienShipWin, 'tienShipWin', `render-process-gone:${details && details.reason}`, 3000);
  });
  tienShipWin.webContents.on('did-fail-load', (_, code, desc, url, isMainFrame) => {
    if (code !== -3 && isMainFrame) {
      scheduleWindowReload(tienShipWin, 'tienShipWin', `did-fail-load:${code}:${desc}:${url}`, 5000);
    }
  });
  setInterval(() => {
    if (tienShipWin.isDestroyed()) return;
    const currentUrl = tienShipWin.webContents.getURL();
    if (currentUrl &&
        !currentUrl.includes('api.thaiasiasushibar.de') &&
        !currentUrl.includes('about:blank')) {
      loadWindowUrl(
        tienShipWin,
        'tienShipWin',
        TIENSHIP_URL,
        `session-drift-check:currentUrl=${currentUrl}`
      );
    }
  }, 30 * 60 * 1000);

  const tienShipScriptPath = path.join(__dirname, 'tienship.js');
  tienShipWin.webContents.on('dom-ready', () => {
    injectAutoLoginHelper(tienShipWin, 'admin');
    fs.readFile(tienShipScriptPath, 'utf8', (err, data) => {
      if (!err) {
        tienShipWin.webContents.executeJavaScript(data);
      } else {
        logMain('[Electron] Failed to read tienship.js:', err);
      }
    });
  });

  const operationalWindowsByLabel = { woltWin, liveOrderWin, fertigWin, uberEatsWin, tienShipWin };
  installOperationalTabMenu(operationalWindowsByLabel);
  startOperationalWindowSupervisor(operationalWindowsByLabel);

  // Flush UberEats session storage má»—i 5 phÃºt
  setInterval(() => {
    safeFlushStorageData(session.fromPartition(UBEREATS_PARTITION));
  }, 5 * 60 * 1000);

  // â”€â”€ Nightly reload lÃºc 3:00 AM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Giáº£i phÃ³ng RAM tÃ­ch lÅ©y + refresh session token UberEats.
  // Stagger 30s / 60s Ä‘á»ƒ khÃ´ng reload Ä‘á»“ng thá»i.
  function scheduleNightlyReload() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    setTimeout(() => {
      logMain('[ThaiAsia] Nightly reload at 3:00 AM');
      scheduleWindowReloadWhenIdle(liveOrderWin, 'liveOrderWin', 'nightly-3am');
      scheduleWindowReloadWhenIdle(fertigWin, 'fertigWin', 'nightly-3am', 30 * 1000);
      scheduleWindowReloadWhenIdle(uberEatsWin, 'uberEatsWin', 'nightly-3am', 60 * 1000);
      scheduleWindowReloadWhenIdle(tienShipWin, 'tienShipWin', 'nightly-3am', 90 * 1000);
      scheduleNightlyReload(); // lÃªn lá»‹ch ngÃ y hÃ´m sau
    }, delay);
    logMain('[ThaiAsia] Nightly reload scheduled in', Math.round(delay / 60000), 'minutes');
  }
  scheduleNightlyReload();
}

// â”€â”€ Session cookie persistence â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// persist: partition Ä‘Ã£ xá»­ lÃ½ Ä‘a sá»‘, nhÆ°ng session cookies (khÃ´ng cÃ³ expiry) váº«n
// cÃ³ thá»ƒ bá»‹ Chromium xÃ³a. HÃ m nÃ y Ä‘á»•i chÃºng sang persistent 30 ngÃ y Ä‘á»ƒ cháº¯c cháº¯n.
async function persistSessionCookies(pageUrl, partition) {
  try {
    const ses = session.fromPartition(partition);
    const THIRTY_DAYS = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const cookies = await ses.cookies.get({ url: pageUrl });
    let converted = 0;
    for (const c of cookies) {
      if (!c.expirationDate) {
        try {
          await ses.cookies.set({
            url: pageUrl,
            name:  c.name,
            value: c.value,
            domain: c.domain,
            path:   c.path || '/',
            secure:   !!c.secure,
            httpOnly: !!c.httpOnly,
            expirationDate: THIRTY_DAYS,
          });
          converted++;
        } catch (_) {}
      }
    }
    if (converted > 0) {
      await ses.cookies.flushStore();
      console.log(`[ThaiAsia] Converted ${converted} session cookies â†’ persistent for ${pageUrl}`);
    }
  } catch (e) {
    console.error('[ThaiAsia] persistSessionCookies error:', e);
  }
}

app.on('render-process-gone', (_, webContents, details) => {
  const url = webContents && !webContents.isDestroyed() ? webContents.getURL() : 'unknown';
  logMain('[Crash] render-process-gone', { reason: details.reason, exitCode: details.exitCode, url });
});

app.on('child-process-gone', (_, details) => {
  logMain('[Crash] child-process-gone', details);
  if (details && details.type === 'GPU') {
    const now = Date.now();
    gpuCrashTs.push(now);
    while (gpuCrashTs.length > 0 && now - gpuCrashTs[0] > 120000) gpuCrashTs.shift();
    if (gpuCrashTs.length >= 6) {
      triggerRelaunch(`GPU crashed ${gpuCrashTs.length} times within 120s`);
    }
  }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  // Set app ID so Windows taskbar/tray shows the correct icon
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.thaiasia.allinone');
  }
  cleanupOldDiagnosticFiles();
  if (previousRunIncident) {
    logMain('[Lifecycle] Previous run ended unexpectedly', previousRunIncident);
  }
  write24hSummaryReport();
  startReportBundleDeletionMonitor();
  setInterval(() => {
    flushImportantEventBufferAsync();
    write24hSummaryReport();
  }, REPORT_REFRESH_INTERVAL_MS);
  setInterval(() => {
    cleanupOldDiagnosticFiles();
  }, 24 * 60 * 60 * 1000);
  logMain('[Lifecycle] App ready. PID:', process.pid);
  startAppHeartbeat();
  autoUpdateManager = createAutoUpdateManager({
    app,
    BrowserWindow,
    ipcMain,
    safeStorage,
    dialog,
    appDir: __dirname,
    userDataDir: app.getPath('userData'),
    heartbeatPath: APP_HEARTBEAT_PATH,
    watchdogStateDir: WATCHDOG_STATE_DIR,
    log: logMain,
    isAppBusy: isAppBusyForAutoUpdate,
    requestQuitForUpdate: quitAppForAutoUpdate
  });
  autoUpdateManager.start();
  const runtimeMachineName = STARTUP_SMOKE_TEST
    ? String(process.env.THAIASIA_SMOKE_MACHINE_NAME || 'TEST-MACHINE-SMOKE').replace(/[^a-zA-Z0-9_-]/g, '_')
    : (os.hostname() || 'Win7').replace(/[^a-zA-Z0-9_-]/g, '_');
  reportSync = createReportSync({
    getToken: () => STARTUP_SMOKE_TEST ? '' : (autoUpdateManager ? autoUpdateManager.decryptToken() : ''),
    getRepository: () => (autoUpdateManager ? autoUpdateManager.getRepository() : 'chinhthaiba/chinhthaiba-thaiasia-releases'),
    machineName: runtimeMachineName,
    log: logMain,
    useFallbackToken: !STARTUP_SMOKE_TEST
  });

  // Store diagnostics under userData: some PCs have no D: drive or deny writes
  // to its root, which previously hid every receiver startup/error message.
  const _remoteDebugLogPath = path.join(USER_DATA_DIR, 'remote-control.log');
  const _remoteLog = function (...args) {
    logMain(...args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    try { fs.appendFileSync(_remoteDebugLogPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8'); } catch (_) {}
  };
  try { fs.appendFileSync(_remoteDebugLogPath, `\n=== APP STARTED v${app.getVersion()} at ${new Date().toISOString()} machine=${os.hostname()} ===\n`, 'utf8'); } catch (_) {}

  remoteCommandReceiver = createRemoteCommandReceiver({
    getToken: () => (autoUpdateManager ? autoUpdateManager.decryptToken() : ''),
    getRepository: () => (autoUpdateManager ? autoUpdateManager.getRepository() : 'chinhthaiba/chinhthaiba-thaiasia-releases'),
    machineName: runtimeMachineName,
    stateDir: DIAGNOSTICS_DIR,
    log: _remoteLog,
    handlers: {
      quit_app: () => {
        logMain('[RemoteControl] Executing: quit_app');
        _plannedShutdownReason = 'remote_quit';
        // Give the receiver enough time to persist and upload Ack + Done.
        setTimeout(() => app.quit(), 10000);
        return 'Đang đóng ứng dụng';
      },
      restart_app: () => {
        logMain('[RemoteControl] Executing: restart_app');
        if (!triggerRelaunch('remote-command-restart', { quitDelayMs: 10000 })) {
          throw new Error('Khong the khoi chay restart helper');
        }
        return 'Đang khởi động lại ứng dụng';
      },
      reload_wolt: () => {
        logMain('[RemoteControl] Executing: reload_wolt');
        if (woltWin && !woltWin.isDestroyed()) {
          woltWin.webContents.reloadIgnoringCache();
          return 'Đã tải lại trang Wolt';
        }
        return 'Tab Wolt không tồn tại';
      },
      reload_uber: () => {
        logMain('[RemoteControl] Executing: reload_uber');
        if (uberEatsWin && !uberEatsWin.isDestroyed()) {
          uberEatsWin.webContents.reloadIgnoringCache();
          return 'Đã tải lại trang Uber Eats';
        }
        return 'Tab Uber Eats không tồn tại';
      },
      reload_takeaway: () => {
        logMain('[RemoteControl] Executing: reload_takeaway');
        if (liveOrderWin && !liveOrderWin.isDestroyed()) {
          liveOrderWin.webContents.reloadIgnoringCache();
          return 'Đã tải lại trang Takeaway';
        }
        return 'Tab Takeaway không tồn tại';
      },
      reload_fertig: () => {
        logMain('[RemoteControl] Executing: reload_fertig');
        if (fertigWin && !fertigWin.isDestroyed()) {
          fertigWin.webContents.reloadIgnoringCache();
          return 'Đã tải lại trang Fertig';
        }
        return 'Tab Fertig không tồn tại';
      },
      reload_tienship: () => {
        logMain('[RemoteControl] Executing: reload_tienship');
        if (tienShipWin && !tienShipWin.isDestroyed()) {
          tienShipWin.webContents.reloadIgnoringCache();
          return 'Đã tải lại trang Tiền Ship';
        }
        return 'Tab Tiền Ship không tồn tại';
      },
      reload_all_tabs: () => {
        logMain('[RemoteControl] Executing: reload_all_tabs');
        [woltWin, uberEatsWin, liveOrderWin, fertigWin, tienShipWin].forEach((win) => {
          if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
        });
        return 'Đã tải lại toàn bộ các tab';
      },
      force_sync_report: async () => {
        logMain('[RemoteControl] Executing: force_sync_report');
        write24hSummaryReport();
        if (reportSync) {
          try {
            const humanText = fs.existsSync(APP_24H_REPORT_TXT_PATH) ? fs.readFileSync(APP_24H_REPORT_TXT_PATH, 'utf8') : '';
            const bundleText = fs.existsSync(APP_24H_REPORT_BUNDLE_PATH) ? fs.readFileSync(APP_24H_REPORT_BUNDLE_PATH, 'utf8') : '';
            const res = await reportSync.syncReportsAsync({ humanText, bundleText }, { force: true });
            if (res && res.success) {
              return `Đã xuất và đồng bộ thành công lên GitHub (ThaiAsia-24h-report-${os.hostname()}.txt)`;
            } else if (res && res.error) {
              return `Lỗi tải lên: ${res.error}`;
            } else if (res && res.skipped) {
              return `Đã xuất file tại chỗ (bỏ qua: ${res.reason})`;
            }
          } catch (err) {
            return `Lỗi đồng bộ: ${err.message}`;
          }
        }
        return 'Đã xuất và đồng bộ báo cáo 24h';
      },
      force_update: async () => {
        logMain('[RemoteControl] Executing: force_update');
        if (autoUpdateManager) {
          const res = await autoUpdateManager.checkNow();
          if (res && (res.state === 'staged' || res.state === 'waiting-idle' || (res.message && res.message.includes('tải xong')))) {
            setTimeout(() => {
              autoUpdateManager.attemptInstall({ force: true }).catch(() => {});
            }, 1500);
            return (res.message || 'Đã tải bản mới xong') + ' -> Đang tự động cài đặt và khởi động lại ngay...';
          }
          return res && res.message ? res.message : 'Đã kích hoạt kiểm tra và tải cập nhật';
        }
        return 'Bộ cập nhật chưa sẵn sàng';
      },
      ping: () => {
        const upSec = Math.floor(process.uptime());
        const hours = Math.floor(upSec / 3600);
        const mins = Math.floor((upSec % 3600) / 60);
        const secs = upSec % 60;
        const uptimeStr = hours > 0 ? `${hours} giờ ${mins} phút` : (mins > 0 ? `${mins} phút ${secs} giây` : `${secs} giây`);
        return {
          version: app.getVersion(),
          uptime: uptimeStr,
          ram: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`
        };
      },
      wipe_app: () => {
        logMain('[RemoteControl] CRITICAL: Executing wipe_app (Self-Destruct & Remote Wipe)');
        _plannedShutdownReason = 'remote_wipe';
        const runtimeDir = APP_RUNTIME_DIR;
        const userDataDir = USER_DATA_DIR;
        const parentDir = path.dirname(runtimeDir);
        const tempBatPath = path.join(app.getPath('temp'), `wipe_thaiasia_${Date.now()}.bat`);

        const batContent = `@echo off
chcp 65001 > nul
cd /d "%TEMP%"
ping 127.0.0.1 -n 5 > nul
taskkill /F /IM ThaiAsiaApp.exe /T > nul 2>&1
taskkill /F /IM electron.exe /T > nul 2>&1
taskkill /F /IM node.exe /T > nul 2>&1
ping 127.0.0.1 -n 3 > nul

REM 1. Xoa thu muc runtime app (thu 6 lan)
for /L %%i in (1,1,6) do (
  if exist "${runtimeDir}" (
    rmdir /S /Q "${runtimeDir}" > nul 2>&1
    ping 127.0.0.1 -n 2 > nul
  )
)

REM 2. Xoa cac file bao cao o thu muc cha va cac o dia
if exist "${parentDir}\\ThaiAsia-24h-report.txt" del /F /Q "${parentDir}\\ThaiAsia-24h-report.txt" > nul 2>&1
if exist "${parentDir}\\ThaiAsia-24h-report-bundle.txt" del /F /Q "${parentDir}\\ThaiAsia-24h-report-bundle.txt" > nul 2>&1
if exist "C:\\ThaiAsia-24h-report.txt" del /F /Q "C:\\ThaiAsia-24h-report.txt" > nul 2>&1
if exist "C:\\ThaiAsia-24h-report-bundle.txt" del /F /Q "C:\\ThaiAsia-24h-report-bundle.txt" > nul 2>&1
if exist "D:\\ThaiAsia-24h-report.txt" del /F /Q "D:\\ThaiAsia-24h-report.txt" > nul 2>&1
if exist "D:\\ThaiAsia-24h-report-bundle.txt" del /F /Q "D:\\ThaiAsia-24h-report-bundle.txt" > nul 2>&1
if exist "E:\\ThaiAsia-24h-report.txt" del /F /Q "E:\\ThaiAsia-24h-report.txt" > nul 2>&1
if exist "E:\\ThaiAsia-24h-report-bundle.txt" del /F /Q "E:\\ThaiAsia-24h-report-bundle.txt" > nul 2>&1

REM 3. Xoa toan bo du lieu ca nhan, cookies, tokens trong AppData
for /L %%i in (1,1,6) do (
  if exist "${userDataDir}" (
    rmdir /S /Q "${userDataDir}" > nul 2>&1
    ping 127.0.0.1 -n 2 > nul
  )
)

REM 4. Xoa moi bieu tuong Shortcut Desktop & Start Menu
del /F /Q "%USERPROFILE%\\Desktop\\ThaiAsia*.lnk" > nul 2>&1
del /F /Q "%PUBLIC%\\Desktop\\ThaiAsia*.lnk" > nul 2>&1
del /F /Q "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\ThaiAsia*.lnk" > nul 2>&1

REM 5. Tu xoa file script bat
del "%~f0" > nul 2>&1
`;

        try {
          fs.writeFileSync(tempBatPath, batContent, 'utf8');
          const { spawn } = require('child_process');
          const child = spawn('cmd.exe', ['/c', tempBatPath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          });
          child.unref();
        } catch (e) {
          logMain('[RemoteControl] Error spawning wipe script:', e);
        }

        // The wipe helper has its own delay. Keep Electron alive long enough for
        // Remote Control to commit its Ack before the helper terminates the app.
        setTimeout(() => {
          app.exit(0);
        }, 10000);

        return 'Đã kích hoạt tự hủy: Đang xóa sạch app, thư mục, báo cáo và toàn bộ tài khoản';
      }
    }
  });

  remoteCommandReceiver.start();
  // Start the receiver before taking the startup heartbeat snapshot, otherwise
  // an otherwise healthy app is briefly published as remoteControl.running=false.
  startRemoteHeartbeatSync();
  // Heartbeat gets the shared GitHub writer first; the report retries on its
  // normal refresh cycle if this immediate startup write is still in flight.
  if (!STARTUP_SMOKE_TEST) write24hSummaryReport();
  // Start Remote Control before any BrowserWindow work. A synchronous error in
  // one tab must never disable remote diagnostics and recovery for the machine.
  if (STARTUP_SMOKE_TEST) {
    _remoteLog('[SmokeTest] Core startup reached receiver.start successfully');
    setTimeout(() => {
      _plannedShutdownReason = 'startup_smoke_test';
      _userRequestedQuit = true;
      app.quit();
    }, 12000);
  } else {
    try {
      createWindow();
    } catch (windowError) {
      _remoteLog('[Lifecycle] createWindow failed; Remote Control remains active:', windowError && windowError.stack || windowError);
    }
  }
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Flush storage ra disk dinh ky moi 5 phut - phong khi mat dien dot ngot (before-quit khong chay duoc)
setInterval(() => {
  safeFlushStorageData(session.fromPartition('persist:live-orders'));
  safeFlushStorageData(session.fromPartition(WOLT_PARTITION));
  // ubereats partition cung duoc flush o trong createWindow (moi 5 phut rieng),
  // nhung flush them o day de dam bao dong bo khi app sap thoat.
}, 5 * 60 * 1000);

// Flush storage ra disk truoc khi app thoat - phai await vi flushStorageData tra Promise
app.on('before-quit', (e) => {
  if (_quitting) return;
  e.preventDefault();
  _quitting = true;
  _userRequestedQuit = true;
  stopRemoteHeartbeatSync();
  const shutdownHeartbeat = markCleanShutdown(
    _plannedShutdownReason || (_relaunching ? 'app_restart' : 'app_quit')
  );
  if (_stopWatchdogOnQuit) signalWatchdogStop('before-quit');
  stopAppHeartbeat();
  flushPersistentStoreSaveNow();
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  write24hSummaryReport();
  logMain('[Lifecycle] before-quit -> flushing partition storage...');
  Promise.all([
    Promise.race([
      shutdownHeartbeat,
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]),
    safeFlushStorageData(session.fromPartition('persist:live-orders')),
    safeFlushStorageData(session.fromPartition('persist:ubereats')),
    safeFlushStorageData(session.fromPartition(WOLT_PARTITION)),
    safeFlushStorageData(session.defaultSession)
  ]).finally(() => app.quit());
});

app.on('window-all-closed', function () {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) return;
  if (_userRequestedQuit || process.platform === 'darwin') {
    if (process.platform !== 'darwin') app.quit();
    return;
  }
  // Unexpected all windows closed (for example repeated renderer crashes).
  // Relaunch instead of exiting silently.
  triggerRelaunch('window-all-closed without user request');
});

app.on('will-quit', (_, exitCode) => {
  stopAppHeartbeat();
  stopRemoteHeartbeatSync();
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  logMain('[Lifecycle] will-quit', { exitCode, relaunching: _relaunching, userRequestedQuit: _userRequestedQuit });
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  write24hSummaryReport();
});

app.on('quit', (_, exitCode) => {
  stopAppHeartbeat();
  stopRemoteHeartbeatSync();
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  logMain('[Lifecycle] quit', { exitCode });
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  write24hSummaryReport();
});

process.on('exit', (code) => {
  stopAppHeartbeat();
  stopRemoteHeartbeatSync();
  logMain('[Lifecycle] process.exit', { code });
  flushMainLogBufferSyncFallback();
  flushImportantEventBufferSyncFallback();
  write24hSummaryReport();
});

// Chong crash toan bo app neu Node.js main process bi uncaught exception
process.on('uncaughtException', (err) => {
  logMain('[Electron Main] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  logMain('[Electron Main] unhandledRejection:', reason);
});

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  if (shouldBypassCertificateForUrl(url)) {
    event.preventDefault();
    logMain('[TLS] certificate-error bypassed for trusted host:', {
      url: shortenUrlForLog(url),
      error,
      issuerName: certificate && certificate.issuerName,
      subjectName: certificate && certificate.subjectName,
    });
    callback(true);
    return;
  }
  logMain('[TLS] certificate-error blocked:', {
    url: shortenUrlForLog(url),
    error,
  });
  callback(false);
});
