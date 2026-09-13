'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract ${startMarker}`);
  return source.slice(start, end);
}

function testPendingOrderParser() {
  const parserSource = between(
    'function collectTakeawayPendingOrders',
    'function sanitizeTakeawayCanaryHeaders'
  );
  const context = {
    normalizeTakeawayOrderCode(value) {
      const code = String(value == null ? '' : value).trim().replace(/^#/, '').toUpperCase();
      return /^[A-Z0-9]{5,10}$/.test(code) ? code : '';
    }
  };
  vm.createContext(context);
  vm.runInContext(parserSource, context);

  const payload = {
    orders: [
      { shortCode: 'PKKM9H', status: 'UNCONFIRMED' },
      { friendlyOrderReference: '#CP93X7', status: 'accepted' },
      { displayId: 'MMY8J6', isAccepted: false, state: 'OPEN' },
      { orderReference: 'RXVX76', status: 'RECEIVED_AT_RESTAURANT' },
      { shortId: 'DONE77', status: 'COMPLETED' }
    ]
  };
  const rows = context.collectTakeawayPendingOrders(payload);
  const codes = rows.map((row) => row.code).sort();
  assert.deepStrictEqual(
    Array.from(codes),
    ['MMY8J6', 'PKKM9H', 'RXVX76'],
    'Parser must keep actionable orders and exclude terminal orders'
  );
}

function testAuthenticatedCanaryRequest() {
  const canarySource = between(
    'function isTakeawayOrdersApiUrl',
    'function listDayKeysSince'
  );
  let beforeSendHeaders = null;
  let pollCallback = null;
  let requestOptions = null;
  const requestHeaders = {};
  const diagnostics = [];
  const state = {
    installed: false,
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
    pendingOrders: new Map()
  };
  const fakeSession = {
    webRequest: {
      onBeforeSendHeaders(_filter, callback) {
        beforeSendHeaders = callback;
      }
    }
  };
  const context = {
    URL,
    Buffer,
    Date,
    Map,
    Set,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Math,
    JSON,
    TAKEAWAY_CANARY_TOKEN_REFRESH_RETRY_MS: 30 * 1000,
    takeawayOrdersCanaryState: state,
    session: {
      fromPartition(partition) {
        assert.strictEqual(partition, 'persist:live-orders');
        return fakeSession;
      }
    },
    net: {
      request(options) {
        requestOptions = options;
        const request = new EventEmitter();
        request.setHeader = (name, value) => { requestHeaders[name] = value; };
        request.followRedirect = () => {};
        request.abort = () => {};
        request.end = () => {
          const response = new EventEmitter();
          response.statusCode = 200;
          request.emit('response', response);
          response.emit('data', Buffer.from(JSON.stringify({
            orders: [{ shortCode: 'API777', status: 'UNCONFIRMED' }]
          })));
          response.emit('end');
        };
        return request;
      }
    },
    setTimeout: () => 1,
    setInterval(callback, intervalMs) {
      assert.strictEqual(intervalMs, 5000);
      pollCallback = callback;
      return 1;
    }
  };
  vm.createContext(context);
  vm.runInContext(canarySource, context);
  context.installTakeawayOrdersCanary('persist:live-orders', (eventType, payload) => {
    diagnostics.push({ eventType, ...payload });
  });

  assert(beforeSendHeaders, 'Canary did not install the request observer');
  beforeSendHeaders({
    method: 'GET',
    url: 'https://live-orders-api.takeaway.com/api/orders?restaurant=thaiasia',
    webContentsId: 12,
    requestHeaders: {
      Authorization: 'Bearer test',
      Cookie: 'session=secret',
      'X-Restaurant-Id': '123'
    }
  }, () => {});
  assert(pollCallback, 'Canary polling interval was not installed');
  pollCallback();

  assert.strictEqual(requestOptions.session, fakeSession, 'Canary must reuse the live-orders session');
  assert.strictEqual(requestOptions.credentials, 'include', 'Canary must include session credentials');
  assert.strictEqual(requestHeaders.Authorization, 'Bearer test', 'Canary must reuse API authorization');
  assert(!Object.keys(requestHeaders).some((name) => /^cookie$/i.test(name)), 'Cookie header must come from the session');
  assert(state.pendingOrders.has('API777'), 'Canary must parse pending orders from the server response');
  assert(diagnostics.some((item) => item.action === 'orders_canary_snapshot'));
}

function createMonitorHarness() {
  const monitorSource = between(
    '  function startTakeawayKeepAliveMonitor',
    '\n\n  // Main app window'
  );
  let now = 1_000_000;
  let intervalCallback = null;
  const actions = [];
  const safetyByPage = {
    liveOrderWin: { processing: false, acceptButtonCount: 0, visibleOrderCodes: [] },
    fertigWin: { processing: false, acceptButtonCount: 0, visibleOrderCodes: [] }
  };

  class FakeDate extends Date {
    static now() { return now; }
  }

  function fakeWindow(label) {
    return {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: async () => ({ ...safetyByPage[label] })
      }
    };
  }

  const context = {
    Date: FakeDate,
    Promise,
    Map,
    Object,
    Array,
    Number,
    String,
    Boolean,
    RegExp,
    Math,
    JSON,
    TAKEAWAY_CANARY_TOKEN_REFRESH_RETRY_MS: 30 * 1000,
    setTimeout: () => 1,
    setInterval(callback) {
      intervalCallback = callback;
      return 1;
    },
    livePushRuntimeState: new Map(),
    takeawayOrdersCanaryState: {
      installed: false,
      installedAt: 0,
      endpoint: '',
      endpointCapturedAt: 0,
      lastPollAt: 0,
      lastPollOkAt: 0,
      lastError: '',
      failureSince: 0,
      lastFailureAt: 0,
      consecutiveFailures: 0,
      pendingOrders: new Map()
    },
    normalizeTakeawayOrderCode(value) {
      const code = String(value == null ? '' : value).trim().replace(/^#/, '').toUpperCase();
      return /^[A-Z0-9]{5,10}$/.test(code) ? code : '';
    },
    emitMainDiag(eventType, payload) {
      actions.push({ kind: 'diag', eventType, ...payload });
    },
    wakeTakeawayWindow(_win, label, reason) {
      actions.push({ kind: 'wake', label, reason });
      return true;
    },
    softRefreshTakeawayWindow(_win, label, reason) {
      actions.push({ kind: 'soft', label, reason });
      return true;
    },
    scheduleWindowReload(_win, label, reason, _delay, ignoreCache) {
      actions.push({ kind: 'reload', label, reason, ignoreCache });
    },
    loadWindowUrl(_win, label, url, reason) {
      actions.push({ kind: 'load-url', label, url, reason });
    }
  };
  vm.createContext(context);
  vm.runInContext(monitorSource, context);

  const windows = {
    liveOrderWin: fakeWindow('liveOrderWin'),
    fertigWin: fakeWindow('fertigWin')
  };
  context.startTakeawayKeepAliveMonitor(windows);
  assert(intervalCallback, 'Monitor interval was not installed');

  return {
    context,
    actions,
    safetyByPage,
    windows,
    now: () => now,
    setNow(value) { now = value; },
    async tick() { await intervalCallback(); }
  };
}

function healthyRuntime(now) {
  return {
    probeInstalledAt: now - 60_000,
    rendererHeartbeatAt: now,
    pageOperational: false,
    processing: false,
    acceptButtonCount: 0,
    businessEvents: [],
    orderSocket: null
  };
}

async function testServerOrderRecovery() {
  const h = createMonitorHarness();
  const start = h.now();
  h.context.livePushRuntimeState.set('liveOrderWin', healthyRuntime(start));
  h.context.livePushRuntimeState.set('fertigWin', healthyRuntime(start));
  h.context.takeawayOrdersCanaryState.endpoint = 'https://live-orders-api.takeaway.com/api/orders';
  h.context.takeawayOrdersCanaryState.lastPollOkAt = start;
  const entry = {
    code: 'PKKM9H',
    firstSeenAt: start,
    lastSeenAt: start,
    recoveryStage: 0,
    recoveryAt: 0,
    cooldownUntil: 0,
    domSeenAt: 0,
    acknowledgedAt: 0
  };
  h.context.takeawayOrdersCanaryState.pendingOrders.set(entry.code, entry);

  h.setNow(start + 4_000);
  h.context.takeawayOrdersCanaryState.lastPollOkAt = h.now();
  entry.lastSeenAt = h.now();
  await h.tick();
  assert(!h.actions.some((item) => item.kind === 'reload'), 'Must honor the DOM grace period');

  h.setNow(start + 6_000);
  h.context.takeawayOrdersCanaryState.lastPollOkAt = h.now();
  entry.lastSeenAt = h.now();
  h.context.livePushRuntimeState.get('liveOrderWin').rendererHeartbeatAt = h.now();
  h.context.livePushRuntimeState.get('fertigWin').rendererHeartbeatAt = h.now();
  await h.tick();
  assert(
    h.actions.some((item) => item.kind === 'reload' && item.reason === 'server-order-missing-from-dom'),
    'A server order missing from DOM must hard reload'
  );

  h.setNow(start + 24_000);
  h.context.takeawayOrdersCanaryState.lastPollOkAt = h.now();
  entry.lastSeenAt = h.now();
  h.context.livePushRuntimeState.get('liveOrderWin').probeInstalledAt = start + 9_000;
  h.context.livePushRuntimeState.get('liveOrderWin').rendererHeartbeatAt = h.now();
  h.context.livePushRuntimeState.get('fertigWin').rendererHeartbeatAt = h.now();
  await h.tick();
  assert(
    h.actions.some((item) => item.kind === 'load-url' && item.reason === 'server-order-missing-after-reload'),
    'A failed hard reload must escalate to loadURL'
  );
}

async function testProcessingLock() {
  const h = createMonitorHarness();
  const start = h.now();
  h.context.livePushRuntimeState.set('liveOrderWin', healthyRuntime(start));
  h.context.livePushRuntimeState.set('fertigWin', healthyRuntime(start));
  h.context.takeawayOrdersCanaryState.endpoint = 'https://live-orders-api.takeaway.com/api/orders';
  h.context.takeawayOrdersCanaryState.lastPollOkAt = start;
  h.context.takeawayOrdersCanaryState.pendingOrders.set('LOCK77', {
    code: 'LOCK77',
    firstSeenAt: start - 10_000,
    lastSeenAt: start,
    recoveryStage: 0,
    recoveryAt: 0,
    cooldownUntil: 0,
    domSeenAt: 0,
    acknowledgedAt: 0
  });
  h.safetyByPage.fertigWin.processing = true;
  await h.tick();
  assert(!h.actions.some((item) => item.kind === 'reload'), 'Global processing lock must block reload');
}

async function testCanaryBlindFailSafeRecovery() {
  const h = createMonitorHarness();
  const start = h.now();
  const live = healthyRuntime(start);
  const fertig = healthyRuntime(start);
  live.pageOperational = true;
  fertig.pageOperational = true;
  live.orderSocket = { present: true, open: true, lastMessageAgeMs: 5000 };
  fertig.orderSocket = { present: true, open: true, lastMessageAgeMs: 6000 };
  h.context.livePushRuntimeState.set('liveOrderWin', live);
  h.context.livePushRuntimeState.set('fertigWin', fertig);

  Object.assign(h.context.takeawayOrdersCanaryState, {
    installed: true,
    installedAt: start - 60_000,
    endpoint: 'https://live-orders-api.takeaway.com/api/orders',
    endpointCapturedAt: start - 60_000,
    lastPollAt: start,
    lastPollOkAt: start - 90_000,
    lastError: 'HTTP_401',
    failureSince: start - 25_000,
    lastFailureAt: start,
    consecutiveFailures: 6
  });

  await h.tick();
  assert(
    !h.actions.some((item) => item.kind === 'reload' || item.kind === 'load-url'),
    'A canary 401 alone must not reload while renderer and order transport are healthy'
  );
  assert(
    h.actions.some((item) => item.kind === 'diag'
      && item.action === 'orders_canary_reload_suppressed_healthy'),
    'Suppressed canary-only recovery must remain visible in diagnostics'
  );

  live.orderSocket = { present: true, open: false, disconnectedAgeMs: 60_000 };
  live.mqttSocket = { present: true, open: false, disconnectedAgeMs: 60_000 };
  fertig.orderSocket = { present: true, open: false, disconnectedAgeMs: 60_000 };
  fertig.mqttSocket = { present: true, open: false, disconnectedAgeMs: 60_000 };
  h.context.takeawayOrdersCanaryState.failureSince = start - 60_000;
  h.context.takeawayOrdersCanaryState.lastFailureAt = start;
  h.context.takeawayOrdersCanaryState.consecutiveFailures = 12;
  await h.tick();
  assert(
    h.actions.some((item) => item.kind === 'reload'
      && item.label === 'liveOrderWin'
      && item.reason === 'orders-canary-auth-and-transport-unhealthy'
      && item.ignoreCache === true),
    'Canary auth and transport failures together must hard reload liveOrderWin'
  );

  h.setNow(start + 31_000);
  live.rendererHeartbeatAt = h.now();
  fertig.rendererHeartbeatAt = h.now();
  h.context.takeawayOrdersCanaryState.lastPollAt = h.now();
  h.context.takeawayOrdersCanaryState.lastFailureAt = h.now();
  h.context.takeawayOrdersCanaryState.consecutiveFailures = 12;
  await h.tick();
  assert(
    h.actions.some((item) => item.kind === 'load-url'
      && item.label === 'liveOrderWin'
      && item.reason === 'orders-canary-still-unavailable'),
    'Canary still unavailable after hard reload must escalate to loadURL'
  );
}

async function testCanaryRecoveryHonorsProcessingLock() {
  const h = createMonitorHarness();
  const start = h.now();
  const live = healthyRuntime(start);
  const fertig = healthyRuntime(start);
  live.pageOperational = true;
  fertig.pageOperational = true;
  h.context.livePushRuntimeState.set('liveOrderWin', live);
  h.context.livePushRuntimeState.set('fertigWin', fertig);
  h.safetyByPage.fertigWin.processing = true;
  Object.assign(h.context.takeawayOrdersCanaryState, {
    installed: true,
    installedAt: start - 60_000,
    endpoint: 'https://live-orders-api.takeaway.com/api/orders',
    endpointCapturedAt: start - 60_000,
    lastPollAt: start,
    lastPollOkAt: start - 90_000,
    lastError: 'HTTP_401',
    failureSince: start - 60_000,
    lastFailureAt: start,
    consecutiveFailures: 6
  });

  await h.tick();
  assert(
    !h.actions.some((item) => item.kind === 'reload' || item.kind === 'load-url'),
    'Canary fail-safe must not reload while either Takeaway tab processes an order'
  );
  assert(
    h.actions.some((item) => item.kind === 'diag'
      && item.action === 'reload_deferred_processing'
      && item.reason === 'orders-canary-auth-and-transport-unhealthy'),
    'Deferred canary recovery must be visible in diagnostics'
  );
}

async function testNoQuietReloadAndCrossTabRules() {
  const h = createMonitorHarness();
  const start = h.now();
  const live = healthyRuntime(start);
  const fertig = healthyRuntime(start);
  h.context.livePushRuntimeState.set('liveOrderWin', live);
  h.context.livePushRuntimeState.set('fertigWin', fertig);

  h.setNow(start + 4 * 60 * 60 * 1000);
  live.rendererHeartbeatAt = h.now();
  fertig.rendererHeartbeatAt = h.now();
  await h.tick();
  assert(!h.actions.some((item) => item.kind === 'reload'), 'Quiet healthy pages must not reload');

  const updateAt = h.now() - 6_000;
  fertig.businessEvents = [{ eventName: 'OrderUpdated', at: updateAt }];
  await h.tick();
  assert(
    !h.actions.some((item) => item.kind === 'reload' && item.label === 'liveOrderWin'),
    'Autofertig update events must not reload liveOrderWin'
  );

  fertig.businessEvents = [{ eventName: 'OrderCreated', at: updateAt }];
  await h.tick();
  assert(
    h.actions.some((item) => item.kind === 'reload'
      && item.label === 'liveOrderWin'
      && item.reason === 'cross-tab-business-stream-mismatch'),
    'A missed creation event must reload liveOrderWin'
  );
}

function testReloadReportDedupAndTabInference() {
  const helperSource = between(
    'function inferReloadEventDetails',
    'function getAppVersionInfo'
  );
  const context = { Date, Number, String, Math };
  vm.createContext(context);
  vm.runInContext(helperSource, context);

  const base = Date.parse('2026-08-27T01:00:00.000Z');
  const rows = [
    {
      ts: new Date(base).toISOString(), tsMs: base, category: 'diag_reload',
      page: 'liveOrderWin', reason: 'orders-canary-auth-unavailable', message: 'diag'
    },
    {
      ts: new Date(base + 1).toISOString(), tsMs: base + 1, category: 'window_reload',
      message: '[Reload] liveOrderWin -> reloadIgnoringCache() reason=orders-canary-auth-unavailable currentUrl=https://live-orders.takeaway.com/orders'
    },
    {
      ts: new Date(base + 30_000).toISOString(), tsMs: base + 30_000, category: 'window_reload',
      message: '[Reload] fertigWin -> reload() reason=nightly-3am currentUrl=https://live-orders.takeaway.com/orders?tabmode=tudongfertig'
    },
    {
      ts: new Date(base + 60_000).toISOString(), tsMs: base + 60_000, category: 'window_reload',
      message: '[ReloadKey] uberEatsWin F5 -> reload()'
    },
    {
      ts: new Date(base + 60_100).toISOString(), tsMs: base + 60_100, category: 'window_reload',
      message: '[Reload] uberEatsWin reloaded manually by user (F5/Ctrl+R)'
    }
  ];
  const deduped = context.dedupeReloadEvents(rows);
  assert.strictEqual(deduped.length, 3, 'Reload report must count one physical reload once');
  assert(deduped.some((item) => item.page === 'fertigWin' && item.reason === 'nightly-3am'));
  assert(deduped.some((item) => item.page === 'uberEatsWin' && item.reason === 'manual-f5'));
}

function testOperationalWindowFailureDetector() {
  const detectorSource = between(
    'function findOperationalWindowFailure',
    '\n\nconst hasSingleInstanceLock'
  );
  const context = { Object, isOperationalTabDisabled: () => false };
  vm.createContext(context);
  vm.runInContext(detectorSource, context);

  function healthyWindow() {
    return {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false }
    };
  }

  const healthyWindows = {
    liveOrderWin: healthyWindow(),
    fertigWin: healthyWindow(),
    uberEatsWin: healthyWindow()
  };
  assert.strictEqual(
    context.findOperationalWindowFailure(healthyWindows),
    null,
    'Healthy operational windows must not trigger recovery'
  );

  const destroyedUber = {
    ...healthyWindows,
    uberEatsWin: {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false }
    }
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.findOperationalWindowFailure(destroyedUber))),
    { label: 'uberEatsWin', reason: 'browser-window-destroyed' },
    'A destroyed Uber window must be detected'
  );

  const destroyedRenderer = {
    ...healthyWindows,
    fertigWin: {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true }
    }
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.findOperationalWindowFailure(destroyedRenderer))),
    { label: 'fertigWin', reason: 'web-contents-destroyed' },
    'A destroyed renderer must be detected'
  );

  const missingAllInOne = {
    liveOrderWin: null,
    fertigWin: healthyWindow(),
    uberEatsWin: healthyWindow()
  };
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.findOperationalWindowFailure(missingAllInOne))),
    { label: 'liveOrderWin', reason: 'missing-reference' },
    'A missing operational window reference must be detected'
  );

  assert(
    source.includes('startOperationalWindowSupervisor(operationalWindowsByLabel);')
      && /const operationalWindowsByLabel\s*=\s*\{[^}]*liveOrderWin[^}]*fertigWin[^}]*uberEatsWin[^}]*tienShipWin[^}]*\};/.test(source),
    'Operational window supervisor must be activated after all operational windows are created'
  );
  assert(
    !source.includes('forceCloseRequestAt') && !source.includes('Force-close accepted'),
    'Operational windows must not allow a second click to destroy them'
  );
}

