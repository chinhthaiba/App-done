// preload-ubereats.js — GM_* polyfills for the UberEats BrowserWindow
// Mirrors preload-liveorder.js so UberEats-Bridge.js can share state with the admin window.

const { ipcRenderer } = require('electron');

const UBER_LANGUAGE_PROFILES = {
  vi: {
    locale: 'vi-VN',
    short: 'vi',
    languages: ['vi-VN', 'vi', 'en-US', 'en', 'de-DE', 'de'],
  },
  de: {
    locale: 'de-DE',
    short: 'de',
    languages: ['de-DE', 'de', 'en-US', 'en', 'vi-VN', 'vi'],
  },
};

function normalizeUberLanguageMode(value) {
  return String(value || '').toLowerCase() === 'de' ? 'de' : 'vi';
}

function readUberLanguageMode() {
  try {
    return normalizeUberLanguageMode(ipcRenderer.sendSync('uber-language-mode-get'));
  } catch (_) {
    return 'vi';
  }
}

let UBER_LANGUAGE_MODE = readUberLanguageMode();
let UBER_LANGUAGE_PROFILE = UBER_LANGUAGE_PROFILES[UBER_LANGUAGE_MODE];

function applyUberLanguageMode(mode) {
  UBER_LANGUAGE_MODE = normalizeUberLanguageMode(mode);
  UBER_LANGUAGE_PROFILE = UBER_LANGUAGE_PROFILES[UBER_LANGUAGE_MODE];
  forceNavigatorLanguage();
  forceUberLocaleStorage();
  try { document.documentElement.setAttribute('lang', UBER_LANGUAGE_PROFILE.short); } catch (_) {}
  return UBER_LANGUAGE_MODE;
}

async function clearUberPageCaches() {
  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(registration => registration.unregister()));
    }
  } catch (_) {}

  try {
    if (window.caches && typeof window.caches.keys === 'function') {
      const cacheNames = await window.caches.keys();
      await Promise.all(cacheNames.map(cacheName => window.caches.delete(cacheName)));
    }
  } catch (_) {}
}

function forceNavigatorLanguage() {
  const defineGetter = (target, key, value) => {
    try {
      Object.defineProperty(target, key, { get: () => value, configurable: true });
      return true;
    } catch (_) {
      return false;
    }
  };
  defineGetter(window.navigator, 'language', UBER_LANGUAGE_PROFILE.locale);
  defineGetter(window.navigator, 'userLanguage', UBER_LANGUAGE_PROFILE.locale);
  defineGetter(window.navigator, 'languages', UBER_LANGUAGE_PROFILE.languages);
  defineGetter(Navigator.prototype, 'language', UBER_LANGUAGE_PROFILE.locale);
  defineGetter(Navigator.prototype, 'userLanguage', UBER_LANGUAGE_PROFILE.locale);
  defineGetter(Navigator.prototype, 'languages', UBER_LANGUAGE_PROFILE.languages);
}

function forceUberLocaleStorage() {
  const hardenKey = (key, value) => {
    try { localStorage.setItem(key, value); } catch (_) {}
  };

  hardenKey('lang', UBER_LANGUAGE_PROFILE.short);
  hardenKey('orig_lang', UBER_LANGUAGE_PROFILE.short);
  hardenKey('locale', UBER_LANGUAGE_PROFILE.locale);
  hardenKey('i18nextLng', UBER_LANGUAGE_PROFILE.locale);

  try {
    const originalSetItem = localStorage.setItem.bind(localStorage);
    const originalRemoveItem = localStorage.removeItem.bind(localStorage);
    const locked = new Set(['lang', 'orig_lang', 'locale', 'i18nextLng']);

    localStorage.setItem = function (key, value) {
      if (locked.has(String(key))) {
        if (key === 'lang' || key === 'orig_lang') return originalSetItem(String(key), UBER_LANGUAGE_PROFILE.short);
        return originalSetItem(String(key), UBER_LANGUAGE_PROFILE.locale);
      }
      return originalSetItem(key, value);
    };

    localStorage.removeItem = function (key) {
      if (locked.has(String(key))) return;
      return originalRemoveItem(key);
    };
  } catch (_) {}
}

