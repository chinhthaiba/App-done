// preload-wolt.js - bridge an toan giua Wolt Merchant Web va Electron main.
// Wolt la Flutter Web, vi vay cache JSON task tu picker-api de nut thu cong
// khong phai phu thuoc hoan toan vao CanvasKit/DOM.

const { ipcRenderer } = require('electron');

// Wolt's Flutter locale is derived from the browser language during startup.
// Keep this override isolated to the persist:wolt renderer.
const WOLT_LOCALE = 'de-DE';
const WOLT_LANGUAGES = Object.freeze(['de-DE', 'de', 'en-US', 'en']);

function installWoltGermanLocale() {
  const defineGetter = function (target, key, value) {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        get: function () { return value; }
      });
    } catch (_) {}
  };

  defineGetter(window.navigator, 'language', WOLT_LOCALE);
  defineGetter(window.navigator, 'userLanguage', WOLT_LOCALE);
  defineGetter(window.navigator, 'languages', WOLT_LANGUAGES);
  if (typeof Navigator !== 'undefined' && Navigator.prototype) {
    defineGetter(Navigator.prototype, 'language', WOLT_LOCALE);
    defineGetter(Navigator.prototype, 'userLanguage', WOLT_LOCALE);
    defineGetter(Navigator.prototype, 'languages', WOLT_LANGUAGES);
  }

  const setDocumentLanguage = function () {
    try { document.documentElement.setAttribute('lang', 'de-DE'); } catch (_) {}
  };
  setDocumentLanguage();
  window.addEventListener('DOMContentLoaded', function () {
    setDocumentLanguage();
    setTimeout(function () {
      try { window.dispatchEvent(new Event('languagechange')); } catch (_) {}
    }, 0);
  }, { once: true });
}

installWoltGermanLocale();

// Force German locale vao localStorage truoc khi Flutter doc
// Flutter Web co the cache locale trong localStorage, override tai day de chac chan
(function forceWoltLocalStorageGerman() {
  try {
    var keysToRemove = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && (
        k.includes('locale') || k.includes('language') || k.includes('lang_') ||
        k.includes('_lang') || k.includes('flutter.i18n') || k.includes('selectedLanguage') ||
        k === 'lang' || k === 'lng' || k === 'i18nextLng'
      )) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(function(k) { try { localStorage.removeItem(k); } catch(_) {} });
    try { localStorage.setItem('flutter.locale', 'de_DE'); } catch(_) {}
    try { localStorage.setItem('selectedLanguage', 'de'); } catch(_) {}
  } catch(_) {}
})();

(function installBackgroundKeepAlive() {
  const forceGetter = (target, key, getter) => {
    try {
      Object.defineProperty(target, key, { configurable: true, get: getter });
    } catch (_) {}
  };

  forceGetter(document, 'hidden', () => false);
  forceGetter(document, 'visibilityState', () => 'visible');
  try { document.hasFocus = () => true; } catch (_) {}

  const stopHiddenEvent = (event) => {
    if (document.hidden || document.visibilityState !== 'visible') {
      try { event.stopImmediatePropagation(); } catch (_) {}
    }
  };
  try { document.addEventListener('visibilitychange', stopHiddenEvent, true); } catch (_) {}
})();

window.GM_getValue = function (key, defaultValue) {
  return ipcRenderer.invoke('gm-get', key, defaultValue !== undefined ? defaultValue : null);
};

window.GM_setValue = function (key, value) {
  return ipcRenderer.invoke('gm-set', key, value);
};

window.GM_deleteValue = function (key) {
  return ipcRenderer.invoke('gm-delete', key);
};

window.GM_setClipboard = function (text) {
  try { navigator.clipboard.writeText(String(text || '')).catch(function () {}); } catch (_) {}
};

window.GM_simulateClick = function (x, y) {
  return ipcRenderer.invoke('simulate-click', { x: Math.round(x || 0), y: Math.round(y || 0) });
};

window.GM_wakeWoltRenderer = function (options) {
  return ipcRenderer.invoke('wolt-wake-renderer', options || {});
};

window.GM_restoreWindowFocus = function (token) {
  return ipcRenderer.invoke('wolt-restore-focus', token || {});
};

window.GM_notification = function (details) {
  const row = details && typeof details === 'object' ? details : { text: details };
  console.log('[ThaiAsia Wolt]', String(row.title || 'ThaiAsia'), String(row.text || ''));
};

let adminOpenSequence = 0;
window.GM_openInTab = function (url, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requestId = `wolt-admin-${Date.now().toString(36)}-${++adminOpenSequence}-${Math.random().toString(36).slice(2, 8)}`;
  const request = {
    url: String(url || ''),
    requestId,
    storageKey: String(opts.storageKey || ''),
    show: opts.show === true
  };
  ipcRenderer.send('open-admin-window', request);
  return {
    requestId,
    close: function () { ipcRenderer.send('close-admin-window', request); }
  };
};