function createOperationalSupervisorHarness(windowsByLabel) {
  const supervisorSource = between(
    '  function startOperationalWindowSupervisor',
    '\n\n  function keepWindowMaximized'
  );
  let now = 2_000_000;
  let initialCheck = null;
  let intervalCheck = null;
  const logs = [];
  const relaunches = [];

  class FakeDate extends Date {
    static now() { return now; }
  }

  const context = {
    Date: FakeDate,
    Object,
    Promise,
    _userRequestedQuit: false,
    _relaunching: false,
    findOperationalWindowFailure(windows) {
      for (const [label, browserWin] of Object.entries(windows || {})) {
        if (!browserWin) return { label, reason: 'missing-reference' };
        if (browserWin.isDestroyed()) return { label, reason: 'browser-window-destroyed' };
        if (!browserWin.webContents || browserWin.webContents.isDestroyed()) {
          return { label, reason: 'web-contents-destroyed' };
        }
      }
      return null;
    },
    logMain(message) {
      logs.push(String(message));
    },
    flushMainLogBufferSyncFallback() {},
    flushImportantEventBufferSyncFallback() {},
    triggerRelaunch(reason) {
      relaunches.push(reason);
    },
    setTimeout(callback, delayMs) {
      if (delayMs === 1500) initialCheck = callback;
      return 1;
    },
    setInterval(callback, intervalMs) {
      assert.strictEqual(intervalMs, 3000);
      intervalCheck = callback;
      return 1;
    }
  };
  vm.createContext(context);
  vm.runInContext(supervisorSource, context);
  context.startOperationalWindowSupervisor(windowsByLabel);
  assert(initialCheck && intervalCheck, 'Operational supervisor timers must be installed');

  return {
    logs,
    relaunches,
    setNow(value) { now = value; },
    now: () => now,
    async initialTick() { await initialCheck(); },
    async tick() { await intervalCheck(); }
  };
}

