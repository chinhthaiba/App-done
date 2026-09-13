// preload-liveorder.js — GM_* polyfills for the live-orders BrowserWindow
// Runs before page scripts; exposes Tampermonkey-compatible APIs via Electron IPC
// so ThaiAsia-AllInOneapp.js can share state with the admin window.

const { ipcRenderer } = require('electron');

function getThaiAsiaPageLabel() {
  try {
    const arg = (process.argv || []).find((x) => String(x || '').startsWith('--thaiasia-page='));
    if (arg) return String(arg).split('=').slice(1).join('=') || 'liveOrderWin';
  } catch (_) {}
  return 'liveOrderWin';
}

const THAIASIA_PAGE_LABEL = getThaiAsiaPageLabel();

// Keep Takeaway from treating this Electron window as a deeply backgrounded tab.
(function patchTakeawayVisibilityAndFocus() {
  if (window.__thaiasiaTakeawayVisibilityPatched) return;
  window.__thaiasiaTakeawayVisibilityPatched = true;

  try {
    const forceProp = (target, key, getter) => {
      try { Object.defineProperty(target, key, { get: getter, configurable: true }); } catch (_) {}
    };
    const docProto = Object.getPrototypeOf(document);
    const alwaysVisible = () => 'visible';
    const alwaysFalse = () => false;
    const alwaysTrue = () => true;

    forceProp(document, 'visibilityState', alwaysVisible);
    forceProp(docProto, 'visibilityState', alwaysVisible);
    forceProp(document, 'webkitVisibilityState', alwaysVisible);
    forceProp(docProto, 'webkitVisibilityState', alwaysVisible);
    forceProp(document, 'hidden', alwaysFalse);
    forceProp(docProto, 'hidden', alwaysFalse);
    forceProp(document, 'webkitHidden', alwaysFalse);
    forceProp(docProto, 'webkitHidden', alwaysFalse);
    forceProp(document, 'msHidden', alwaysFalse);
    forceProp(docProto, 'msHidden', alwaysFalse);

    try { Object.defineProperty(document, 'hasFocus', { value: alwaysTrue, configurable: true }); } catch (_) {}
    try { Object.defineProperty(docProto, 'hasFocus', { value: alwaysTrue, configurable: true }); } catch (_) {}

    const swallow = (e) => e.stopImmediatePropagation();
    ['visibilitychange', 'webkitvisibilitychange', 'msvisibilitychange'].forEach((ev) => {
      document.addEventListener(ev, swallow, true);
    });
    ['blur', 'pagehide', 'freeze'].forEach((ev) => {
      window.addEventListener(ev, swallow, true);
    });
  } catch (_) {}
})();

