// ==UserScript==
// @name         Takeaway Auto Fertig bei Übergabe Tab (v7 Background)
// @namespace    thaiasia-tools
// @version      7.0.0
// @description  Auto switch to Übergabe tab, check time, click Fertig - CHẠY ĐƯỢC KHI CHROME Ở BACKGROUND
// @author       OpenAI
// @match        https://live-orders.takeaway.com/orders?tabmode=tudongfertig*
// @grant        none
// ==/UserScript==
// ==UserScript==
// @name         Takeaway Auto Fertig bei Übergabe Tab (v7 Background)
// @namespace    thaiasia-tools
// @version      7.0.0
// @description  Auto switch to Übergabe tab, check time, click Fertig - CHẠY ĐƯỢC KHI CHROME Ở BACKGROUND
// @author       OpenAI
// @match        https://live-orders.takeaway.com/orders?tabmode=tudongfertig*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Guard chống inject trùng khi dom-ready bắn lại sau crash recovery
  if (window.__autofertigLoaded) return;
  window.__autofertigLoaded = true;

  const CONFIG = {
    DEBUG: false,
    LOOP_INTERVAL_MS: 500,
    FERTIG_COOLDOWN_MS: 4000,
    TAB_CLICK_COOLDOWN_MS: 2000,
    ORDER_THRESHOLD_MIN: 10,
    AFTER_SELECT_ORDER_DELAY_MS: 800,
    CLICK_VERIFY_DELAY_MS: 500,
    MAX_CLICK_RETRIES: 3,
    ORDER_SELECT_ATTEMPTS: 2,
    ORDER_DOUBLE_CLICK_GAP_MS: 120,
    OKAY_CLICK_INTERVAL_MS: 2000,
    OKAY_CLICK_COOLDOWN_MS: 2500,
  };

  const UEBERG_KEYWORDS = ['übergabe', 'uebergabe', 'ubergabe', 'Übergabe'];
  const FERTIG_KEYWORDS = ['fertig', 'Fertig'];

  const processedFertigCodes = new Map(); // orderCode -> timestamp (TTL 3 minutes)
  let lastFertigClickAt = 0;
  let lastTabClickAt = 0;
  let lastOkayClickAt = 0;
  let isProcessing = false;
  let lastQualifyingCount = -1;
  let lastRemainingOrderCount = -1;
  try { window.__thaiasiaOrderProcessing = false; } catch (_) {}
  try {
    window.__getAutofertigStatus = function () {
      const all = typeof findAllOrderCards === 'function' ? findAllOrderCards() : [];
      return {
        remainingCount: all.length,
        qualifyingCount: all.filter(o => o.mins < CONFIG.ORDER_THRESHOLD_MIN).length,
        isProcessing: !!isProcessing
      };
    };
  } catch (_) {}

  function setOrderProcessing(active) {
    try { window.__thaiasiaOrderProcessing = !!active; } catch (_) {}
  }

  function log(...args) {
    if (CONFIG.DEBUG) {
      const now = new Date();
      const timeStr = now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + now.getMilliseconds().toString().padStart(3, '0');
      console.log('[TakeawayV7]', timeStr, ...args);
    }
  }

  function f12Log(tag, message, color = '#fff', bgColor = '#ff6600') {
    try {
      const timeStr = new Date().toLocaleTimeString('vi-VN', { hour12: false });
      console.log(
        `%c ${tag} %c ${message} %c(${timeStr})`,
        `background: ${bgColor}; color: ${color}; font-weight: bold; border-radius: 4px; padding: 2px 6px; font-size: 11px;`,
        'color: inherit; font-weight: bold; font-size: 11px;',
        'color: #888; font-size: 10px;'
      );
    } catch (_) {}
  }

  function emitDiag(eventType, payload) {
    try {
      const row = {
        v: 1,
        module: 'autofertig',
        page: 'fertigWin',
        eventType: String(eventType || ''),
        ts: new Date().toISOString(),
        ...(payload || {})
      };
      if (row.eventType === 'order_activity') {
        try { window.dispatchEvent(new CustomEvent('thaiasia-order-activity', { detail: row })); } catch (_) {}
        if (row.action === 'fertig_cycle_start') {
          f12Log('AUTO-FERTIG', `🎯 Bắt đầu chu kỳ Fertig đơn #${row.orderCode || 'đơn'} (còn ${row.orderMinutes} min < 10 min)`, '#fff', '#2563eb');
        } else if (row.action === 'fertig_clicked') {
          f12Log('AUTO-FERTIG', `✅ ĐÃ BẤM FERTIG THÀNH CÔNG đơn #${row.orderCode || 'đơn'}`, '#fff', '#16a34a');
        } else if (row.action === 'fertig_not_clicked') {
          f12Log('AUTO-FERTIG', `⚠️ Bỏ qua/Hủy bấm Fertig đơn #${row.orderCode || 'đơn'} (Lý do: ${row.reason})`, '#fff', '#dc2626');
        } else if (row.action === 'qualifying_count_changed' && row.qualifyingCount > 0) {
          f12Log('AUTO-FERTIG', `🔍 Phát hiện ${row.qualifyingCount} đơn đủ điều kiện (< 10 min) trong Übergabe`, '#fff', '#ff6600');
        }
      }
      console.warn('[ThaiAsiaDiag] ' + JSON.stringify(row));
    } catch (_) {}
  }

  let workerTimer = null;
  let okayWorkerTimer = null;
  function createWorkerTimer(callback, intervalMs, onError) {
    const blob = new Blob([`
      let interval = null;
      self.onmessage = function(e) {
        if (e.data === 'start') {
          interval = setInterval(() => self.postMessage('tick'), ${intervalMs});
        } else if (e.data === 'stop') {
          clearInterval(interval);
        }
      };
      self.onclose = function() {
        self.postMessage('closed');
      };
    `], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = (e) => {
      if (e.data === 'tick') callback();
      if (e.data === 'closed') log('⚠️ Web Worker bị đóng/suspend!');
    };
    worker.onerror = (err) => {
      log('⚠️ Web Worker error:', err);
      if (typeof onError === 'function') onError(err);
    };
    worker.postMessage('start');
    URL.revokeObjectURL(url);
    return worker;
  }

  function toLower(text) {
    return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function matchesKeywords(text, keywords) {
    const t = toLower(text);
    return keywords.some(k => t.includes(k.toLowerCase()));
  }

  function isDomVisible(el) {
    if (!el) return false;
    try {
      let node = el;
      while (node && node !== document && node !== document.documentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) < 0.1) return false;
        node = node.parentElement;
      }
      if (!document.body.contains(el)) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if (el.classList && el.classList.contains('disabled')) return true;
    return false;
  }

  function isClickable(el) {
    return isDomVisible(el) && !isDisabled(el);
  }

  function dispatchMouseEvents(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => {
      try {
        const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ev(type, {
          bubbles: true,
          cancelable: true,
          clientX: 0,
          clientY: 0,
          view: window,
          button: 0,
          buttons: type.includes('down') ? 1 : 0,
        }));
      } catch (_) {}
    });
  }

  function forceClick(el) {
    if (!el) return false;
    if (!isClickable(el)) return false;

    let clicked = false;
    try { dispatchMouseEvents(el); clicked = true; } catch (_) {}
    try { el.click(); clicked = true; } catch (_) {}
    try {
      el.focus();
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }));
      });
      clicked = true;
    } catch (_) {}
    try {
      const reactKey = Object.keys(el).find(k => k.startsWith('__reactInternalInstance') || k.startsWith('__reactFiber'));
      if (reactKey) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    } catch (_) {}

    if (clicked) log('forceClick OK:', el.tagName, toLower(el.innerText || '').substring(0, 30));
    return clicked;
  }

  async function forceDoubleClick(el) {
    if (!el || !isClickable(el)) return false;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
    let clicked = false;
    clicked = forceClick(el) || clicked;
    await sleep(CONFIG.ORDER_DOUBLE_CLICK_GAP_MS);
    clicked = forceClick(el) || clicked;
    try {
      el.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: 2,
        button: 0,
        buttons: 0,
      }));
      clicked = true;
    } catch (_) {}
    return clicked;
  }

  function safeText(el, maxLen) {
    const text = (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim();
    return maxLen ? text.slice(0, maxLen) : text;
  }

  function extractOrderCode(text) {
    const raw = String(text || '').toUpperCase();
    const matches = raw.match(/\b[A-Z0-9]{5,8}\b/g) || [];
    return matches.find(code => /[A-Z]/.test(code) && /\d/.test(code)) || '';
  }

  function collectAllElements(root) {
    const results = [];
    function walk(node) {
      if (!node) return;
      if (node.shadowRoot) walk(node.shadowRoot);
      const children = node.querySelectorAll ? Array.from(node.querySelectorAll('*')) : [];
      for (const child of children) {
        results.push(child);
        if (child.shadowRoot) walk(child.shadowRoot);
      }
    }
    walk(root || document);
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (iframeDoc) walk(iframeDoc);
        } catch (_) {}
      }
    } catch (_) {}
    return results;
  }

  function isOkayButtonText(text) {
    const t = toLower(text);
    if (!t) return false;
    return t === 'ok' || t === 'okay' || t.includes('okay');
  }

  function findOkayButton() {
    const candidates = collectAllElements(document)
      .filter(el => {
        const tag = (el.tagName || '').toLowerCase();
        const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
        if (!['button', 'a', 'div', 'span'].includes(tag) && role !== 'button') return false;
        if (!isClickable(el)) return false;
        return isOkayButtonText(el.innerText || el.textContent || '');
      })
      .map(el => {
        const rect = el.getBoundingClientRect();
        const tag = (el.tagName || '').toLowerCase();
        const role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
        const text = toLower(el.innerText || el.textContent || '');
        let score = 0;
        if (text === 'okay') score += 1000;
        if (text === 'ok') score += 900;
        if (tag === 'button') score += 500;
        if (role === 'button') score += 350;
        score += rect.top * 0.2 + rect.left * 0.05;
        score += rect.width * 0.05 + rect.height * 0.2;
        return { el, score, text };
      })
      .sort((a, b) => b.score - a.score);

    if (candidates.length) log('Okay candidates:', candidates.map(c => ({ text: c.text, score: c.score })));
    return candidates[0]?.el || null;
  }

  function tryClickOkay() {
    if (isProcessing) return false;
    const now = Date.now();
    if (now - lastOkayClickAt < CONFIG.OKAY_CLICK_COOLDOWN_MS) return false;

    const btn = findOkayButton();
    if (!btn) return false;

    log('→ Click nút Okay...');
    const clicked = forceClick(btn);
    if (clicked) {
      lastOkayClickAt = Date.now();
      emitDiag('order_activity', {
        page: 'fertigWin',
        action: 'okay_clicked',
        buttonText: safeText(btn, 80)
      });
    }
    return clicked;
  }

  function startOkayClickWorker() {
    const tick = () => { try { tryClickOkay(); } catch (e) { log('Okay click worker error:', e); } };
    try {
      okayWorkerTimer = createWorkerTimer(tick, CONFIG.OKAY_CLICK_INTERVAL_MS, () => {
        setInterval(tick, CONFIG.OKAY_CLICK_INTERVAL_MS);
        log('⚠️ Okay worker fallback setInterval activated');
      });
      log('✅ Okay worker active');
    } catch (e) {
      setInterval(tick, CONFIG.OKAY_CLICK_INTERVAL_MS);
      log('✅ Okay fallback setInterval active');
    }
  }

  function findElementsByKeywords(keywords, filterFn) {
    const allEls = collectAllElements(document);
    const results = [];
    const seen = new WeakSet();

    for (const el of allEls) {
      if (seen.has(el)) continue;

      const txt = el.innerText || el.textContent || '';
      if (matchesKeywords(txt, keywords)) {
        if (!filterFn || filterFn(el)) {
          seen.add(el);
          results.push(el);
          continue;
        }
      }

      for (const attr of ['aria-label', 'title', 'value', 'data-testid', 'data-test', 'placeholder']) {
        const val = el.getAttribute(attr);
        if (val && matchesKeywords(val, keywords)) {
          if (!filterFn || filterFn(el)) {
            seen.add(el);
            results.push(el);
            break;
          }
        }
      }
    }
    return results;
  }

  function findLeafNodesWithKeywords(keywords, filterFn) {
    const all = findElementsByKeywords(keywords, filterFn);
    return all.filter(el => {
      const children = el.children;
      if (!children || children.length === 0) return true;
      for (const child of children) {
        const childTxt = child.innerText || child.textContent || '';
        if (matchesKeywords(childTxt, keywords) && isDomVisible(child)) {
          return false;
        }
      }
      return true;
    });
  }

  function findClickableAncestor(el, maxLevels) {
    const candidates = [el];
    let p = el.parentElement;
    for (let i = 0; i < (maxLevels || 5) && p; i++) {
      candidates.push(p);
      p = p.parentElement;
    }
    for (const tag of ['button', 'a']) {
      const found = candidates.find(c => c.tagName.toLowerCase() === tag && isClickable(c));
      if (found) return found;
    }
    for (const role of ['button', 'tab', 'link', 'menuitem']) {
      const found = candidates.find(c => c.getAttribute('role') === role && isClickable(c));
      if (found) return found;
    }
    for (const c of candidates) {
      if (!isClickable(c)) continue;
      if (c.getAttribute('onclick')) return c;
      try {
        if (window.getComputedStyle(c).cursor === 'pointer') return c;
      } catch (_) {}
    }
    return isClickable(el) ? el : candidates.find(c => isClickable(c)) || el;
  }

  function scoreButton(el, keywords) {
    let score = 0;
    const tag = el.tagName.toLowerCase();
    const txt = toLower(el.innerText || el.textContent);

    if (tag === 'button') score += 800;
    if (tag === 'a') score += 500;
    if (el.getAttribute('role') === 'button') score += 700;

    if (keywords.some(k => txt === k.toLowerCase())) score += 600;
    if (keywords.some(k => txt.includes(k.toLowerCase()))) score += 300;

    try {
      const bg = window.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && bg !== 'rgb(255, 255, 255)') score += 400;
    } catch (_) {}
    score += getOrangeScore(el);
    score += getActionPositionScore(el);

    if (txt.length < 30) score += 300;
    if (txt.length < 15) score += 200;

    return score;
  }

  function scoreTab(el, keywords) {
    let score = 0;
    const tag = el.tagName.toLowerCase();
    const txt = toLower(el.innerText || el.textContent);

    if (el.getAttribute('role') === 'tab') score += 500;
    if ((el.className || '').toLowerCase().includes('tab')) score += 300;
    if (tag === 'button' || tag === 'a') score += 300;
    if (el.getAttribute('role') === 'button') score += 200;
    if (keywords.some(k => txt === k.toLowerCase())) score += 500;
    if (txt.length < 30) score += 300;
    if (txt.length < 15) score += 200;

    try {
      if (window.getComputedStyle(el).cursor === 'pointer') score += 200;
    } catch (_) {}

    return score;
  }

  // Kiểm tra element có phải là tab navigation không (cần loại trừ)
  function isTabElement(el) {
    if (!el) return false;
    if (el.getAttribute('role') === 'tab') return true;
    // Đi lên DOM tìm tablist
    let node = el.parentElement;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      if (node.getAttribute('role') === 'tablist') return true;
      const cls = (node.className || '').toString().toLowerCase();
      if (cls.includes('tablist') || cls.includes('tab-list') || cls.includes('tab-bar') || cls.includes('tabs-bar')) return true;
      node = node.parentElement;
    }
    return false;
  }

  function hasOrderStatusTabText(text) {
    const t = toLower(text);
    const hasPrepare = t.includes('zubereiten');
    const hasHandover = t.includes('übergabe') || t.includes('uebergabe') || t.includes('ubergabe');
    return hasPrepare && hasHandover && t.includes('fertig');
  }

  function isOrderStatusNavigationElement(el) {
    if (!el) return false;
    const txt = toLower(el.innerText || el.textContent);
    if (!txt.includes('fertig')) return false;

    try {
      const rect = el.getBoundingClientRect();
      if (rect && rect.height > 0 && rect.top >= 0 && rect.top < 220 && rect.height < 80) {
        let node = el.parentElement;
        for (let i = 0; i < 7 && node && node !== document.body; i++) {
          const parentText = node.innerText || node.textContent || '';
          if (hasOrderStatusTabText(parentText)) return true;
          node = node.parentElement;
        }
      }
    } catch (_) {}

    let node = el.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body; i++) {
      const cls = (node.className || '').toString().toLowerCase();
      const parentText = node.innerText || node.textContent || '';
      if ((cls.includes('tab') || cls.includes('nav') || cls.includes('status')) && hasOrderStatusTabText(parentText)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function getOrangeScore(el) {
    try {
      const bg = window.getComputedStyle(el).backgroundColor || '';
      const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!match) return 0;
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      if (r >= 220 && g >= 70 && g <= 180 && b <= 90) return 1200;
    } catch (_) {}
    return 0;
  }

  function getActionPositionScore(el) {
    try {
      const rect = el.getBoundingClientRect();
      const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      let score = 0;
      if (rect.top > vh * 0.45) score += 300;
      if (rect.left > vw * 0.45 || rect.right > vw * 0.65) score += 250;
      return score;
    } catch (_) {
      return 0;
    }
  }

  function findFertigButton() {
    const leaves = findLeafNodesWithKeywords(FERTIG_KEYWORDS, isDomVisible);
    if (!leaves.length) return null;

    const scored = [];
    const seen = new WeakSet();

    for (const leaf of leaves) {
      const clickable = findClickableAncestor(leaf, 5);
      if (seen.has(clickable)) continue;
      seen.add(clickable);
      if (!isClickable(clickable)) continue;

      // Loại trừ tab navigation ("✓ Fertig" tab ở trên)
      if (isTabElement(clickable)) {
        log('findFertig: bỏ qua tab element:', toLower(clickable.innerText || '').substring(0, 30));
        continue;
      }
      if (isOrderStatusNavigationElement(clickable)) {
        log('findFertig: bỏ qua status navigation Fertig:', toLower(clickable.innerText || '').substring(0, 30));
        continue;
      }

      let s = scoreButton(clickable, FERTIG_KEYWORDS);
      // Boost thêm nếu là button thực sự (không phải link/tab)
      if ((clickable.tagName || '').toLowerCase() === 'button') s += 500;
      scored.push({ el: clickable, score: s, text: toLower(clickable.innerText || '').substring(0, 40) });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length) log(`findFertig: ${scored.length} candidates`, scored.slice(0, 3).map(s => `${s.text}(${s.score})`));

    return scored[0]?.el || null;
  }

  function findUebergabeTab() {
    const leaves = findLeafNodesWithKeywords(UEBERG_KEYWORDS, isDomVisible);
    if (!leaves.length) {
      log('❌ Không thấy tab Übergabe');
      return null;
    }

    const scored = [];
    const seen = new WeakSet();

    for (const leaf of leaves) {
      const clickable = findClickableAncestor(leaf, 5);
      if (seen.has(clickable)) continue;
      seen.add(clickable);
      if (!isClickable(clickable)) continue;

      const s = scoreTab(clickable, UEBERG_KEYWORDS);
      scored.push({ el: clickable, score: s, text: toLower(clickable.innerText || '').substring(0, 40) });
    }

    scored.sort((a, b) => b.score - a.score);
    if (scored.length) log(`findTab: ${scored.length} candidates`, scored.slice(0, 3).map(s => `${s.text}(${s.score})`));

    return scored[0]?.el || null;
  }

  function parseTimeToRemainingMinutes(hh, mm) {
    const now = new Date();
    const currentTotalMins = now.getHours() * 60 + now.getMinutes();
    const targetTotalMins = parseInt(hh, 10) * 60 + parseInt(mm, 10);
    let diff = targetTotalMins - currentTotalMins;
    if (diff < -720) diff += 1440;
    if (diff > 720) diff -= 1440;
    return diff;
  }

  function parseMinutes(text) {
    const raw = toLower(text);
    if (raw.includes('überfällig') || raw.includes('ueberfaellig') || raw.includes('overdue')) {
      return -1;
    }
    const minMatch = raw.match(/(-?\d+)\s*(?:min|minute)/);
    if (minMatch) {
      const n = parseInt(minMatch[1], 10);
      if (!Number.isNaN(n)) return n;
    }
    const timeMatch = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (timeMatch) {
      return parseTimeToRemainingMinutes(timeMatch[1], timeMatch[2]);
    }
    return null;
  }

  // Đi lên DOM từ phần tử thời gian để tìm container thẻ đơn hàng
  function findOrderCardAncestor(el) {
    const cardTags = ['li', 'article'];
    const cardKeywords = ['order', 'card', 'item', 'row'];
    let node = el.parentElement;
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      const tag = (node.tagName || '').toLowerCase();
      if (cardTags.includes(tag)) return node;
      const cls = (node.className || '').toString().toLowerCase();
      if (cardKeywords.some(k => cls.includes(k))) return node;
      node = node.parentElement;
    }
    return el;
  }

  function isInsideDecorativeElement(el) {
    const decorativeTags = ['img', 'svg', 'figure', 'picture'];
    let node = el.parentElement;
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      if (decorativeTags.includes((node.tagName || '').toLowerCase())) return true;
      // Nếu ancestor là empty-state / illustration container → bỏ qua
      const cls = (node.className || '').toString().toLowerCase();
      if (cls.includes('empty') || cls.includes('illustration') || cls.includes('placeholder')) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isInsideDetailPanel(el) {
    let node = el;
    for (let i = 0; i < 12 && node && node !== document.body; i++) {
      const cls = (node.className || '').toString().toLowerCase();
      const id = (node.id || '').toString().toLowerCase();
      const role = (node.getAttribute('role') || '').toLowerCase();
      if (cls.includes('detail') || cls.includes('sidebar') || cls.includes('panel') || id.includes('detail') || id.includes('sidebar')) {
        return true;
      }
      if (role === 'region' || role === 'complementary') {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function cleanProcessedFertigOrders() {
    const now = Date.now();
    for (const [code, ts] of processedFertigCodes.entries()) {
      if (now - ts > 180000) processedFertigCodes.delete(code);
    }
  }

  function findAllOrderCards() {
    cleanProcessedFertigOrders();
    const allEls = collectAllElements(document);
    const orders = [];
    const seenTimeEls = new WeakSet();
    const seenCards = new WeakSet();

    for (const node of allEls) {
      if (!isDomVisible(node)) continue;

      // Tuyệt đối không quét badge nằm trong panel chi tiết bên phải
      if (isInsideDetailPanel(node)) continue;

      // Chỉ nhắm vào các badge nhỏ chứa thời gian (≤100 ký tự)
      const text = node.innerText || node.textContent || '';
      if (text.length > 100 || text.length < 2) continue;

      const mins = parseMinutes(text);
      if (mins === null) continue;

      // Bỏ qua nếu nằm trong hình minh họa
      if (isInsideDecorativeElement(node)) continue;

      if (seenTimeEls.has(node)) continue;
      seenTimeEls.add(node);

      const card = findOrderCardAncestor(node);
      if (seenCards.has(card)) continue;
      seenCards.add(card);
      const cardText = safeText(card, 1200);
      const code = extractOrderCode(cardText);

      // Bỏ qua nếu đơn này đã được bấm Fertig trong vòng 3 phút qua
      if (code && processedFertigCodes.has(code)) {
        log(`Bỏ qua đơn ${code} vì đã bấm Fertig gần đây`);
        continue;
      }

      orders.push({
        card,
        timeEl: node,
        mins,
        code,
        cardTextSample: cardText.slice(0, 240)
      });
    }

    return orders;
  }

  function findQualifyingOrders() {
    const allOrders = findAllOrderCards();

    const qualifying = [];
    const skipped = [];

    for (const order of allOrders) {
      if (order.mins < CONFIG.ORDER_THRESHOLD_MIN) {
        qualifying.push(order);
      } else {
        skipped.push(order);
      }
    }

    if (allOrders.length > 0) {
      log(`Tìm thấy ${allOrders.length} đơn:`);
      for (const o of qualifying) {
        log(`  ✅ ${o.code || 'Đơn'} (${o.mins} min) → ĐỦ điều kiện (< ${CONFIG.ORDER_THRESHOLD_MIN} min)`);
      }
      for (const o of skipped) {
        log(`  ⏭️ ${o.code || 'Đơn'} (${o.mins} min) → CHƯA đủ điều kiện (>= ${CONFIG.ORDER_THRESHOLD_MIN} min) → BỎ QUA`);
      }
    }

    qualifying.sort((a, b) => a.mins - b.mins);
    return qualifying;
  }

  function readOrderCurrentMinutes(order) {
    if (!order || !order.timeEl || !document.body.contains(order.timeEl) || !isDomVisible(order.timeEl)) return null;
    return parseMinutes(order.timeEl.innerText || order.timeEl.textContent || '');
  }

  function hasSelectedMarker(el) {
    if (!el) return false;
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      const cls = (node.className || '').toString().toLowerCase();
      if (node.getAttribute('aria-selected') === 'true') return true;
      if (node.getAttribute('aria-current') === 'true') return true;
      if (node.getAttribute('data-selected') === 'true') return true;
      if (/(^|[\s_-])(active|selected|current|highlighted)([\s_-]|$)/.test(cls)) return true;
      node = node.parentElement;
    }
    return false;
  }

  function getFertigContextText(btn) {
    let node = btn;
    let best = '';
    for (let i = 0; i < 10 && node && node !== document.body; i++) {
      const txt = safeText(node, 5000);
      if (txt.length > best.length && toLower(txt).includes('fertig')) best = txt;
      node = node.parentElement;
    }
    return best;
  }

  function verifySelectedOrderForFertig(order, btn) {
    if (!btn || isOrderStatusNavigationElement(btn) || isTabElement(btn)) {
      return { ok: false, reason: 'fertig_button_is_status_tab', currentMins: readOrderCurrentMinutes(order) };
    }
    const currentMins = readOrderCurrentMinutes(order);
    if (currentMins === null) {
      return { ok: false, reason: 'order_badge_missing_after_select', currentMins: null };
    }
    if (currentMins >= CONFIG.ORDER_THRESHOLD_MIN) {
      return { ok: false, reason: 'order_no_longer_qualifies', currentMins };
    }

    const code = order && order.code ? String(order.code) : '';
    const contextText = getFertigContextText(btn);
    if (code && contextText.toUpperCase().includes(code)) {
      return { ok: true, reason: 'detail_code_match', currentMins, orderCode: code };
    }

    if (!code && (hasSelectedMarker(order.card) || hasSelectedMarker(order.timeEl))) {
      return { ok: true, reason: 'selected_card_marker', currentMins, orderCode: code };
    }

    return {
      ok: false,
      reason: code ? 'detail_code_not_confirmed' : 'selected_order_not_confirmed',
      currentMins,
      orderCode: code
    };
  }

  async function selectOrderForFertig(order) {
    for (let attempt = 1; attempt <= CONFIG.ORDER_SELECT_ATTEMPTS; attempt++) {
      log(`Double-click countdown (${order.mins} min), attempt ${attempt}`);
      await forceDoubleClick(order.timeEl);
      await sleep(180);
      if (order.card && order.card !== order.timeEl) {
        await forceDoubleClick(order.card);
      }
      await sleep(CONFIG.AFTER_SELECT_ORDER_DELAY_MS + 600);

      const btn = findFertigButton();
      if (!btn) {
        log('Verify select: Fertig button not visible yet');
        continue;
      }

      const verified = verifySelectedOrderForFertig(order, btn);
      if (verified.ok) return { ...verified, btn };

      log('Verify select failed:', verified.reason, 'mins=', verified.currentMins, 'code=', verified.orderCode || '');
    }

    return {
      ok: false,
      reason: 'select_order_detail_failed',
      currentMins: readOrderCurrentMinutes(order),
      orderCode: order && order.code ? String(order.code) : ''
    };
  }

  async function clickWithRetry(findFn, actionName) {
    for (let i = 0; i < CONFIG.MAX_CLICK_RETRIES; i++) {
      const el = findFn();
      if (!el) {
        if (i > 0) log(`${actionName}: element biến mất → có thể đã thành công`);
        return i > 0;
      }

      log(`${actionName}: attempt ${i + 1}/${CONFIG.MAX_CLICK_RETRIES}`);
      forceClick(el);

      await sleep(CONFIG.CLICK_VERIFY_DELAY_MS);

      const elAfter = findFn();
      if (!elAfter) {
        log(`${actionName}: ✅ Thành công`);
        return true;
      }
      if (elAfter !== el) {
        log(`${actionName}: ✅ Có thể thành công (element thay đổi)`);
        return true;
      }

      log(`${actionName}: ❌ Attempt ${i + 1} chưa hiệu quả, retry...`);
    }
    return false;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function isUebergabeTabActive() {
    const tab = findUebergabeTab();
    if (!tab) return false;
    if (tab.getAttribute('aria-selected') === 'true') return true;
    if ((tab.className || '').toLowerCase().includes('active')) return true;
    if ((tab.className || '').toLowerCase().includes('selected')) return true;
    // Kiểm tra style active (border/background đặc trưng)
    try {
      const style = window.getComputedStyle(tab);
      const bg = style.backgroundColor;
      // Màu cam của Takeaway: rgb(255, 102, 0) hoặc tương tự
      if (bg && bg.includes('255') && !bg.includes('255, 255, 255')) return true;
    } catch (_) {}
    return false;
  }

  async function trySwitchToUebergabeTab() {
    const now = Date.now();
    if (now - lastTabClickAt < CONFIG.TAB_CLICK_COOLDOWN_MS) return false;

    if (isUebergabeTabActive()) {
      log('Tab Übergabe đã active, bỏ qua click');
      return false;
    }

    const tab = findUebergabeTab();
    if (!tab) return false;

    log('→ Click tab Übergabe...');
    forceClick(tab);
    lastTabClickAt = Date.now();
    return true;
  }

  async function tryClickFertig(verifiedBtn) {
    const now = Date.now();
    if (now - lastFertigClickAt < CONFIG.FERTIG_COOLDOWN_MS) return false;

    const btn = verifiedBtn || findFertigButton();
    if (!btn) return false;
    if (isOrderStatusNavigationElement(btn) || isTabElement(btn)) {
      log('Không click Fertig vì button là status/tab navigation');
      return false;
    }

    log('→ Click nút Fertig...');
    const ok = await clickWithRetry(() => (
      btn && document.body.contains(btn) && isClickable(btn) ? btn : null
    ), 'Fertig');
    if (ok) lastFertigClickAt = Date.now();
    return ok;
  }

  async function mainLoop() {
    if (isProcessing) return;
    isProcessing = true;

    try {
      log('--- MAIN LOOP START ---');
      log('Bước 1: Chuyển tab Übergabe');
      await trySwitchToUebergabeTab();

      log('Bước 2: Tìm đơn đủ điều kiện');
      const allOrders = findAllOrderCards();
      const qualifying = findQualifyingOrders();
      const remainingCount = allOrders.length;

      try {
        window.__thaiasiaAutofertigRemainingCount = remainingCount;
        window.__thaiasiaAutofertigQualifyingCount = qualifying.length;
        window.__thaiasiaAutofertigProcessing = !!isProcessing;
      } catch (_) {}

      if (remainingCount !== lastRemainingOrderCount || qualifying.length !== lastQualifyingCount) {
        lastRemainingOrderCount = remainingCount;
        lastQualifyingCount = qualifying.length;
        emitDiag('order_activity', {
          page: 'fertigWin',
          action: 'autofertig_orders_status',
          remainingCount,
          qualifyingCount: qualifying.length,
          isProcessing: false
        });
      }
      if (!qualifying.length) {
        log('Không có đơn nào đủ điều kiện');
        return;
      }

      setOrderProcessing(true);
      const order = qualifying[0];
      const orderStartAt = Date.now();
      emitDiag('order_activity', {
        page: 'fertigWin',
        action: 'fertig_cycle_start',
        orderMinutes: Number(order.mins),
        orderCode: order.code || ''
      });
      const selected = await selectOrderForFertig(order);
      if (!selected.ok) {
        log('Verify select failed, skip Fertig:', selected.reason);
        emitDiag('order_activity', {
          page: 'fertigWin',
          action: 'fertig_not_clicked',
          reason: selected.reason || 'select_order_detail_failed',
          orderMinutes: Number(order.mins),
          selectedOrderMinutes: selected.currentMins,
          orderCode: selected.orderCode || order.code || '',
          durationMs: Math.max(0, Date.now() - orderStartAt)
        });
        return;
      }

      log('Thử click Fertig...');
      const clicked = await tryClickFertig(selected.btn);
      if (clicked && (selected.orderCode || order.code)) {
        processedFertigCodes.set(selected.orderCode || order.code, Date.now());
      }
      emitDiag('order_activity', {
        page: 'fertigWin',
        action: clicked ? 'fertig_clicked' : 'fertig_not_clicked',
        reason: clicked ? '' : 'fertig_button_not_confirmed',
        orderMinutes: Number(order.mins),
        selectedOrderMinutes: selected.currentMins,
        orderCode: selected.orderCode || order.code || '',
        selectionProof: selected.reason || '',
        durationMs: Math.max(0, Date.now() - orderStartAt)
      });
      log('Đợi cooldown an toàn sau khi click Fertig...');
      await sleep(CONFIG.FERTIG_COOLDOWN_MS);

    } catch (err) {
      log('❌ Error in mainLoop:', err);
    } finally {
      log('--- MAIN LOOP END ---');
      isProcessing = false;
      setOrderProcessing(false);
    }
  }

  function startScript() {
    log('🚀 Script v7.0.0 started (Background-safe)');

    let fallbackTimer = null;
    let fallbackInterval = CONFIG.LOOP_INTERVAL_MS * 2;
    let fallbackActive = false;

    try {
      workerTimer = createWorkerTimer(mainLoop, CONFIG.LOOP_INTERVAL_MS, () => {
        // Worker crash → kích hoạt fallback timer ngay lập tức
        if (!fallbackActive) {
          fallbackActive = true;
          fallbackTimer = setInterval(mainLoop, fallbackInterval);
          log('⚠️ Fallback setInterval activated after Worker crash');
        }
      });
      log('✅ Web Worker timer active - KHÔNG bị throttle khi background');
    } catch (e) {
      log('⚠️ Web Worker không tạo được, fallback setInterval:', e);
      fallbackActive = true;
      fallbackTimer = setInterval(mainLoop, fallbackInterval);
      log('✅ Fallback setInterval timer active');
    }

    startOkayClickWorker();

    if (document.body) {
      const observer = new MutationObserver(() => {
        if (!isProcessing) mainLoop();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      log('✅ MutationObserver active (backup timer)');
    }

    // ── Stale-page / dead-WebSocket detector v2 (cross-tab aware) ───────────
    // v1 bug: mọi tick đồng hồ ("15 min" → "14 min") đều reset timer
    // → WebSocket chết nhưng timer không bao giờ hết.
    // v2: chỉ đếm mutation ĐÁNG KỂ (thêm/xóa card đơn hàng, không phải tick thời gian).
    // Cross-tab: ghi heartbeat vào localStorage và đọc heartbeat của tab kia.
    // Nếu tab kia stale trong khi tab này vẫn fresh thì tab kia sẽ tự reload, và ngược lại.
    const STALE_RELOAD_MS     = 2.5 * 60 * 1000;  // 2 phút 30 giây không có mutation đáng kể → reload
    const MAX_PAGE_AGE_MS     = 30 * 60 * 1000; // reload định kỳ sau 30 phút
    const AUTOFERTIG_ALIVE_KEY = 'thaiasia_autofertig_dom_alive';
    const ALLINONE_ALIVE_KEY   = 'thaiasia_allinone_dom_alive';
    const CROSS_TAB_LAG_MS     = 100 * 1000;    // AllInOne mới hơn 1 phút 40 giây → Autofertig stale
    const DOM_STALE_RELOAD_ENABLED = false;     // DOM yên lặng không còn là bằng chứng trang chết
    const STALE_DEBUG_LOG_KEY  = 'thaiasia_stale_debug_logs';
    const STALE_DEBUG_MAX_LOGS = 300;
    let _lastSigMutAt = Date.now();
    const _pageStartAt = Date.now();
    let _lastDiagSnapshotAt = 0;
    function appendStaleDebugLog(reason, details, emitConsole = false) {
      try {
        const ts = new Date().toISOString();
        const row = { ts, module: 'autofertig', reason, ...(details || {}) };
        const logs = JSON.parse(localStorage.getItem(STALE_DEBUG_LOG_KEY) || '[]');
        logs.push(row);
        while (logs.length > STALE_DEBUG_MAX_LOGS) logs.shift();
        localStorage.setItem(STALE_DEBUG_LOG_KEY, JSON.stringify(logs));
        if (emitConsole) console.warn('[ThaiAsia autofertig stale]', reason, ts, details || {});
        if (String(reason || '').startsWith('RELOAD_')) {
          emitDiag('reload', {
            page: 'fertigWin',
            reason: String(reason || ''),
            details: details || {}
          });
        }
      } catch (_) {}
    }
    function isSignificantMutation(m) {
      if (m.type !== 'childList') return false;
      // ≥5 node thay đổi = thêm/xóa card đơn hàng (không phải tick "15 min"→"14 min")
      if (m.addedNodes.length + m.removedNodes.length >= 5) return true;
      for (const node of [...m.addedNodes, ...m.removedNodes]) {
        if ((node.textContent || '').trim().length > 40) return true;
      }
      return false;
    }
    if (document.body) {
      const staleObs = new MutationObserver((mutations) => {
        if (mutations.some(isSignificantMutation)) {
          _lastSigMutAt = Date.now();
          try { localStorage.setItem(AUTOFERTIG_ALIVE_KEY, String(_lastSigMutAt)); } catch (_) {}
        }
      });
      staleObs.observe(document.body, { childList: true, subtree: true });
    }
    setInterval(() => {
      if (isProcessing) return; // đang click → không reload
      const checkAt = Date.now();
      const staleAgeMs = checkAt - _lastSigMutAt;
      const pageAgeMs  = checkAt - _pageStartAt;
      if (checkAt - _lastDiagSnapshotAt >= 60 * 1000) {
        _lastDiagSnapshotAt = checkAt;
        appendStaleDebugLog('HEALTH_SNAPSHOT', {
          checkAt,
          staleAgeMs,
          pageAgeMs,
          staleThresholdMs: STALE_RELOAD_MS,
          maxAgeThresholdMs: MAX_PAGE_AGE_MS,
          crossTabLagMs: CROSS_TAB_LAG_MS,
          isProcessing
        });
      }
      // Cross-tab: AllInOne DOM mới hơn CROSS_TAB_LAG_MS so với Autofertig → Autofertig stale
      try {
        const allinoneAlive = Number(localStorage.getItem(ALLINONE_ALIVE_KEY) || '0');
        if (DOM_STALE_RELOAD_ENABLED && allinoneAlive > 0 && (allinoneAlive - _lastSigMutAt) > CROSS_TAB_LAG_MS) {
          appendStaleDebugLog('RELOAD_CROSS_TAB', {
            checkAt,
            allinoneAlive,
            autofertigAlive: _lastSigMutAt,
            crossDeltaMs: allinoneAlive - _lastSigMutAt,
            crossTabLagMs: CROSS_TAB_LAG_MS
          }, true);
          log('⚠️ Cross-tab: AllInOne DOM ' + Math.round((allinoneAlive - _lastSigMutAt) / 1000) + 's mới hơn Autofertig → Autofertig stale → reload');
          location.reload();
          return;
        }
      } catch (_) {}
      const stale  = staleAgeMs > STALE_RELOAD_MS;
      const tooOld = pageAgeMs  > MAX_PAGE_AGE_MS;
      if (DOM_STALE_RELOAD_ENABLED && (stale || tooOld)) {
        appendStaleDebugLog('RELOAD_STALE_OR_AGE', {
          checkAt,
          stale,
          tooOld,
          staleAgeMs,
          pageAgeMs,
          staleThresholdMs: STALE_RELOAD_MS,
          maxAgeThresholdMs: MAX_PAGE_AGE_MS
        }, true);
        log('⚠️ Stale connection hoặc trang quá cũ → reload để khôi phục WebSocket');
        location.reload();
      }
    }, 20 * 1000); // kiểm tra mỗi 20 giây
    log('Evidence-based health monitor active; DOM-stale reload disabled');

    // (Không cần check workerTimer.terminated - Web Worker không có property này;
    //  fallback được kích hoạt trực tiếp qua worker.onerror callback ở trên)

    mainLoop();
  }

  // Guard ch\u1ed1ng double-start: d\u00f9ng flag \u2014 kh\u00f4ng d\u00f9ng workerTimer v\u00ec n\u00f3 null khi Worker t\u1ea1o th\u1ea5t b\u1ea1i
  let _scriptStarted = false;
  function guardedStartScript() {
    if (_scriptStarted) return;
    _scriptStarted = true;
    startScript();
  }

  if (document.readyState === 'complete') {
    setTimeout(guardedStartScript, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(guardedStartScript, 1500));
  }

  // Fallback 5s: ch\u1ec9 ch\u1ea1y n\u1ebfu startScript ch\u01b0a \u0111\u01b0\u1ee3c g\u1ecdi
  setTimeout(() => { guardedStartScript(); }, 5000);
})();