function operationalWindow({ destroyed = false, processing = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => processing
    }
  };
}

async function testOperationalWindowSupervisorRecovery() {
  let processing = true;
  const liveOrderWin = operationalWindow();
  liveOrderWin.webContents.executeJavaScript = async () => processing;
  const h = createOperationalSupervisorHarness({
    liveOrderWin,
    fertigWin: operationalWindow(),
    uberEatsWin: operationalWindow({ destroyed: true })
  });

  await h.initialTick();
  assert.strictEqual(h.relaunches.length, 0, 'Recovery must wait while a surviving tab processes an order');
  assert(
    h.logs.some((line) => line.includes('recovery deferred processing label=uberEatsWin')),
    'Deferred recovery must be visible in diagnostics'
  );

  processing = false;
  h.setNow(h.now() + 2000);
  await h.tick();
  assert.deepStrictEqual(
    h.relaunches,
    ['operational-window-missing:uberEatsWin:browser-window-destroyed'],
    'The whole app must relaunch after processing finishes'
  );

  const allGone = createOperationalSupervisorHarness({
    liveOrderWin: operationalWindow({ destroyed: true }),
    fertigWin: operationalWindow({ destroyed: true }),
    uberEatsWin: operationalWindow({ destroyed: true })
  });
  await allGone.initialTick();
  allGone.setNow(allGone.now() + 2000);
  await allGone.tick();
  assert.deepStrictEqual(
    allGone.relaunches,
    ['operational-window-missing:liveOrderWin:browser-window-destroyed'],
    'Losing all operational windows must relaunch the app'
  );
}