// Observe renderer health, each WebSocket independently, and server/order state.
// Runtime heartbeats go over IPC; only investigation-worthy snapshots enter the report.
(function installLivePushDiagnostics() {
  if (window.__thaiasiaLivePushDiagnosticsInstalled) return;
  window.__thaiasiaLivePushDiagnosticsInstalled = true;

  const STATE_KEY = `thaiasia_live_push_diag_state_v2_${THAIASIA_PAGE_LABEL}`;
  const RENDERER_HEARTBEAT_MS = 10 * 1000;
  const REPORT_HEALTH_MS = 60 * 1000;
  const MESSAGE_SAMPLE_INTERVAL_MS = 30 * 1000;
  const ORDER_DOM_GRACE_MS = 7 * 1000;
  const ANONYMOUS_PUSH_DOM_GRACE_MS = 12 * 1000;
  const sockets = new Map();
  const pendingOrderChecks = new Map();
  const pendingAnonymousPushChecks = new Map();
  const recentlyHandledOrders = new Map();
  let nextSocketId = 1;
  let nextAnonymousPushId = 1;
  let lastHealthReportAt = 0;
  let lastServerSnapshotLogAt = 0;
  let lastOrderActivityAt = 0;
  let lastOrderActivityAction = '';
  let incomingPushCount = 0;

  const state = {
    installedAt: Date.now(),
    rendererHeartbeatAt: Date.now(),
    wsOpenCount: 0,
    wsCloseCount: 0,
    wsErrorCount: 0,
    wsMessageCount: 0,
    esOpenCount: 0,
    esErrorCount: 0,
    esMessageCount: 0,
    lastMessageSampleAt: 0
  };

  function buildRow(action, payload) {
    return {
      v: 2,
      module: 'livepush',
      page: THAIASIA_PAGE_LABEL,
      eventType: 'live_push',
      action,
      ts: new Date().toISOString(),
      ...(payload || {})
    };
  }

  function sendRuntime(action, payload, writeReport) {
    try {
      const row = buildRow(action, payload);
      ipcRenderer.send('takeaway-health', row);
      if (writeReport) console.warn('[ThaiAsiaDiag] ' + JSON.stringify(row));
    } catch (_) {}
  }

  function emitDiag(action, payload) {
    sendRuntime(action, payload, true);
  }

  function shortUrl(raw) {
    try {
      const u = new URL(String(raw || ''));
      return `${u.origin}${u.pathname}`;
    } catch (_) {
      return String(raw || '').slice(0, 160);
    }
  }

  function socketKind(rawUrl) {
    const url = String(rawUrl || '').toLowerCase();
    if (url.includes('live-orders-socket.takeaway.com') || url.includes('socket.io')) return 'orders_socket';
    if (url.includes('.amazonaws.com/mqtt') || url.includes('/mqtt')) return 'mqtt';
    return 'other';
  }

  function latestSocket(kind) {
    let latest = null;
    for (const socket of sockets.values()) {
      if (socket.kind !== kind) continue;
      if (!latest || socket.createdAt > latest.createdAt) latest = socket;
    }
    return latest;
  }

  function socketSummary(kind, nowTs) {
    const socket = latestSocket(kind);
    if (!socket) {
      return {
        present: false,
        readyState: null,
        open: false,
        openedAgeMs: null,
        lastMessageAgeMs: null,
        lastBusinessAgeMs: null,
        disconnectedAgeMs: null,
        url: ''
      };
    }
    return {
      present: true,
      readyState: socket.readyState,
      open: socket.readyState === 1,
      openedAgeMs: socket.openedAt > 0 ? nowTs - socket.openedAt : null,
      lastMessageAgeMs: socket.lastMessageAt > 0 ? nowTs - socket.lastMessageAt : null,
      lastBusinessAgeMs: socket.lastBusinessAt > 0 ? nowTs - socket.lastBusinessAt : null,
      disconnectedAgeMs: socket.closedAt > 0 ? nowTs - socket.closedAt : null,
      url: socket.url
    };
  }

  function isProcessingOrder() {
    try { return !!window.__thaiasiaOrderProcessing; } catch (_) { return false; }
  }

  function getAcceptButtonCount() {
    try {
      return Array.from(document.querySelectorAll('button,a,div[role="button"],span[role="button"]'))
        .filter((el) => /^(annehmen|accept)$/i.test(String(el.innerText || el.textContent || '').trim()))
        .length;
    } catch (_) {
      return 0;
    }
  }

  function documentContainsOrderCode(orderCode) {
    const code = String(orderCode || '').trim().toUpperCase();
    if (!code || !document.body) return false;
    try {
      return String(document.body.innerText || document.body.textContent || '').toUpperCase().includes(code);
    } catch (_) {
      return false;
    }
  }

  function normalizeOrderCode(value) {
    const code = String(value == null ? '' : value).trim().replace(/^#/, '').toUpperCase();
    return /^[A-Z0-9]{5,10}$/.test(code) ? code : '';
  }

  function collectOrderSignals(value) {
    const codes = new Set();
    const statuses = new Set();
    const seen = new Set();
    let visited = 0;

    function walk(node, depth) {
      if (depth > 7 || visited > 800 || node == null) return;
      if (typeof node === 'string') {
        const text = node.trim();
        if ((text.startsWith('{') || text.startsWith('[')) && text.length <= 200000) {
          try { walk(JSON.parse(text), depth + 1); } catch (_) {}
        }
        return;
      }
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      visited += 1;

      if (Array.isArray(node)) {
        for (const item of node) walk(item, depth + 1);
        return;
      }

      for (const [rawKey, rawValue] of Object.entries(node)) {
        const key = String(rawKey || '').toLowerCase();
        const isOrderCodeKey = [
          'ordercode', 'shortcode', 'shortid', 'displaycode', 'displayid',
          'friendlyid', 'ordernumber', 'orderreference', 'shortreference',
          'friendlyorderreference'
        ].includes(key)
          || (/order/.test(key) && /(code|number|displayid|friendlyid|reference|shortid)$/.test(key));
        if (isOrderCodeKey) {
          const code = normalizeOrderCode(rawValue);
          if (code) codes.add(code);
        }
        if (['status', 'state', 'orderstatus'].includes(key) && typeof rawValue === 'string') {
          statuses.add(rawValue.toLowerCase());
        }
        if (rawValue && (typeof rawValue === 'object'
            || (typeof rawValue === 'string' && /^[\[{]/.test(rawValue.trim())))) {
          walk(rawValue, depth + 1);
        }
      }
    }

    walk(value, 0);
    return { codes: Array.from(codes), statuses: Array.from(statuses) };
  }

  function isPendingOrderStatus(statuses) {
    return statuses.some((status) => (
      /\b(new|pending|placed|received|incoming|unaccepted|awaiting|created|unconfirmed|open)\b/i.test(status)
      || /\bnot[_\s-]+(accepted|confirmed)\b/i.test(status)
    ));
  }

  function collectPendingOrderCodes(value) {
    const codes = new Set();
    const seen = new Set();
    let visited = 0;

    function walk(node, depth) {
      if (depth > 7 || visited > 800 || node == null || typeof node !== 'object') return;
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
        const isOrderCodeKey = [
          'ordercode', 'shortcode', 'shortid', 'displaycode', 'displayid',
          'friendlyid', 'ordernumber', 'orderreference', 'shortreference',
          'friendlyorderreference'
        ].includes(key)
          || (/order/.test(key) && /(code|number|displayid|friendlyid|reference|shortid)$/.test(key));
        if (isOrderCodeKey) {
          const code = normalizeOrderCode(rawValue);
          if (code) localCodes.push(code);
        }
        if (['status', 'state', 'orderstatus'].includes(key) && typeof rawValue === 'string') {
          localStatuses.push(rawValue.toLowerCase());
        }
        if (/(pending|unaccepted|new|incoming)/.test(key) && rawValue === true) {
          localStatuses.push(key);
        }
        if (/(accepted|confirmed)/.test(key) && rawValue === false) {
          localStatuses.push(`not_${key}`);
        }
      }
      if (localCodes.length && isPendingOrderStatus(localStatuses)) {
        for (const code of localCodes) codes.add(code);
      }
      for (const child of Object.values(node)) {
        if (child && typeof child === 'object') walk(child, depth + 1);
      }
    }

    walk(value, 0);
    return Array.from(codes);
  }

  function scheduleOrderDomCheck(orderCode, source, details) {
    if (THAIASIA_PAGE_LABEL !== 'liveOrderWin') return;
    const code = normalizeOrderCode(orderCode);
    if (!code || pendingOrderChecks.has(code)) return;

    if (documentContainsOrderCode(code)) {
      emitDiag('order_visible_in_dom', { orderCode: code, source });
      return;
    }

    const timer = setTimeout(() => {
      pendingOrderChecks.delete(code);
      const handledAt = Number(recentlyHandledOrders.get(code) || 0);
      if (handledAt > 0 && Date.now() - handledAt < 5 * 60 * 1000) return;
      if (isProcessingOrder()) {
        setTimeout(() => scheduleOrderDomCheck(code, source, details), 5 * 1000);
        return;
      }
      if (documentContainsOrderCode(code) || getAcceptButtonCount() > 0) {
        emitDiag('order_visible_in_dom', {
          orderCode: code,
          source,
          matchedBy: documentContainsOrderCode(code) ? 'order_code' : 'accept_button'
        });
        return;
      }
      emitDiag(source === 'socket_push' ? 'push_dom_timeout' : 'server_dom_mismatch', {
        orderCode: code,
        source,
        graceMs: ORDER_DOM_GRACE_MS,
        ...(details || {})
      });
    }, ORDER_DOM_GRACE_MS);
    pendingOrderChecks.set(code, timer);
  }

  function scheduleAnonymousIncomingPushCheck(details) {
    if (THAIASIA_PAGE_LABEL !== 'liveOrderWin') return;
    const pushAt = Date.now();
    const checkId = nextAnonymousPushId++;
    const baselineActivityAt = lastOrderActivityAt;
    const baselineAcceptCount = getAcceptButtonCount();
    incomingPushCount += 1;

    const timer = setTimeout(() => {
      pendingAnonymousPushChecks.delete(checkId);
      const activityAcknowledged = lastOrderActivityAt > pushAt
        && /cycle_start|send_result|accept_|cycle_done|resume_/i.test(lastOrderActivityAction);
      const acceptButtonCount = getAcceptButtonCount();
      if (activityAcknowledged || isProcessingOrder() || acceptButtonCount > baselineAcceptCount || acceptButtonCount > 0) {
        emitDiag('anonymous_push_acknowledged', {
          pushAt,
          eventName: String(details && details.eventName || ''),
          matchedBy: activityAcknowledged ? 'order_activity' : (isProcessingOrder() ? 'processing' : 'accept_button'),
          orderAction: lastOrderActivityAction,
          acceptButtonCount
        });
        return;
      }
      emitDiag('push_dom_timeout_anonymous', {
        pushAt,
        eventName: String(details && details.eventName || ''),
        graceMs: ANONYMOUS_PUSH_DOM_GRACE_MS,
        baselineActivityAt,
        lastOrderActivityAt,
        lastOrderActivityAction,
        baselineAcceptCount,
        acceptButtonCount
      });
    }, ANONYMOUS_PUSH_DOM_GRACE_MS);
    pendingAnonymousPushChecks.set(checkId, timer);
  }

  function parseSocketIoEvent(text) {
    if (typeof text !== 'string' || !text.startsWith('42')) return null;
    try {
      const arrayPos = text.indexOf('[');
      if (arrayPos < 0) return null;
      const payload = JSON.parse(text.slice(arrayPos));
      if (!Array.isArray(payload) || typeof payload[0] !== 'string') return null;
      return { eventName: payload[0], payload: payload[1] };
    } catch (_) {
      return null;
    }
  }

  function inspectSocketBusinessMessage(socket, data) {
    if (socket.kind !== 'orders_socket' || typeof data !== 'string') return;
    const parsed = parseSocketIoEvent(data);
    if (!parsed) return;

    const signal = collectOrderSignals(parsed.payload);
    const eventName = String(parsed.eventName || '');
    const isOrderEvent = /order/i.test(eventName);
    if (!isOrderEvent) return;

    socket.lastBusinessAt = Date.now();
    emitDiag('order_business_message', {
      socketKind: socket.kind,
      eventName: eventName.slice(0, 100),
      orderCodes: signal.codes.slice(0, 8),
      statuses: signal.statuses.slice(0, 8)
    });

    const incoming = /(new|created|placed|received|incoming|pending)/i.test(eventName)
      || isPendingOrderStatus(signal.statuses);
    if (incoming) {
      for (const code of signal.codes) {
        scheduleOrderDomCheck(code, 'socket_push', { eventName: eventName.slice(0, 100) });
      }
      if (!signal.codes.length) {
        scheduleAnonymousIncomingPushCheck({ eventName: eventName.slice(0, 100) });
      }
    }
  }

  function writeState(snapshot) {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        ...state,
        ...(snapshot || {}),
        updatedAt: Date.now()
      }));
    } catch (_) {}
  }

  function buildHealthSnapshot() {
    const nowTs = Date.now();
    const orderSocket = socketSummary('orders_socket', nowTs);
    const mqttSocket = socketSummary('mqtt', nowTs);
    const pageUrl = String(location.href || '');
    let pageOperational = false;
    try {
      const parsedUrl = new URL(pageUrl);
      pageOperational = parsedUrl.hostname === 'live-orders.takeaway.com'
        && /^\/orders(?:\/|$)/i.test(parsedUrl.pathname);
    } catch (_) {}
    return {
      rendererHeartbeatAt: nowTs,
      processing: isProcessingOrder(),
      documentReadyState: document.readyState,
      pageUrl: pageUrl.slice(0, 240),
      pageOperational,
      acceptButtonCount: getAcceptButtonCount(),
      lastOrderActivityAgeMs: lastOrderActivityAt > 0 ? nowTs - lastOrderActivityAt : null,
      lastOrderActivityAction,
      incomingPushCount,
      pendingAnonymousPushChecks: pendingAnonymousPushChecks.size,
      orderSocket,
      mqttSocket,
      wsOpenCount: state.wsOpenCount,
      wsCloseCount: state.wsCloseCount,
      wsErrorCount: state.wsErrorCount,
      wsMessageCount: state.wsMessageCount,
      esOpenCount: state.esOpenCount,
      esErrorCount: state.esErrorCount,
      esMessageCount: state.esMessageCount,
      lastLiveSignalAgeMs: orderSocket.lastMessageAgeMs
    };
  }

  function sendRendererHeartbeat() {
    const snapshot = buildHealthSnapshot();
    state.rendererHeartbeatAt = snapshot.rendererHeartbeatAt;
    writeState(snapshot);
    sendRuntime('renderer_heartbeat', snapshot, false);

    if (snapshot.rendererHeartbeatAt - lastHealthReportAt >= REPORT_HEALTH_MS) {
      lastHealthReportAt = snapshot.rendererHeartbeatAt;
      emitDiag('health', snapshot);
    }
  }

  window.addEventListener('thaiasia-order-activity', (event) => {
    try {
      const detail = event && event.detail ? event.detail : {};
      lastOrderActivityAt = Date.now();
      lastOrderActivityAction = String(detail.action || '');
      if (detail.orderCode) {
        const code = normalizeOrderCode(detail.orderCode);
        if (code && ['accept_clicked', 'cycle_done', 'resume_accept_clicked'].includes(lastOrderActivityAction)) {
          recentlyHandledOrders.set(code, Date.now());
        }
        const timer = pendingOrderChecks.get(code);
        if (timer) {
          clearTimeout(timer);
          pendingOrderChecks.delete(code);
        }
      }
      sendRuntime('order_activity_seen', {
        processing: isProcessingOrder(),
        orderAction: lastOrderActivityAction,
        orderCode: normalizeOrderCode(detail.orderCode)
      }, false);
    } catch (_) {}
  });

  try {
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket === 'function') {
      function ThaiAsiaWebSocket(url, protocols) {
        const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        const urlShort = shortUrl(url);
        const socket = {
          id: nextSocketId++,
          url: urlShort,
          kind: socketKind(urlShort),
          createdAt: Date.now(),
          openedAt: 0,
          closedAt: 0,
          lastMessageAt: 0,
          lastBusinessAt: 0,
          readyState: ws.readyState
        };
        sockets.set(socket.id, socket);

        ws.addEventListener('open', () => {
          socket.readyState = 1;
          socket.openedAt = Date.now();
          socket.closedAt = 0;
          state.wsOpenCount += 1;
          emitDiag('ws_open', {
            socketKind: socket.kind,
            url: urlShort,
            wsOpenCount: state.wsOpenCount
          });
        });
        ws.addEventListener('message', (event) => {
          socket.readyState = ws.readyState;
          socket.lastMessageAt = Date.now();
          state.wsMessageCount += 1;
          inspectSocketBusinessMessage(socket, event.data);

          const meta = {
            socketKind: socket.kind,
            url: urlShort,
            bytes: typeof event.data === 'string' ? event.data.length : 0,
            wsMessageCount: state.wsMessageCount,
            lastLiveSignalAgeMs: 0
          };
          sendRuntime('ws_message', meta, false);
          if (Date.now() - state.lastMessageSampleAt >= MESSAGE_SAMPLE_INTERVAL_MS) {
            state.lastMessageSampleAt = Date.now();
            emitDiag('ws_message', meta);
          }
        });
        ws.addEventListener('close', (event) => {
          socket.readyState = 3;
          socket.closedAt = Date.now();
          state.wsCloseCount += 1;
          emitDiag('ws_close', {
            socketKind: socket.kind,
            url: urlShort,
            code: event && event.code,
            reason: event && event.reason,
            wasClean: event && event.wasClean,
            wsCloseCount: state.wsCloseCount
          });
        });
        ws.addEventListener('error', () => {
          socket.readyState = ws.readyState;
          state.wsErrorCount += 1;
          emitDiag('ws_error', {
            socketKind: socket.kind,
            url: urlShort,
            wsErrorCount: state.wsErrorCount
          });
        });
        return ws;
      }

      ThaiAsiaWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(ThaiAsiaWebSocket, NativeWebSocket);
      ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((key) => {
        try { Object.defineProperty(ThaiAsiaWebSocket, key, { value: NativeWebSocket[key] }); } catch (_) {}
      });
      window.WebSocket = ThaiAsiaWebSocket;
    }
  } catch (err) {
    emitDiag('ws_patch_failed', { error: String((err && err.message) || err || '') });
  }

  try {
    const NativeEventSource = window.EventSource;
    if (typeof NativeEventSource === 'function') {
      function ThaiAsiaEventSource(url, config) {
        const es = config === undefined ? new NativeEventSource(url) : new NativeEventSource(url, config);
        const urlShort = shortUrl(url);
        es.addEventListener('open', () => {
          state.esOpenCount += 1;
          emitDiag('es_open', { url: urlShort, esOpenCount: state.esOpenCount });
        });
        es.addEventListener('message', () => {
          state.esMessageCount += 1;
          sendRuntime('es_message', { url: urlShort, esMessageCount: state.esMessageCount }, false);
        });
        es.addEventListener('error', () => {
          state.esErrorCount += 1;
          emitDiag('es_error', { url: urlShort, esErrorCount: state.esErrorCount, readyState: es.readyState });
        });
        return es;
      }

      ThaiAsiaEventSource.prototype = NativeEventSource.prototype;
      Object.setPrototypeOf(ThaiAsiaEventSource, NativeEventSource);
      window.EventSource = ThaiAsiaEventSource;
    }
  } catch (err) {
    emitDiag('es_patch_failed', { error: String((err && err.message) || err || '') });
  }

  // Observe the page's real orders response. Active polling lives in main.js,
  // where Electron can reuse the authenticated session without browser CORS.
  if (THAIASIA_PAGE_LABEL === 'liveOrderWin') {
    const isOrdersApiUrl = (rawUrl) => {
      try {
        const url = new URL(String(rawUrl || ''), location.href);
        return url.protocol === 'https:'
          && url.hostname === 'live-orders-api.takeaway.com'
          && url.pathname.replace(/\/+$/, '') === '/api/orders';
      } catch (_) {
        return false;
      }
    };

    const inspectOrderResponse = (rawUrl, payload) => {
      try {
        const url = String(rawUrl || '');
        if (!isOrdersApiUrl(url)) return;
        const signal = collectOrderSignals(payload);
        const pendingCodes = collectPendingOrderCodes(payload);
        if (!pendingCodes.length) return;
        if (Date.now() - lastServerSnapshotLogAt >= 30 * 1000) {
          lastServerSnapshotLogAt = Date.now();
          emitDiag('server_pending_orders', {
            sourceUrl: shortUrl(url),
            orderCodes: pendingCodes.slice(0, 8),
            statuses: signal.statuses.slice(0, 8)
          });
        }
        for (const code of pendingCodes) {
          scheduleOrderDomCheck(code, 'server_api', { sourceUrl: shortUrl(url) });
        }
      } catch (_) {}
    };

    try {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch === 'function') {
        window.fetch = function (...args) {
          const result = nativeFetch.apply(this, args);
          result.then((response) => {
            try {
              if (!isOrdersApiUrl(response.url || args[0])) return;
              const contentType = String(response.headers && response.headers.get('content-type') || '');
              if (!/json/i.test(contentType)) return;
              response.clone().json().then((body) => inspectOrderResponse(response.url || args[0], body)).catch(() => {});
            } catch (_) {}
          }).catch(() => {});
          return result;
        };
      }
    } catch (err) {
      emitDiag('fetch_patch_failed', { error: String((err && err.message) || err || '') });
    }

    try {
      const nativeOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__thaiasiaObservedUrl = String(url || '');
        this.addEventListener('load', () => {
          try {
            const responseUrl = this.responseURL || this.__thaiasiaObservedUrl;
            if (!isOrdersApiUrl(responseUrl)) return;
            const contentType = String(this.getResponseHeader('content-type') || '');
            if (!/json/i.test(contentType)) return;
            const body = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            inspectOrderResponse(responseUrl, body);
          } catch (_) {}
        }, { once: true });
        return nativeOpen.call(this, method, url, ...rest);
      };
    } catch (err) {
      emitDiag('xhr_patch_failed', { error: String((err && err.message) || err || '') });
    }
  }

  emitDiag('probe_installed', {
    hasWebSocket: typeof window.WebSocket === 'function',
    hasEventSource: typeof window.EventSource === 'function',
    rendererHeartbeatMs: RENDERER_HEARTBEAT_MS
  });
  sendRendererHeartbeat();
  setInterval(sendRendererHeartbeat, RENDERER_HEARTBEAT_MS);
})();