try {
  applyUberLanguageMode(UBER_LANGUAGE_MODE);
} catch (_) {}

window.thaiasiaUberLanguage = {
  getMode: function () {
    return UBER_LANGUAGE_MODE;
  },
  setMode: async function (mode) {
    const targetMode = normalizeUberLanguageMode(mode);
    const result = await ipcRenderer.invoke('uber-language-mode-set', targetMode);
    if (!result || !result.ok) throw new Error((result && result.error) || 'Không lưu được ngôn ngữ UberEats');
    const appliedMode = applyUberLanguageMode(result.mode);
    await clearUberPageCaches();
    ipcRenderer.send('uber-language-mode-reload', appliedMode);
    return appliedMode;
  },
};

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
  try {
    navigator.clipboard.writeText(String(text || '')).catch(function () {});
  } catch (e) {}
};

window.GM_notification = function (details) {
  const text = typeof details === 'string' ? details : ((details && details.text) || '');
  const title = (typeof details === 'object' && details && details.title) ? details.title : 'ThaiAsia';
  console.log('[GM_notification]', title + ':', text);
};

let adminOpenSequence = 0;
window.GM_openInTab = function (url, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requestId = `uber-${Date.now().toString(36)}-${++adminOpenSequence}-${Math.random().toString(36).slice(2, 8)}`;
  const request = {
    url: String(url || ''),
    requestId,
    storageKey: String(opts.storageKey || ''),
    show: opts.show === true || opts.active === true
  };
  ipcRenderer.send('open-admin-window', request);
  return { close: function () { ipcRenderer.send('close-admin-window', request); } };
};

console.log('[ThaiAsia Electron] GM_* + locale override installed on UberEats window:', UBER_LANGUAGE_MODE);

(function installUberEatsAutoLogin() {
  const EMAIL = 'thai-asia-sushi-bar@ubereats.com';
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

  let lastClickAt = 0;

  function checkAndFillUber() {
    const isLoginHost = location.hostname.includes('uber.com') || location.hostname.includes('ubereats.com');
    if (!isLoginHost) return;

    const allInputs = Array.from(document.querySelectorAll('input')).filter(el => {
      try {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.type !== 'hidden' && !el.disabled;
      } catch (_) { return false; }
    });

    if (allInputs.length === 0) return;

    const passInput = allInputs.find(el => el.type === 'password' || el.name === 'password' || el.id === 'PASSWORD');
    const emailInput = allInputs.find(el => el !== passInput && (
      el.type === 'email' || el.type === 'text' || el.name === 'textInput' || el.id === 'PHONE_NUMBER_or_EMAIL_ADDRESS' || (el.placeholder && el.placeholder.toLowerCase().includes('email'))
    )) || (!passInput ? allInputs[0] : null);

    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(el => {
      try {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
      } catch (_) { return false; }
    });

    const forwardBtn = document.querySelector('#forward-button') || buttons.find(b => {
      const txt = (b.textContent || b.value || '').toLowerCase();
      return txt.includes('tiếp theo') || txt.includes('next') || txt.includes('weiter') || txt.includes('continue') || txt.includes('đăng nhập') || txt.includes('log in') || b.type === 'submit';
    }) || buttons[0];

    // Step 1: Email page
    if (emailInput && !passInput) {
      if (emailInput.value !== EMAIL) {
        setFieldValue(emailInput, EMAIL);
      }
      if (Date.now() - lastClickAt > 2500 && forwardBtn) {
        lastClickAt = Date.now();
        setTimeout(() => clickBtn(forwardBtn), 500);
      }
      return;
    }

    // Step 2: Password page
    if (passInput) {
      if (passInput.value !== PASSWORD) {
        setFieldValue(passInput, PASSWORD);
      }
      if (Date.now() - lastClickAt > 2500 && forwardBtn) {
        lastClickAt = Date.now();
        setTimeout(() => clickBtn(forwardBtn), 500);
      }
      return;
    }
  }

  setInterval(checkAndFillUber, 1000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndFillUber);
  } else {
    checkAndFillUber();
  }
})();