function testReportWindowResetState() {
  const stateSource = between(
    'function deriveReportWindowState',
    '\n\nfunction readReportWindowState'
  );
  const cutoffSource = between(
    'function getReportCutoffMs',
    '\n\nfunction startReportBundleDeletionMonitor'
  );
  const context = { Date, Number };
  vm.createContext(context);
  vm.runInContext(`${stateSource}\n${cutoffSource}`, context);

  const now = Date.parse('2026-06-15T14:00:00.000Z');
  const existingBundle = context.deriveReportWindowState(null, true, now);
  assert.strictEqual(existingBundle.resetAtMs, 0, 'An existing bundle must keep the current 24h history after upgrade');
  assert.strictEqual(existingBundle.resetOccurred, false);

  const deletedBundle = context.deriveReportWindowState(
    { resetAtMs: 0, bundlePresent: true },
    false,
    now
  );
  assert.strictEqual(deletedBundle.resetAtMs, now, 'Deleting the bundle must create a new report start time');
  assert.strictEqual(deletedBundle.resetOccurred, true);

  const afterRestart = context.deriveReportWindowState(
    { resetAtMs: now, bundlePresent: false },
    false,
    now + 5000
  );
  assert.strictEqual(afterRestart.resetAtMs, now, 'A restart must preserve the deletion reset time');
  assert.strictEqual(afterRestart.resetOccurred, false);

  const mirroredReports = context.deriveReportWindowState(
    {
      resetAtMs: 0,
      filesPresent: true,
      rootPairPresent: true,
      appPairPresent: true
    },
    {
      rootAnyPresent: false,
      appAnyPresent: true,
      rootPairPresent: false,
      appPairPresent: true
    },
    now
  );
  assert.strictEqual(
    mirroredReports.resetOccurred,
    true,
    'Deleting both files from either mirrored report location must reset the report window'
  );

  const partialDeletion = context.deriveReportWindowState(
    {
      resetAtMs: 0,
      filesPresent: true,
      rootPairPresent: true,
      appPairPresent: true
    },
    {
      rootAnyPresent: true,
      appAnyPresent: true,
      rootPairPresent: false,
      appPairPresent: true
    },
    now
  );
  assert.strictEqual(
    partialDeletion.resetOccurred,
    false,
    'Deleting only one of the two report files must not reset the report window'
  );

  const unavailableMirror = context.deriveReportWindowState(
    {
      resetAtMs: 0,
      filesPresent: true,
      rootPairPresent: false,
      appPairPresent: true
    },
    {
      rootAnyPresent: false,
      appAnyPresent: true,
      rootPairPresent: false,
      appPairPresent: true
    },
    now
  );
  assert.strictEqual(
    unavailableMirror.resetOccurred,
    false,
    'An output location that was never writable must not cause a repeated reset loop'
  );

  assert.strictEqual(
    context.getReportCutoffMs(now + 60 * 60 * 1000, now),
    now,
    'Report events before the deletion reset must stay excluded'
  );
  assert.strictEqual(
    context.getReportCutoffMs(now + 30 * 60 * 60 * 1000, now),
    now + 6 * 60 * 60 * 1000,
    'The report must still retain a maximum rolling window of 24 hours'
  );
}

async function main() {
  testPendingOrderParser();
  testAuthenticatedCanaryRequest();
  await testServerOrderRecovery();
  await testProcessingLock();
  await testCanaryBlindFailSafeRecovery();
  await testCanaryRecoveryHonorsProcessingLock();
  await testNoQuietReloadAndCrossTabRules();
  testReloadReportDedupAndTabInference();
  testOperationalWindowFailureDetector();
  await testOperationalWindowSupervisorRecovery();
  testReportWindowResetState();
  console.log('Takeaway and operational window recovery tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