// ── Force German language BEFORE React initializes ────────────────────────────
// dom-ready injection races with React startup (1-in-7 times React reads localStorage
// before executeJavaScript runs). Preload is synchronous and guaranteed to run first.
try {
  // Set initial values
  localStorage.setItem('lang', 'de');
  localStorage.setItem('orig_lang', 'de');

  // Patch localStorage.setItem so React can NEVER override lang back to English
  const _origSetItem = localStorage.setItem.bind(localStorage);
  const _origRemoveItem = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = function (key, value) {
    if (key === 'lang' || key === 'orig_lang') {
      return _origSetItem(key, 'de'); // always force German
    }
    return _origSetItem(key, value);
  };
  localStorage.removeItem = function (key) {
    if (key === 'lang' || key === 'orig_lang') {
      return; // never let React remove the language key
    }
    return _origRemoveItem(key);
  };
} catch (_) {}

// ── GM_* polyfills ────────────────────────────────────────────────────────────
// GM_getValue / GM_setValue / GM_deleteValue: backed by a shared Map in the
// main process, accessible from both the live-orders and admin windows.

window.GM_getValue = function (key, defaultValue) {
  return ipcRenderer.invoke('gm-get', key, defaultValue !== undefined ? defaultValue : null);
};

window.GM_setValue = function (key, value) {
  return ipcRenderer.invoke('gm-set', key, value);
};