ipcRenderer.on('admin-submit-result', function (_event, payload) {
  try {
    window.dispatchEvent(new CustomEvent('thaiasia-admin-submit-result', {
      detail: payload && typeof payload === 'object' ? payload : {}
    }));
  } catch (_) {}
});

(function installWoltNetworkCapture() {
  if (window.__thaiasiaWoltNetwork) return;

  const responses = [];
  const listeners = new Set();
  const MAX_RESPONSES = 50;
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  let lastTaskFetchRequest = null;
  let lastTaskXhrRequest = null;
  let lastWoltApiFetchRequest = null;
  let lastWoltApiXhrRequest = null;

  function isTaskResponseUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''), document.baseURI || location.href);
      return /(^|\.)picker-api\.wolt\.com$/i.test(parsed.hostname)
        && (parsed.protocol === 'wss:' || /\/tasks(?:\/|\?|$)/i.test(parsed.pathname + parsed.search));
    } catch (_) {
      return false;
    }
  }

  function isWoltApiUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''), document.baseURI || location.href);
      if (parsed.protocol === 'wss:') return true;
      // Capture ALL JSON responses from any *.wolt.com domain.
      // extractTasks() in Wolt-Bridge.js filters for task-like objects,
      // so non-order responses are safely ignored.
      return /(^|\.)(wolt\.com|wolt\.dev)$/i.test(parsed.hostname);
    } catch (_) {
      return false;
    }
  }

  function publish(meta) {
    if (!meta || meta.body == null) return;
    if (!isTaskResponseUrl(meta.url) && !isWoltApiUrl(meta.url)) return;
    const entry = {
      url: String(meta.url || ''),
      method: String(meta.method || 'GET').toUpperCase(),
      status: Number(meta.status || 0),
      capturedAt: Date.now(),
      body: meta.body
    };
    responses.push(entry);
    if (responses.length > MAX_RESPONSES) responses.splice(0, responses.length - MAX_RESPONSES);
    for (const listener of Array.from(listeners)) {
      try { listener(entry); } catch (_) {}
    }
    try {
      window.dispatchEvent(new CustomEvent('thaiasia-wolt-api-response', { detail: entry }));
    } catch (_) {}
  }

  window.__thaiasiaWoltNetwork = {
    getResponses: function () { return responses.slice(); },
    refreshTasks: async function () {
      const results = [];
      // Try the specific /tasks endpoint first
      if (nativeFetch && (lastTaskFetchRequest || lastTaskXhrRequest)) {
        try {
          let response;
          let url = '';
          if (lastTaskFetchRequest) {
            const request = lastTaskFetchRequest.clone();
            url = request.url;
            response = await nativeFetch(request);
          } else {
            url = lastTaskXhrRequest.url;
            response = await nativeFetch(url, {
              method: 'GET',
              headers: { ...lastTaskXhrRequest.headers },
              credentials: 'include',
              cache: 'no-store'
            });
          }
          let body = null;
          try { body = await response.clone().json(); } catch (_) {}
          if (body != null) publish({ url: response.url || url, method: 'GET', status: response.status, body });
          results.push({ ok: response.ok, status: response.status, source: 'tasks' });
        } catch (error) {
          results.push({ ok: false, reason: error && error.message ? error.message : String(error), source: 'tasks' });
        }
      }
      // Also try the broader Wolt API endpoint (order history, etc.)
      if (nativeFetch && (lastWoltApiFetchRequest || lastWoltApiXhrRequest)) {
        try {
          let response;
          let url = '';
          if (lastWoltApiFetchRequest) {
            const request = lastWoltApiFetchRequest.clone();
            url = request.url;
            response = await nativeFetch(request);
          } else {
            url = lastWoltApiXhrRequest.url;
            response = await nativeFetch(url, {
              method: 'GET',
              headers: { ...lastWoltApiXhrRequest.headers },
              credentials: 'include',
              cache: 'no-store'
            });
          }
          let body = null;
          try { body = await response.clone().json(); } catch (_) {}
          if (body != null) publish({ url: response.url || url, method: 'GET', status: response.status, body });
          results.push({ ok: response.ok, status: response.status, source: 'wolt_api' });
        } catch (error) {
          results.push({ ok: false, reason: error && error.message ? error.message : String(error), source: 'wolt_api' });
        }
      }
      if (!results.length) {
        return { ok: false, reason: 'no_authenticated_request_captured' };
      }
      const okResult = results.find(function (r) { return r.ok; });
      return okResult || results[0];
    },
    subscribe: function (listener) {
      if (typeof listener !== 'function') return function () {};
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }
  };

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = function () {
      const args = Array.prototype.slice.call(arguments);
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === 'string'
        ? input
        : (input instanceof URL ? input.href : ((input && input.url) || ''));
      const method = init.method || (input && input.method) || 'GET';
      if (/^GET$/i.test(method) && /\/v3\/tasks(?:\?|$)/i.test(String(url || ''))) {
        try {
          lastTaskFetchRequest = input instanceof Request
            ? new Request(input.clone(), init)
            : new Request(new URL(String(url), document.baseURI || location.href).href, init);
        } catch (_) {}
      }
      if (/^GET$/i.test(method) && isWoltApiUrl(url) && !isTaskResponseUrl(url)) {
        try {
          lastWoltApiFetchRequest = input instanceof Request
            ? new Request(input.clone(), init)
            : new Request(new URL(String(url), document.baseURI || location.href).href, init);
        } catch (_) {}
      }
      return originalFetch.apply(this, args).then(function (response) {
        if (isTaskResponseUrl(url) || isWoltApiUrl(url)) {
          try {
            response.clone().json().then(function (body) {
              publish({ url: response.url || url, method, status: response.status, body });
            }).catch(function () {});
          } catch (_) {}
        }
        return response;
      });
    };
  }

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
    const proto = window.XMLHttpRequest.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    const originalSetRequestHeader = proto.setRequestHeader;

    proto.open = function (method, url) {
      this.__thaiasiaWoltMeta = { method: method || 'GET', url: url || '', headers: {} };
      return originalOpen.apply(this, arguments);
    };

    proto.setRequestHeader = function (name, value) {
      const meta = this.__thaiasiaWoltMeta;
      if (meta && meta.headers) meta.headers[String(name || '')] = String(value || '');
      return originalSetRequestHeader.apply(this, arguments);
    };

    proto.send = function () {
      const xhr = this;
      const meta = xhr.__thaiasiaWoltMeta || {};
      if (/^GET$/i.test(meta.method || '') && /\/v3\/tasks(?:\?|$)/i.test(String(meta.url || ''))) {
        lastTaskXhrRequest = {
          url: String(meta.url || ''),
          headers: { ...(meta.headers || {}) }
        };
      }
      if (/^GET$/i.test(meta.method || '') && isWoltApiUrl(meta.url) && !isTaskResponseUrl(meta.url)) {
        lastWoltApiXhrRequest = {
          url: String(meta.url || ''),
          headers: { ...(meta.headers || {}) }
        };
      }
      if (isTaskResponseUrl(meta.url) || isWoltApiUrl(meta.url)) {
        xhr.addEventListener('load', function () {
          try {
            let body;
            if (xhr.responseType === 'json') body = xhr.response;
            else if (!xhr.responseType || xhr.responseType === 'text') body = JSON.parse(xhr.responseText || 'null');
            if (body != null) publish({
              url: xhr.responseURL || meta.url,
              method: meta.method,
              status: xhr.status,
              body
            });
          } catch (_) {}
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }

  if (typeof window.WebSocket === 'function') {
    const OriginalWebSocket = window.WebSocket;
    function ThaiAsiaWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      if (isTaskResponseUrl(url)) {
        socket.addEventListener('message', function (event) {
          if (typeof event.data !== 'string') return;
          try {
            const body = JSON.parse(event.data);
            publish({ url, method: 'WEBSOCKET', status: 200, body });
          } catch (_) {}
        });
      }
      return socket;
    }
    ThaiAsiaWebSocket.prototype = OriginalWebSocket.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { ThaiAsiaWebSocket[key] = OriginalWebSocket[key]; } catch (_) {}
    }
    window.WebSocket = ThaiAsiaWebSocket;
  }
})();

