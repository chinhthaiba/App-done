const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// ── GM_* polyfills ─────────────────────────────────────────────────────────────
// Backed by the shared Map in the main process so the admin window reads/writes
// the same bridge data as the live-orders window.

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

window.GM_xmlhttpRequest = function (options) {
  return ipcRenderer.invoke('gm-xmlhttp-request', options);
};

window.GM_notification = function (details) {
  const text = typeof details === 'string' ? details : ((details && details.text) || '');
  const title = (typeof details === 'object' && details && details.title) ? details.title : 'ThaiAsia';
  console.log('[GM_notification]', title + ':', text);
};

let adminOpenSequence = 0;
window.GM_openInTab = function (url, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const requestId = `admin-${Date.now().toString(36)}-${++adminOpenSequence}-${Math.random().toString(36).slice(2, 8)}`;
  const request = {
    url: String(url || ''),
    requestId,
    storageKey: String(opts.storageKey || '')
  };
  ipcRenderer.send('open-admin-window', request);
  return { close: function () { ipcRenderer.send('close-admin-window', request); } };
};

// Lets the injected admin script load only the payload assigned to this exact
// BrowserWindow, instead of the mutable global "active order" pointer.
window.GM_getAdminPayloadBinding = function () {
  return ipcRenderer.invoke('admin-payload-binding-get');
};

// Bridge the admin submit lifecycle to the main process. These helpers target
// the exact BrowserWindow that emitted the event, so a newer order window with
// the same URL cannot be closed accidentally.
window.GM_adminSubmitEvent = function (action, details) {
  ipcRenderer.send('admin-submit-event', {
    action: String(action || ''),
    details: details && typeof details === 'object' ? details : {}
  });
};

window.GM_showCurrentAdminWindow = function () {
  ipcRenderer.send('show-current-admin-window');
};

window.GM_closeCurrentAdminWindow = function () {
  ipcRenderer.send('close-current-admin-window');
};

console.log('[ThaiAsia Electron] GM_* polyfills installed on admin window');

window.addEventListener('DOMContentLoaded', () => {
  const scriptPath = path.join(__dirname, 'ThaiAsia-AllInOneapp.js');
  fs.readFile(scriptPath, 'utf8', (err, data) => {
    if (!err) {
      // Patch 1: giữ \n trong customerNote — thay /\s+/g bằng /[^\S\n]+/g trong normalizeText
      let patched = data.replace(
        ".replace(/\\s+/g, ' ')",
        ".replace(/[^\\S\\n]+/g, ' ')"
      );
      // Patch 2: cutlery trong sanitizeLegacyPayload
      if (!patched.includes('payload.cutlery')) {
        const _f = 'payload.firma           = normalizeText(payload.firma';
        patched = patched.replace(_f, `payload.cutlery         = normalizeText(payload.cutlery         || '');\n    ${_f}`);
      }
      // Patch 3: thêm cutlery check vào buildAdminNote nếu thiếu
      if (!patched.includes("p.cutlery === 'C\u00f3'")) {
        patched = patched.replace(
          "if (p.customerNote) blocks.push(p.customerNote);",
          "if (p.cutlery === 'C\u00f3') blocks.push('Bitte mit besteck, C\u1ea3m \u01a1n Nh\u00e9 !');\n    if (p.customerNote) blocks.push(p.customerNote);"
        );
      }
      // Patch 4: chỉ giữ số thứ tự trong formatItemLine, bỏ tên món: "18. Seetang Salat" → "18"
      if (!patched.includes("replace(/(\\d+)\\.\\s+.+$/, '$1')")) {
        patched = patched.replace(
          "const code = normalizeText(it?.code || '').replace(/\\.$/, '');",
          "let code = normalizeText(it?.code || '').replace(/\\.$/, '');\n    code = code.replace(/(\\d+)\\.\\s+.+$/, '$1');"
        );
      }
      const s = document.createElement('script');
      s.textContent = patched;
      document.body.appendChild(s);
      console.log('[Electron] Injected ThaiAsia-AllInOneapp.js via preload (patched)');
    } else {
      console.error('[Electron] preload-admin.js failed to read script:', err);
    }
  });
});

(function installAdminAutoLogin() {
  const USERNAME = 'chinthaiba';
  const PASSWORD = 'chinthaiba@321';
  let last419Redirect = 0;

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

  function checkRememberMe() {
    try {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(el => {
        try {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
        } catch (_) { return false; }
      });
      const rememberBox = checkboxes.find(el => {
        const id = (el.id || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const parentText = (el.parentElement ? el.parentElement.innerText || el.parentElement.textContent || '' : '').toLowerCase();
        return name.includes('remember') || id.includes('remember') || parentText.includes('remember');
      }) || checkboxes[0];

      if (rememberBox && !rememberBox.checked) {
        rememberBox.checked = true;
        rememberBox.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        rememberBox.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      }
    } catch (_) {}
  }

  function checkAndHandlePageExpired() {
    const isLoginHost = location.hostname.includes('thaiasiasushibar.de');
    if (!isLoginHost) return;

    const title = (document.title || '').toLowerCase();
    const bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').toLowerCase();

    const is419 = title.includes('page expired') ||
                  (bodyText.includes('419') && bodyText.includes('page expired')) ||
                  bodyText.includes('csrf token mismatch');

    if (is419 && Date.now() - last419Redirect > 5000) {
      last419Redirect = Date.now();
      try {
        console.warn('[ThaiAsiaDiag] ' + JSON.stringify({
          v: 1,
          module: 'admin',
          category: 'admin_error',
          severity: 'warn',
          action: 'page_expired_419',
          message: 'Trang Admin bị lỗi 419 Page Expired (hết hạn CSRF/Session), đang tự động chuyển hướng làm mới...',
          url: location.href,
          ts: new Date().toISOString()
        }));
      } catch (_) {}
      console.log('[AdminAutoLogin] Detected 419 Page Expired -> auto redirecting to create order URL');
      try {
        window.location.replace('https://www.api.thaiasiasushibar.de/admin/orders/create');
      } catch (_) {
        window.location.href = 'https://www.api.thaiasiasushibar.de/admin/orders/create';
      }
    }
  }

  let submitCooldown = 0;

  function checkAndFillAdmin() {
    const isLoginHost = location.hostname.includes('thaiasiasushibar.de');
    if (!isLoginHost) return;

    checkAndHandlePageExpired();

    const allInputs = Array.from(document.querySelectorAll('input')).filter(el => {
      try {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.type !== 'hidden' && !el.disabled;
      } catch (_) { return false; }
    });

    if (allInputs.length === 0) return;

    const passInput = allInputs.find(el => el.type === 'password');
    const userInput = allInputs.find(el => el !== passInput && (el.type === 'text' || el.type === 'email' || !el.type));

    if (userInput && passInput) {
      if (userInput.value !== USERNAME) setFieldValue(userInput, USERNAME);
      if (passInput.value !== PASSWORD) setFieldValue(passInput, PASSWORD);
      checkRememberMe();

      if (Date.now() - submitCooldown > 3000) {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(el => {
          try {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && !el.disabled;
          } catch (_) { return false; }
        });
        const submitBtn = buttons.find(b => b.type === 'submit') || buttons[0];
        if (submitBtn) {
          submitCooldown = Date.now();
          checkRememberMe();
          setTimeout(() => {
            checkRememberMe();
            clickBtn(submitBtn);
          }, 600);
        }
      }
    }
  }

  setInterval(checkAndFillAdmin, 1000);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndFillAdmin);
  } else {
    checkAndFillAdmin();
  }
})();