window.GM_deleteValue = function (key) {
  return ipcRenderer.invoke('gm-delete', key);
};

// GM_setClipboard: fire-and-forget clipboard write
window.GM_setClipboard = function (text) {
  try {
    navigator.clipboard.writeText(String(text || '')).catch(function () {});
  } catch (e) {}
};

// GM_notification: log to console (no native notification needed in background)
window.GM_xmlhttpRequest = function (options) {
  return ipcRenderer.invoke('gm-xmlhttp-request', options);
};

window.GM_notification = function (details) {
  const text = typeof details === 'string' ? details : ((details && details.text) || '');
  const title = (typeof details === 'object' && details && details.title) ? details.title : 'ThaiAsia';
  console.log('[GM_notification]', title + ':', text);
};

// GM_openInTab: every call gets an isolated request id and carries the exact
// order storage key so concurrent Takeaway/Uber admin forms cannot cross-read.
let adminOpenSequence = 0;
window.GM_openInTab = function (url, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requestId = `live-${Date.now().toString(36)}-${++adminOpenSequence}-${Math.random().toString(36).slice(2, 8)}`;
  const request = {
    url: String(url || ''),
    requestId,
    storageKey: String(opts.storageKey || ''),
    show: opts.show === true || opts.active === true
  };
  ipcRenderer.send('open-admin-window', request);
  return { close: function () { ipcRenderer.send('close-admin-window', request); } };
};

