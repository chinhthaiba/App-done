const { ipcRenderer } = require('electron');

window.GM_xmlhttpRequest = function (details) {
  const request = details || {};
  let aborted = false;

  const call = (fn, arg) => {
    if (aborted || typeof fn !== 'function') return;
    try { fn(arg); } catch (error) { console.error('[tienship GM_xmlhttpRequest callback]', error); }
  };

  ipcRenderer.invoke('gm-xmlhttp-request', {
    method: request.method || 'GET',
    url: request.url || '',
    headers: request.headers || {},
    data: request.data || '',
    timeout: request.timeout || 0,
  }).then((response) => {
    call(request.onload, response);
    call(request.onloadend, response);
  }).catch((error) => {
    const payload = {
      error: String(error && error.message || error),
      message: String(error && error.message || error),
    };
    call(request.onerror, payload);
    call(request.onloadend, payload);
  });

  return {
    abort() {
      aborted = true;
      call(request.onabort, { message: 'aborted' });
    },
  };
};

window.GM_setClipboard = function (text) {
  try {
    navigator.clipboard.writeText(String(text || '')).catch(function () {});
  } catch (_) {}
};

window.ThaiAsiaHost = {
  onReportSent: function (details) {
    try {
      ipcRenderer.send('tienship-report-sent', details || {});
    } catch (e) {
      console.error('[preload-tienship] onReportSent IPC error:', e);
    }
  }
};

console.log('[ThaiAsia Electron] tienship preload installed');

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
          module: 'tienship',
          category: 'admin_error',
          severity: 'warn',
          action: 'page_expired_419',
          message: 'Trang Tiền Ship bị lỗi 419 Page Expired (hết hạn CSRF/Session), đang tự động chuyển hướng làm mới...',
          url: location.href,
          ts: new Date().toISOString()
        }));
      } catch (_) {}
      console.log('[TienshipAutoLogin] Detected 419 Page Expired -> auto redirecting to orders list URL');
      try {
        window.location.replace('https://www.api.thaiasiasushibar.de/admin/orders?per_page=9999');
      } catch (_) {
        window.location.href = 'https://www.api.thaiasiasushibar.de/admin/orders?per_page=9999';
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