console.log('[ThaiAsia Electron] Wolt preload, GM_* and task response capture installed.');

(function installWoltAutoLoginWatcher() {
  function triggerSemantics() {
    try {
      const placeholders = document.querySelectorAll('flt-semantics-placeholder');
      for (let i = 0; i < placeholders.length; i++) placeholders[i].click();
    } catch (_) {}
  }

  // Run initial triggers
  setTimeout(triggerSemantics, 1500);
  setTimeout(triggerSemantics, 3500);

  // Watch for login screen appearing (on startup or after manual logout)
  let lastIpcSent = 0;
  setInterval(() => {
    try {
      triggerSemantics();
      const u = document.querySelector('input[aria-label="Benutzername"]')
        || Array.from(document.querySelectorAll('input, flt-semantics')).find(el => (el.getAttribute('aria-label') || '').trim() === 'Benutzername');
      const p = document.querySelector('input[aria-label="Passwort"]')
        || document.querySelector('input#current-password')
        || Array.from(document.querySelectorAll('input, flt-semantics')).find(el => (el.getAttribute('aria-label') || '').trim() === 'Passwort');

      if (u && p) {
        if (typeof ipcRenderer !== 'undefined' && Date.now() - lastIpcSent > 10000) {
          lastIpcSent = Date.now();
          console.log('[WoltWatcher] Login form detected, requesting auto-login...');
          ipcRenderer.send('thaiasia-wolt-native-autologin');
        }
      }
    } catch (_) {}
  }, 2500);
})();