console.log('[ThaiAsia Electron] GM_* polyfills installed on live-orders window');

(function installTakeawayAutoLogin() {
  const USERNAME = 'thaiasiasushibar';
  const PASSWORD = 'Thaiasiasushibar@321';

  function setFieldValue(el, val) {
    if (!el || val === undefined || val === null) return;
    el.focus();
    const prev = el.value;
    el.value = val;
    if (el._valueTracker) {
      try { el._valueTracker.setValue(prev); } catch (_) {}
    }
    try {
      const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, val);
    } catch (_) {}
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
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

  let submitCooldown = 0;

  function checkAndFillTakeaway() {
    const isLoginHost = location.hostname.includes('takeaway.com');
    if (!isLoginHost) return;

    const allInputs = Array.from(document.querySelectorAll('input')).filter(el => {
      try {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.type !== 'hidden' && !el.disabled;
      } catch (_) { return false; }
    });

    if (allInputs.length === 0) return;

    const passInput = allInputs.find(el => el.type === 'password');
    const userInput = allInputs.find(el => el !== passInput && (el.type === 'text' || el.type === 'email' || !el.type || el.name.toLowerCase().includes('user') || el.name.toLowerCase().includes('email')));

    if (userInput && passInput) {
      if (userInput.value !== USERNAME) setFieldValue(userInput, USERNAME);
      if (passInput.value !== PASSWORD) setFieldValue(passInput, PASSWORD);

      if (Date.now() - submitCooldown > 3000) {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(el => {
          try {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
          } catch (_) { return false; }
        });
        const submitBtn = buttons.find(b => {
          const txt = (b.textContent || b.value || '').toLowerCase();
          return txt.includes('anmelden') || txt.includes('log in') || txt.includes('đăng nhập') || b.type === 'submit';
        }) || buttons[0];

        if (submitBtn) {
          submitCooldown = Date.now();
          setTimeout(() => clickBtn(submitBtn), 600);
        }
      }
    }
  }

  setInterval(checkAndFillTakeaway, 1000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndFillTakeaway);
  } else {
    checkAndFillTakeaway();
  }
})();
