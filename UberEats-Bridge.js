// UberEats-Bridge.js  v2.0
// Tự động lấy đơn UberEats Merchant Portal (tiếng Việt / Đức / Anh):
//   1. Phát hiện đơn mới → click vào thẻ đơn
//   2. Đọc tên khách, món ăn (kèm ghi chú), tổng tiền, loại thanh toán
//   3. Click "Xem chi tiết" → đọc địa chỉ + SĐT → click "Hoàn tất"
//   4. Lưu payload → mở admin tab tự điền form (KHÔNG submit)
//   5. Quay lại click "Đã sẵn sàng"
//
// KHÔNG bấm submit trên trang admin.

(function () {
  'use strict';

  if (window.__UBEREATS_BRIDGE_V2__) return;
  window.__UBEREATS_BRIDGE_V2__ = true;

  // ── Debug flag (khai báo sớm để dùng được trong patchVisibility) ─────────────
  const DEBUG_GLOBAL = true; // true để bật console.log khi debug
  const dbg = (...a) => { if (DEBUG_GLOBAL) console.log(...a); };

  // ── Ẩn trạng thái background khỏi UberEats ───────────────────────────────────
  // UberEats dùng Page Visibility API để phát hiện app chạy nền rồi đổi sang
  // giao diện "Đơn hàng mới" toàn màn hình. Override để trang luôn báo "visible".
  (function patchVisibility() {
    try {
      const forceProp = (target, key, getter) => {
        try { Object.defineProperty(target, key, { get: getter, configurable: true }); } catch (_) {}
      };
      const docProto = Object.getPrototypeOf(document);
      const alwaysVisible = () => 'visible';
      const alwaysFalse = () => false;
      const alwaysTrue = () => true;

      // Patch both instance + prototype to survive frameworks reading either one.
      forceProp(document, 'visibilityState', alwaysVisible);
      forceProp(docProto,  'visibilityState', alwaysVisible);
      forceProp(document, 'webkitVisibilityState', alwaysVisible);
      forceProp(docProto,  'webkitVisibilityState', alwaysVisible);

      forceProp(document, 'hidden', alwaysFalse);
      forceProp(docProto,  'hidden', alwaysFalse);
      forceProp(document, 'webkitHidden', alwaysFalse);
      forceProp(docProto,  'webkitHidden', alwaysFalse);
      forceProp(document, 'msHidden', alwaysFalse);
      forceProp(docProto,  'msHidden', alwaysFalse);

      // hasFocus is a method; keep it callable to avoid TypeError on hasFocus().
      try { Object.defineProperty(document, 'hasFocus', { value: alwaysTrue, configurable: true }); } catch (_) {}
      try { Object.defineProperty(docProto,  'hasFocus', { value: alwaysTrue, configurable: true }); } catch (_) {}

      // Block focus/visibility transitions consumed by Uber background logic.
      const swallow = e => e.stopImmediatePropagation();
      ['visibilitychange', 'webkitvisibilitychange', 'msvisibilitychange'].forEach(ev => {
        document.addEventListener(ev, swallow, true);
      });
      ['blur', 'pagehide', 'freeze'].forEach(ev => {
        window.addEventListener(ev, swallow, true);
      });
      dbg('[UberEats Bridge] Page Visibility patched — always visible');
    } catch (e) {
      console.warn('[UberEats Bridge] Visibility patch failed:', e);
    }
  })();

  // ── Hằng số (dùng cùng key với ThaiAsia-AllInOneapp.js) ──────────────────────
  const BRIDGE_STORAGE_KEY      = 'thaiasia_takeaway_order_bridge_v9';
  const BRIDGE_ACTIVE_ORDER_KEY = 'thaiasia_takeaway_order_bridge_active_v9';
  const BRIDGE_ORDER_INDEX_KEY  = 'thaiasia_takeaway_order_bridge_index_v9';
  const SENT_ORDERS_KEY         = 'thaiasia_sent_orders_dedup_v9';
  const THAIASIA_URL            = 'https://www.api.thaiasiasushibar.de/admin/orders/create';
  const DEDUP_WINDOW_MS         = 5 * 60 * 1000;
  const ADMIN_SENT_TTL_MS       = 24 * 60 * 60 * 1000; // 24h — dedup đơn đặt trước xuất hiện lại

  // ── Trạng thái ───────────────────────────────────────────────────────────────
  let _state = 'idle';   // idle | working
  let _stateTs = 0;      // timestamp khi _state chuyển 'working' (dùng để auto-reset nếu kẹt)
  const autoProcessed = new Map(); // code → timestamp; dọn sạch tự động sau 12h
  const _orderQueue = []; // FIFO queue: [{el, code}] — khi 2 đơn vào cùng lúc, đơn thứ 2 chờ ở đây
  const _orderFirstSeenAt = new Map(); // code -> ts first seen in DOM/overlay
  const _orderEnqueuedAt = new Map();  // code -> ts pushed into queue
  try { window.__thaiasiaOrderProcessing = false; } catch (_) {}

  function setBridgeState(nextState) {
    _state = nextState;
    try { window.__thaiasiaOrderProcessing = _state === 'working'; } catch (_) {}
  }

  function emitDiag(eventType, payload) {
    try {
      const row = {
        v: 1,
        module: 'ubereats',
        eventType: String(eventType || ''),
        ts: new Date().toISOString(),
        ...(payload || {})
      };
      console.warn('[ThaiAsiaDiag] ' + JSON.stringify(row));
    } catch (_) {}
  }

  function rememberOrderSeen(code, source) {
    const normalized = nt(code || '');
    if (!normalized) return;
    if (!_orderFirstSeenAt.has(normalized)) {
      _orderFirstSeenAt.set(normalized, Date.now());
      emitDiag('order_activity', {
        page: 'uberEatsWin',
        action: 'uber_order_seen_first_time',
        orderCode: normalized,
        source: source || ''
      });
    }
  }

  function enqueueOrder(entry, source) {
    const code = nt(entry && entry.code);
    if (!code) return false;
    rememberOrderSeen(code, source || '');
    if (_orderQueue.some(q => q.code === code)) return false;
    const queuedAt = Date.now();
    _orderEnqueuedAt.set(code, queuedAt);
    const row = { ...entry, code, queuedAt, enqueueSource: source || '' };
    _orderQueue.push(row);
    emitDiag('order_activity', {
      page: 'uberEatsWin',
      action: 'uber_order_enqueued',
      orderCode: code,
      source: source || '',
      queueLength: _orderQueue.length
    });
    return true;
  }

  // ── Tiện ích ─────────────────────────────────────────────────────────────────

  const nt  = t => String(t || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Comparable text: lowercase + strip accents + map Vietnamese "đ" -> "d"
  // so "Đơn hàng mới" reliably becomes "don hang moi".
  const nct = t => nt(t)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đ]/g, 'd');
  const hasOrderItemsText = t => /mat hang|artikel|items?/.test(nct(t)) || /\d+\s*[x×✕✗⨯]\s*/i.test(String(t || ''));
  const hasAcceptActionText = t => /chap nhan|accept|annehmen|annahme|dieu chinh|adjust/.test(nct(t));
  const hasOrderItemsHeader = t => /\b\d+\s*(?:mat hang|artikel|items?)\b/i.test(nct(t));
  const isItemSectionLabel = t => /^(tong|phi|subtotal|total|gesamt|zwischensumme|liefergebuhr|lieferkosten|verkaufsgebuhr)\b/i.test(nct(t));
  const parseOrderHeaderLine = t => {
    const match = nt(t).match(/^(.{1,80})\s*[·•]\s*([A-Z0-9]{4,6})\s*$/);
    return match ? { customerName: parseCustomerName(match[1]), orderCode: match[2] } : null;
  };
  const hasStandaloneOrderHeader = t => String(t || '').split('\n').some(line => !!parseOrderHeaderLine(line));
  const readOrderCardCode = t => {
    const match = nct(t).match(/\b([a-z0-9]{4,6})\s*[·•]\s*\d+\s*(?:mat hang|artikel|items?)\b/i);
    return match ? match[1].toUpperCase() : '';
  };
  const readOrderCardCustomerName = (text, orderCode) => {
    const lines = String(text || '').split('\n').map(nt).filter(Boolean);
    const normalizedCode = nt(orderCode).toUpperCase();
    const codeLineIndex = lines.findIndex(line => {
      const code = readOrderCardCode(line);
      return code && (!normalizedCode || code === normalizedCode);
    });
    if (codeLineIndex > 0) return lines[codeLineIndex - 1];
    return '';
  };
  const eh  = s => String(s || '')
    .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'","&#039;");

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    return (el.offsetWidth > 0 && el.offsetHeight > 0) || (el.scrollWidth > 0 && el.scrollHeight > 0);
  }

  /** Tìm element chứa text (case-insensitive, diacritics-insensitive), visible */
  function findByText(text, selector, root) {
    const want = nct(text);
    return [...((root || document).querySelectorAll(selector || '*'))]
      .find(el => isVisible(el) && nct(el.innerText || el.textContent || '').includes(want)) || null;
  }

  /** Click simulate */
  function clickEl(el) {
    if (!el || typeof el.dispatchEvent !== 'function') return false;
    try { el.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (_) {}
    try { el.focus(); } catch (_) {}
    ['mousedown','mouseup','click'].forEach(ev =>
      el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true }))
    );
    return true;
  }

  function findOverlayReviewBtn(rootEl) {
    const root = rootEl || document;
    const selectors = 'button,[role="button"],a,div,span';
    const raw = [...root.querySelectorAll(selectors)]
      .filter(isVisible)
      .filter(el => /xem lai|review|ansehen|uberprufen|bestellung anzeigen/.test(nct(el.innerText || el.textContent || '')));

    const uniq = [];
    const seen = new Set();
    raw.forEach(el => {
      const actionEl = el.closest('button,[role="button"],a') || el;
      if (!actionEl || seen.has(actionEl)) return;
      seen.add(actionEl);
      uniq.push(actionEl);
    });

    if (!uniq.length) return null;
    uniq.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const sa = nct(a.innerText || a.textContent || '');
      const sb = nct(b.innerText || b.textContent || '');
      const score = (txt, rect, el) => {
        let s = 0;
        if (/^xem lai/.test(txt)) s += 100;
        if (/xem lai/.test(txt)) s += 80;
        if (/review|ansehen|uberprufen|bestellung anzeigen/.test(txt)) s += 40;
        if (el.tagName === 'BUTTON' || el.tagName === 'A') s += 40;
        if ((el.getAttribute('role') || '').toLowerCase() === 'button') s += 35;
        s += Math.max(0, rect.top); // prefer lower controls (like bottom-left CTA)
        s -= rect.width * 0.2;      // avoid giant non-clickable wrappers
        return s;
      };
      return score(sb, rb, b) - score(sa, ra, a);
    });
    return uniq[0];
  }

  function hardClick(el) {
    if (!el) return false;
    const target = el.closest('button,[role="button"],a') || el;
    if (!target) return false;
    try { target.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
    try { target.focus(); } catch (_) {}
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(ev => {
      try { target.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true })); } catch (_) {}
    });
    try { target.click(); } catch (_) {}
    return true;
  }

  /** Chờ element xuất hiện */
  function waitFor(fn, timeoutMs = 8000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = fn();
        if (el) { clearInterval(iv); resolve(el); return; }
        if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('waitFor timeout')); }
      }, intervalMs);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Storage ──────────────────────────────────────────────────────────────────

  function sanitizeKey(code) { return nt(code || '').replace(/[^a-zA-Z0-9_-]/g, '_'); }
  function bridgeKey(code) {
    const s = sanitizeKey(code);
    return s ? `${BRIDGE_STORAGE_KEY}_${s}` : BRIDGE_STORAGE_KEY;
  }

  async function upsertIndex(storageKey, orderCode) {
    try {
      const raw = await GM_getValue(BRIDGE_ORDER_INDEX_KEY, []);
      const idx = Array.isArray(raw) ? raw : [];
      const pos = idx.findIndex(x => x.key === storageKey);
      const entry = { key: storageKey, code: orderCode, ts: Date.now() };
      if (pos >= 0) idx[pos] = entry; else idx.unshift(entry);
      await GM_setValue(BRIDGE_ORDER_INDEX_KEY, idx.slice(0, 20));
    } catch (_) {}
  }

  async function savePayload(payload, options = {}) {
    const code = nt(payload?.orderCode || '');
    const key  = bridgeKey(code);
    const autoSubmit = typeof options.autoSubmit === 'boolean' ? options.autoSubmit : true;
    const fp = {
      ...payload,
      __autoFill:     true,
      __autoSubmit:   autoSubmit,    // false: dừng ở submit (thủ công); true: tự submit (tự động)
      __autoActionAt: Date.now(),
    };
    delete fp.__storageKey;
    await GM_setValue(key, fp);
    await GM_setValue(BRIDGE_ACTIVE_ORDER_KEY, key);
    await upsertIndex(key, code);
    return key;
  }

  async function wasRecentlySent(code) {
    if (!code) return false;
    const data = await GM_getValue(SENT_ORDERS_KEY, []);
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    return (Array.isArray(data) ? data : []).filter(e => e.ts > cutoff).some(e => e.code === nt(code));
  }

  async function markSent(code) {
    if (!code) return;
    const data = await GM_getValue(SENT_ORDERS_KEY, []);
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    const arr = (Array.isArray(data) ? data : []).filter(e => e && e.ts > cutoff);
    arr.push({ code: nt(code), ts: Date.now() });
    await GM_setValue(SENT_ORDERS_KEY, arr);
  }

  // Dedup đơn đặt trước đã gửi admin (24h TTL)
  // Lưu song song vào GM_setValue (RAM) + localStorage (tồn tại qua restart app)
  const ADMIN_SENT_KEY = 'thaiasia_admin_sent_scheduled_v9';
  const ADMIN_SENT_LS_KEY = 'thaiasia_admin_sent_scheduled_persist_v9';

  function _lsGetAdminSent() {
    try {
      const raw = localStorage.getItem(ADMIN_SENT_LS_KEY);
      const data = raw ? JSON.parse(raw) : [];
      const cutoff = Date.now() - ADMIN_SENT_TTL_MS;
      return Array.isArray(data) ? data.filter(e => e && e.ts > cutoff) : [];
    } catch (_) { return []; }
  }
  function _lsSetAdminSent(arr) {
    try { localStorage.setItem(ADMIN_SENT_LS_KEY, JSON.stringify(arr)); } catch (_) {}
  }

  async function wasAdminSent(code) {
    if (!code) return false;
    const cutoff = Date.now() - ADMIN_SENT_TTL_MS;
    // Kiểm tra localStorage trước (tồn tại qua restart)
    if (_lsGetAdminSent().some(e => e.code === nt(code))) return true;
    // Fallback: GM_setValue (RAM)
    const data = await GM_getValue(ADMIN_SENT_KEY, []);
    return (Array.isArray(data) ? data : []).filter(e => e.ts > cutoff).some(e => e.code === nt(code));
  }
  async function markAdminSent(code) {
    if (!code) return;
    const cutoff = Date.now() - ADMIN_SENT_TTL_MS;
    // Lưu vào localStorage
    const lsArr = _lsGetAdminSent().filter(e => e.code !== nt(code));
    lsArr.push({ code: nt(code), ts: Date.now() });
    _lsSetAdminSent(lsArr);
    // Lưu vào GM_setValue (RAM)
    const data = await GM_getValue(ADMIN_SENT_KEY, []);
    const arr = (Array.isArray(data) ? data : []).filter(e => e.ts > cutoff && e.code !== nt(code));
    arr.push({ code: nt(code), ts: Date.now() });
    await GM_setValue(ADMIN_SENT_KEY, arr);
  }

  // ── Parse tên khách: "Thai Ba, C. • C0044" → "Thai Ba, C." ──────────────────────
  function parseCustomerName(raw) {
    // Chỉ bỏ phần " • ORDERCODE" ở cuối, giữ nguyên tên đầy đủ (kể cả dấu phẩy)
    return nt(raw || '').replace(/\s*[·•]\s*[A-Z0-9]+\s*$/, '').trim();
  }

  // ── Tìm modal chi tiết đơn ────────────────────────────────────────────────────
  function findOrderModal() {
    // UberEats mở overlay/dialog khi click thẻ đơn
    // Tìm container có chứa text "mặt hàng" (tiếng Việt) hoặc pattern items
    const byRole = [...document.querySelectorAll('[role="dialog"],[role="region"],[role="main"]')]
      .filter(isVisible)
      .filter(el => {
        const t = nt(el.innerText || '');
        return hasOrderItemsText(t) || /\d+\s*[x×]\s*.+€/.test(t);
      });
    if (byRole.length) {
      return byRole.sort((a, b) => {
        const headerDiff = Number(hasStandaloneOrderHeader(b.innerText || '')) - Number(hasStandaloneOrderHeader(a.innerText || ''));
        if (headerDiff) return headerDiff;
        const dialogDiff = Number(b.getAttribute('role') === 'dialog') - Number(a.getAttribute('role') === 'dialog');
        if (dialogDiff) return dialogDiff;
        const actionDiff = Number(hasAcceptActionText(b.innerText || '')) - Number(hasAcceptActionText(a.innerText || ''));
        if (actionDiff) return actionDiff;
        return nt(a.innerText || '').length - nt(b.innerText || '').length;
      })[0];
    }

    // Fallback: vùng giữa màn hình chứa list items (mở rộng selector cho full-page layout)
    const all = [...document.querySelectorAll('div,section,article,main,aside')]
      .filter(isVisible)
      .filter(el => {
        const t = nt(el.innerText || '');
        const tnct = nct(t);
        // Nhận diện qua giá € + items, HOẶC qua "mặt hàng" + "chấp nhận" (không phụ thuộc ký tự ×)
        return (/\d+[,.]\d{2}\s*€/.test(t) && hasOrderItemsText(t))
            || (hasOrderItemsText(t) && hasAcceptActionText(tnct));
    });
    if (!all.length) return null;
    all.sort((a, b) => {
      const headerDiff = Number(hasStandaloneOrderHeader(b.innerText || '')) - Number(hasStandaloneOrderHeader(a.innerText || ''));
      if (headerDiff) return headerDiff;
      const actionDiff = Number(hasAcceptActionText(b.innerText || '')) - Number(hasAcceptActionText(a.innerText || ''));
      if (actionDiff) return actionDiff;
      return nt(a.innerText || '').length - nt(b.innerText || '').length;
    });
    return all[0];
  }

  /** Đọc header modal: "Asia Sushibar, T. • BD843" → orderCode='BD843' */
  function readHeader(modal, expectedOrderCode = '') {
    const expectedCode = nt(expectedOrderCode).toUpperCase();
    const roots = [];
    if (modal) roots.push(modal);
    if (document.body && !roots.includes(document.body)) roots.push(document.body);
    if (!roots.length) roots.push(document);

    for (const root of roots) {
    // Ưu tiên: tìm element nhỏ (ít con) chứa pattern "text • CODE" với CODE là 4-6 ký tự HOA/số
    // CODE phải có ít nhất 1 CHỮ HOA (không phải thuần số — tránh nhầm zip code)
    const allEls = [...root.querySelectorAll('h1,h2,h3,h4,p,span,div,a')]
      .filter(isVisible)
      .filter(el => /[·•]/.test(el.innerText || ''));
    for (const el of allEls) {
      if (el.children.length > 8) continue;
      const t = nt(el.innerText || el.textContent || '');
        const header = parseOrderHeaderLine(t);
        if (header && (!expectedCode || header.orderCode === expectedCode)) return header;
    }
    // Fallback: quét từng dòng của toàn trang
    const lines = (root.innerText || document.body.innerText || '').split('\n').map(nt).filter(Boolean);
    for (const line of lines) {
        const header = parseOrderHeaderLine(line);
        if (header && (!expectedCode || header.orderCode === expectedCode)) return header;
      }
    }
    return { customerName: '', orderCode: '' };
  }

  /**
   * Đọc danh sách món ăn từ modal.
   * UberEats Merchant Portal (VI):
   *   "1 × 11. Mini-Frühlingsrollen (vegetarisch, 8 Stück)  5,90 €"
   *   ghi chú món hiện ngay dưới: "test 1"  (có thể trong dấu ngoặc kép)
   *
   * Bỏ phần giá ở cuối dòng khi lưu code.
   * Bỏ dấu ngoặc kép khỏi ghi chú.
   */
  function readItems(modal) {
    const items = [];
    const root = modal || document;
    const PRICE_LINE_RE = /^(?:\s*(?:EUR\s*\d+[,.]\d{2}|\d+[,.]\d{2}\s*(?:EUR|\u20AC)|\u20AC\s*\d+[,.]\d{2})\s*)+$/i;
    const PRICE_TAIL_RE = /\s*(?:(?:EUR\s*\d+[,.]\d{2}|\d+[,.]\d{2}\s*(?:EUR|\u20AC)|\u20AC\s*\d+[,.]\d{2})\s*)+(?:[\u22EE\u2026]\s*)?$/i;
    const MENU_LINE_RE = /^[\u22EE\u2026]+$/;
    const isPriceLine = text => PRICE_LINE_RE.test(nt(text).replace(/[\u22EE\u2026]/g, '').trim());
    const isMenuLine = text => MENU_LINE_RE.test(nt(text));
    const stripTrailingPrice = text => {
      let value = nt(text).replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
      let previous = '';
      while (value && value !== previous) {
        previous = value;
        value = value.replace(PRICE_TAIL_RE, '').replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
      }
      return value.replace(/\s*[:;]\s*$/, '').trim();
    };
    const isQtyOnlyLine = text => /^\d{1,3}$/.test(nt(text));
    const isTimesOnlyLine = text => /^[x×]$/i.test(nt(text));
    const isQtyTimesOnlyLine = text => /^(\d{1,3})\s*[x×]\s*$/.exec(nt(text));
    const isSummaryOrActionLine = text =>
      /^(tong|phi|uu dai|giam gia|subtotal|total|gesamt|zwischensumme|summe|liefergebuhr|lieferkosten|rabatt|promotion|discount|delivery fee|service fee|tax|taxes|da san sang|bat dau giao hang|dieu chinh don hang|bestellung anpassen|lieferung starten|lieferung beginnen|auslieferung starten|auslieferung beginnen|als bereit markieren)\b/i.test(nct(text));
    const isMoneyOnlyLine = text => /^(?:(?:EUR\s*)?\d+[,.]\d{2}\s*(?:EUR|\u20AC)?|\u20AC\s*\d+[,.]\d{2})$/i.test(nt(text).replace(/[\u22EE\u2026]/g, '').trim());
    const cleanItemNoteLine = text => nt(text)
      .replace(/^[-•\u2022\s]+/, '')
      .replace(/^["\u201c\u201e\u201d]+|["\u201c\u201e\u201d]+$/g, '')
      .trim();
    const isLikelyItemNoteLine = text => {
      const value = nt(text);
      const comparable = nct(value);
      if (!value || value.length > 200) return false;
      if (isMoneyOnlyLine(value)) return false;
      if (isPriceLine(value) || isMenuLine(value) || isQtyOnlyLine(value) || isTimesOnlyLine(value) || isQtyTimesOnlyLine(value)) return false;
      if (/^\d+\s*[x×]/i.test(value) || isItemSectionLabel(value) || isSummaryOrActionLine(value)) return false;
      if (/^(thu tien mat|so tien da|cash|online|payment|thanh toan|bargeld|barzahlung|bezahlt|zahlung|khach hang|customer|kunde|new customer|neuer kunde)/i.test(comparable)) return false;
      return true;
    };
    const upsertItem = item => {
      const code = nt(item && item.code);
      const qty = nt(item && item.qty);
      if (!code || !qty) return;
      const existing = items.find(x => x.code === code && x.qty === qty);
      if (existing) {
        if (!existing.note && item.note) existing.note = item.note;
        return;
      }
      items.push({ qty, code, name: item.name || '', note: item.note || '' });
    };
    const tryReadSplitItemBlock = (lines, startIdx) => {
      const firstLine = lines[startIdx] || '';
      let qty = '';
      let nameIdx = startIdx + 1;
      const qtyTimes = isQtyTimesOnlyLine(firstLine);
      if (qtyTimes) {
        qty = qtyTimes[1];
      } else if (isQtyOnlyLine(firstLine)) {
        qty = nt(firstLine);
        if (isTimesOnlyLine(lines[nameIdx] || '')) nameIdx++;
      } else {
        return null;
      }

      if (!qty || nameIdx >= lines.length) return null;

      const nameLines = [];
      let sawPrice = false;
      let note = '';
      let cursor = nameIdx;
      const maxCursor = Math.min(lines.length, nameIdx + 8);
      while (cursor < maxCursor) {
        const current = lines[cursor] || '';
        if (isPriceLine(current)) {
          sawPrice = true;
          cursor++;
          while (cursor < lines.length && (isPriceLine(lines[cursor]) || isMenuLine(lines[cursor]))) cursor++;
          if (isLikelyItemNoteLine(lines[cursor] || '')) {
            note = cleanItemNoteLine(lines[cursor]);
            cursor++;
          }
          break;
        }
        if (isMenuLine(current)) {
          cursor++;
          continue;
        }
        if (isItemSectionLabel(current) || isSummaryOrActionLine(current)) break;
        if (!nameLines.length && (isTimesOnlyLine(current) || isQtyOnlyLine(current) || /^\d+\s*[x×]/i.test(current))) {
          return null;
        }
        if (nameLines.length && (isQtyOnlyLine(current) || /^\d+\s*[x×]/i.test(current))) break;

        const cleanLine = stripTrailingPrice(current).replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
        if (cleanLine && !isPriceLine(cleanLine) && !isMenuLine(cleanLine)) nameLines.push(cleanLine);
        cursor++;
      }

      const code = nameLines.join(' ').replace(/\s+/g, ' ').trim();
      if (!sawPrice || code.length < 2) return null;
      return { qty, code, note, nextIdx: Math.max(cursor, startIdx + 1) };
    };

    // Tìm tất cả element lá hoặc ít con chứa pattern "N ×" / "N x"
    const allEls = [...root.querySelectorAll('*')].filter(isVisible);

    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      // Chỉ xét element có ít con (lá hoặc wrapper đơn giản)
      if (el.children.length > 12) continue;

      const raw = nt(el.innerText || el.textContent || '');
      const m   = raw.match(/^(\d+)\s*[x×]\s*(.{2,150})$/i);
      if (!m) continue;

      const qty  = m[1];
      // Bỏ giá ở cuối: "5,90 €" / "14,60 €"
      let code   = stripTrailingPrice(m[2]);
      if (code.length < 2) continue;

      // Bỏ ký tự icon "⋮" ở cuối (UberEats dùng menu 3 chấm)
      code = code.replace(/\s*[⋮…]+\s*$/, '').trim();

      // Tìm ghi chú ngay dưới: sibling hoặc next el trong DOM
      let note = '';
      const sibling = el.nextElementSibling;
      if (sibling && isVisible(sibling)) {
        const st = nt(sibling.innerText || sibling.textContent || '');
        // Ghi chú: ngắn, không phải item mới, không phải giá
        if (st && st.length < 200 && !/^\d+\s*[x×]/i.test(st) && !isItemSectionLabel(st)
            && !isPriceLine(st) && !isMenuLine(st)) {
          note = st.replace(/^[""]|[""]$/g, '').replace(/^[""]|[""]$/g, '');
        }
      }

      upsertItem({ qty, code, name: '', note });
    }

    // Fallback: parse text thuần theo dòng
    // Hỗ trợ: "1 × Tên" (1 dòng), "1 ×\nTên" (2 dòng), "1\n×\nTên" (3 dòng riêng)
    {
      // Dùng modal.innerText nếu có (tránh lấy nội dung sidebar/trang khác)
      const srcText = modal?.innerText || document.body.innerText || '';
      const lines = srcText.split('\n').map(nt).filter(Boolean);
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        const splitBlock = tryReadSplitItemBlock(lines, i);
        if (splitBlock) {
          upsertItem({ qty: splitBlock.qty, code: splitBlock.code, name: '', note: splitBlock.note || '' });
          i = splitBlock.nextIdx;
          continue;
        }

        // Case A: "1 × 18. Seetang Salat  5,90 €" — tất cả trên 1 dòng
        const mA = line.match(/^(\d+)\s*[x×]\s*(.{2,180})$/i);
        if (mA) {
          const qty  = mA[1];
          const code = stripTrailingPrice(mA[2]).replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
          if (code.length >= 2) {
            let note = '';
            const nxt = lines[i + 1] || '';
            if (nxt && !/^\d+\s*[x×]/i.test(nxt) && !isItemSectionLabel(nxt)
                && !isPriceLine(nxt) && !isMenuLine(nxt) && nxt.length < 200) {
              note = nxt.replace(/^[""\u201c\u201e]|[""\u201d\u201e]$/g, '');
              i++;
            }
            upsertItem({ qty, code, name: '', note });
          }
          i++; continue;
        }

        // Case B: "1 ×" trên 1 dòng, tên món trên dòng tiếp theo
        const mB = line.match(/^(\d+)\s*[x×]\s*$/);
        if (mB && i + 1 < lines.length) {
          const nameLine = lines[i + 1];
          if (nameLine && nameLine.length >= 2
              && !/^\d+[,.]\d{2}\s*€/.test(nameLine)
              && !isItemSectionLabel(nameLine) && !isMenuLine(nameLine)
              && !/^\d+\s*[x×]/i.test(nameLine)) {
            const qty  = mB[1];
            const code = stripTrailingPrice(nameLine).replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
            if (code.length >= 2) {
              let note = '';
              const nxt = lines[i + 2] || '';
            if (nxt && !/^\d+\s*[x×]/i.test(nxt) && !isItemSectionLabel(nxt)
                && !isPriceLine(nxt) && !isMenuLine(nxt) && nxt.length < 200) {
                note = nxt.replace(/^[""\u201c\u201e]|[""\u201d\u201e]$/g, '');
                i += 3;
              } else {
                i += 2;
              }
              upsertItem({ qty, code, name: '', note });
              continue;
            }
          }
        }

        // Case C: qty trên 1 dòng, "×" trên dòng tiếp, tên món trên dòng sau
        // UberEats flex layout: 1 / × / 18. Seetang Salat / 5,90 € — mỗi cái 1 dòng
        const mC = line.match(/^(\d+)$/);
        if (mC && i + 2 < lines.length) {
          const timesLine = lines[i + 1];
          if (/^[x×]$/i.test(timesLine)) {
            const nameLine = lines[i + 2];
            if (nameLine && nameLine.length >= 2
                && !/^\d+[,.]\d{2}\s*€/.test(nameLine)
                && !isItemSectionLabel(nameLine) && !isMenuLine(nameLine)
                && !/^\d+\s*[x×]/i.test(nameLine)) {
              const qty  = mC[1];
              const code = stripTrailingPrice(nameLine).replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
              if (code.length >= 2) {
                let note = '';
                // Bỏ qua dòng giá (5,90 € hoặc €5,90) và dòng ⋮
                let ni = i + 3;
                if (lines[ni] && isPriceLine(lines[ni])) ni++;
                if (lines[ni] && isMenuLine(lines[ni])) ni++;
                const potNote = lines[ni] || '';
                if (potNote && !/^\d+$/.test(potNote) && !/^[x×]$/i.test(potNote)
                    && !/^\d+\s*[x×]/i.test(potNote) && !isPriceLine(potNote)
                    && !isItemSectionLabel(potNote) && potNote.length < 200) {
                  note = potNote.replace(/^[""\u201c\u201e]|[""\u201d\u201e]$/g, '');
                  i = ni + 1;
                } else {
                  i += 3;
                }
                upsertItem({ qty, code, name: '', note });
                continue;
              }
            }
          }

          // Case D: qty / tên món / giá € (không có ×) — format thực tế UberEats VI
          // Xác nhận bằng cách check lines[i+2] là giá tiền
          const nameLineD = lines[i + 1];
          if (nameLineD && nameLineD.length >= 2
              && !/^[x×]$/i.test(nameLineD)
              && !isPriceLine(nameLineD)
              && !isItemSectionLabel(nameLineD) && !isMenuLine(nameLineD)
              && !/^\d+$/.test(nameLineD)) {
            const priceLineD = lines[i + 2] || '';
            if (isPriceLine(priceLineD)) {
              const qty  = mC[1];
              const code = stripTrailingPrice(nameLineD).replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
              if (code.length >= 2) {
                let note = '';
                let ni = i + 3;
                if (lines[ni] && isPriceLine(lines[ni])) ni++;
                if (lines[ni] && isMenuLine(lines[ni])) ni++;
                const potNote = lines[ni] || '';
                if (potNote && !/^\d+$/.test(potNote) && !/^[x×]$/i.test(potNote)
                    && !isPriceLine(potNote)
                    && !isItemSectionLabel(potNote) && potNote.length < 200) {
                  note = potNote.replace(/^[""\u201c\u201e]|[""\u201d\u201e]$/g, '');
                  i = ni + 1;
                } else {
                  i += 3;
                }
                upsertItem({ qty, code, name: '', note });
                continue;
              }
            }
          }
        }

        i++;
      }
    }

    return items;
  }

  /**
   * Đọc thanh toán từ modal.
   * "Thu tiền mặt cho đơn hàng này" → Bar, lấy "Tiền mặt phải trả X €" làm total
   * "Số tiền đã thanh toán" → Online, không cần total (fill 0)
   * Bảng cuối: Tổng X €, Phí giao hàng X €, Phí bán hàng X €, Tiền mặt phải trả X €
   */
  function readPayment(modal) {
    const root = modal || document;
    const rawText = root.innerText || root.textContent || '';
    const lines = rawText.split('\n').map(nt).filter(Boolean);
    const textNorm = nct(lines.join(' '));

    let paymentMethod = 'Online';
    let subtotal = '', deliveryFee = '', total = '';

    if (/thu tien mat|cash|bargeld|barzahlung|nimm.*bargeld|bargeld entgegen|falliger bargeldbetrag|tien mat phai tra|bar zu zahlen/i.test(textNorm)) {
      paymentMethod = 'Bar';
    }

    const getVal = str => {
      const m = String(str || '').match(/(?:€\s*(\d[\d,.]*)|(\d[\d,.]*)\s*€)/);
      return m ? (m[1] || m[2]).replace(',', '.') : '';
    };
    const isEuroLine = s => /^(?:€\s*\d[\d,.]*|\d[\d,.]*\s*€)$/.test(String(s || '').trim());

    // UberEats layout: tất cả label trước, rồi tất cả giá trị sau (theo đúng thứ tự)
    // Ví dụ VI: ["Tổng", "Phí giao hàng", "Phí bán hàng (phí của Uber)", "Tiền mặt phải trả",
    //            "38,60 €", "3,00 €", "3,09 €", "44,69 €"]
    // Ví dụ DE: ["Zwischensumme", "Liefergebühr", "Marketplace-Gebühr (Gebühren von Uber)", "Fälliger Bargeldbetrag",
    //            "38,60 €", "3,00 €", "3,09 €", "44,69 €"]
    const PAYMENT_LABELS = [
      { re: /^(?:tong|tam tinh|subtotal|total|gesamt(?:summe)?|zwischensumme|bestellwert)\s*$/i, key: 'subtotal' },
      { re: /^(?:phi giao hang|delivery fee|liefergebuhr|lieferkosten|lieferung)\s*$/i, key: 'delivery' },
      { re: /^(?:phi ban hang|phi dich vu|service fee|marketplace|verkaufsgebuhr|gebuhren von uber|servicegebuhr)/i, key: '_ignore' },
      { re: /(?:tien mat phai tra|so tien can thu|cash due|total due|amount due|bar zu zahlen|falliger bargeldbetrag|bargeldbetrag|falliger betrag|zu zahlen)/i, key: 'cash' },
      { re: /(?:so tien da thanh toan|amount paid|betrag bezahlt|bereits bezahlt|online bezahlt)/i, key: 'paid' },
    ];

    let blockStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^(?:tong|tam tinh|subtotal|total|gesamt(?:summe)?|zwischensumme|bestellwert)\s*$/i.test(nct(lines[i]))) {
        blockStart = i;
        break;
      }
    }

    if (blockStart >= 0) {
      const collectedKeys = [];
      let j = blockStart;
      while (j < lines.length && !isEuroLine(lines[j])) {
        const norm = nct(lines[j]);
        const iv = getVal(lines[j]);
        if (iv) {
          if (/^(?:tong|tam tinh|subtotal|total|gesamt(?:summe)?|zwischensumme|bestellwert)\b/i.test(norm)) subtotal = subtotal || iv;
          if (/^(?:phi giao hang|delivery fee|liefergebuhr|lieferkosten|lieferung)\b/i.test(norm)) deliveryFee = deliveryFee || iv;
          if (/(?:tien mat phai tra|so tien can thu|cash due|total due|amount due|bar zu zahlen|falliger bargeldbetrag|bargeldbetrag|falliger betrag|zu zahlen)/i.test(norm)) total = iv;
          if (/(?:so tien da thanh toan|amount paid|betrag bezahlt|bereits bezahlt|online bezahlt)/i.test(norm)) {
            if (!total) total = iv;
            paymentMethod = 'Online';
          }
        }
        for (const lbl of PAYMENT_LABELS) {
          if (lbl.re.test(norm) && !getVal(lines[j])) {
            collectedKeys.push(lbl.key);
            break;
          }
        }
        j++;
      }
      if (collectedKeys.length) {
        const amounts = [];
        while (j < lines.length && amounts.length < collectedKeys.length) {
          if (isEuroLine(lines[j])) amounts.push(getVal(lines[j]));
          j++;
        }
        for (let k = 0; k < collectedKeys.length; k++) {
          const v = amounts[k];
          if (!v) continue;
          if (collectedKeys[k] === 'subtotal')  subtotal    = subtotal    || v;
          if (collectedKeys[k] === 'delivery')  deliveryFee = deliveryFee || v;
          if (collectedKeys[k] === 'cash')      { total = v; paymentMethod = 'Bar'; }
          if (collectedKeys[k] === 'paid')      { if (!total) total = v; paymentMethod = 'Online'; }
        }
      }
    }

    // Fallback inline scan (khi label và số tiền ở cùng dòng hoặc dòng liền kề)
    if (!subtotal || !total) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const norm = nct(line);
        const v = getVal(line);
        const nv = getVal(lines[i + 1] || '');

        if (!subtotal && /^(?:tong|tam tinh|subtotal|total|gesamt(?:summe)?|zwischensumme|bestellwert)\b/i.test(norm)) {
          subtotal = v || nv;
        }
        if (!deliveryFee && /^(?:phi giao hang|delivery fee|liefergebuhr|lieferkosten|lieferung)\b/i.test(norm)) {
          deliveryFee = v || nv;
        }
        if (!total && /(?:tien mat phai tra|so tien can thu|cash due|total due|amount due|bar zu zahlen|falliger bargeldbetrag|bargeldbetrag|falliger betrag|zu zahlen)/i.test(norm)) {
          const c = v || nv;
          if (c) {
            total = c;
            paymentMethod = 'Bar';
          }
        }
        if (!total && /(?:so tien da thanh toan|amount paid|betrag bezahlt|bereits bezahlt|online bezahlt)/i.test(norm)) {
          const p = v || nv;
          if (p) {
            total = p;
            paymentMethod = 'Online';
          }
        }
      }
    }

    if (!total) total = subtotal;

    for (const line of lines) {
      const norm = nct(line);
      if (/so tien da thanh toan|amount paid|betrag bezahlt|bereits bezahlt|online bezahlt/i.test(norm)) {
        if (!/(?:tien mat phai tra|falliger bargeldbetrag|bar zu zahlen|cash due)/i.test(textNorm)) {
          paymentMethod = 'Online';
        }
        break;
      }
    }

    return { paymentMethod, subtotal, deliveryFee, total };
  }

  /** Đọc delivery time: "Thời gian giao hàng ước tính 10:59" */
  function readDeliveryTime(modal) {
    const text = nt((modal || document.body).innerText || '');
    // Đơn ASAP (xanh lá): "Thời gian giao hàng ước tính 10:59"
    const m1 = text.match(/ước tính\s+(\d{1,2}:\d{2})/i);
    if (m1) return m1[1];
    const m2 = text.match(/estimated?\s+(\d{1,2}:\d{2})/i);
    if (m2) return m2[1];
    const m2de = text.match(/voraussichtlich[\s\S]{0,40}\b(\d{1,2}:\d{2})/i);
    if (m2de) return m2de[1];
    const m2deAlt = nct(text).match(/(?:geschatzte lieferzeit|lieferung voraussichtlich)[\s\S]{0,40}\b(\d{1,2}:\d{2})/i);
    if (m2deAlt) return m2deAlt[1];
    // Đơn đặt trước (xanh nước biển): "dự kiến vào khoảng hôm nay tại 19:00"
    // Dùng pattern cụ thể hơn để tránh khớp sai từ "tại" trong câu khác
    const m3 = text.match(/dự kiến[\s\S]{0,60}tại\s+\b(\d{1,2}:\d{2})/i);
    if (m3) return m3[1];
    const m4 = text.match(/scheduled[\s\S]{0,60}at\s+\b(\d{1,2}:\d{2})/i);
    if (m4) return m4[1];
    const m4de = text.match(/(?:geplant|vorbestellt)[\s\S]{0,60}(?:um|für)\s+\b(\d{1,2}:\d{2})/i);
    if (m4de) return m4de[1];
    return '';
  }

  /** Kiểm tra đơn có phải đặt trước (xanh nước biển) không */
  function isScheduledOrder(modal) {
    const text = (modal || document.body).innerText || '';
    // Dấu hiệu đặt trước
    if (/dự kiến vào khoảng|đặt trước|scheduled|vorbestellung|vorbestellt|geplant/i.test(text)) return true;
    // Dấu hiệu ASAP (xanh lá) → chắc chắn KHÔNG phải đặt trước
    if (/giao hàng sau|thời gian giao hàng ước tính|estimated delivery|voraussichtliche lieferzeit/i.test(text)) return false;
    return false;
  }

  /**
   * Lấy nguyên dòng thời gian bắt đầu chuẩn bị cho đơn ở ngày tương lai.
   * Đơn "Hôm nay" giữ nguyên hành vi cũ và không thêm dòng này vào Admin.
   */
  function readFuturePreparationNote(modal) {
    const text = nt((modal || document.body).innerText || '');
    const patterns = [
      /((?:Thời gian\s+)?bắt đầu chuẩn bị\s+dự kiến vào khoảng\s+.{1,80}?\s+(?:tại|lúc)\s+\d{1,2}:\d{2})/i,
      /((?:Estimated\s+)?preparation\s+(?:start(?:ing)?\s+time|will start)[\s\S]{0,80}?\b(?:at|for)\s+\d{1,2}:\d{2})/i,
      /((?:Voraussichtlicher|Geplanter)?\s*Vorbereitungsbeginn[\s\S]{0,80}?\b(?:um|für)\s+\d{1,2}:\d{2})/i
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const note = nt(match[1]);
      const comparable = nct(note);
      if (/\b(?:hom nay|today|heute)\b/i.test(comparable)) return '';
      return note;
    }
    return '';
  }

  /** Cộng thêm phút vào chuỗi giờ "HH:MM" */
  function addMinutesToTime(timeStr, mins) {
    const m = timeStr.match(/(\d{1,2}):(\d{2})/);
    if (!m) return timeStr;
    const total = parseInt(m[1]) * 60 + parseInt(m[2]) + mins;
    const h = Math.floor(total / 60) % 24;
    const min = total % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  /** Đọc ghi chú đơn hàng (order-level note, không phải ghi chú món) */
  function readOrderNote(modal) {
    const root = modal || document;
    const lines = (root.innerText || '').split('\n').map(nt).filter(Boolean);

    // Cấu trúc UberEats:
    //   "N mặt hàng" header → [ghi chú ĐƠN] → payment → 2 / × / tên món / giá (mỗi thứ 1 dòng)
    // Ghi chú đơn nằm TRONG VÙNG NGẮN ngay sau header "N mặt hàng",
    // TRƯỚC khi gặp dòng chỉ là số (qty của item đầu tiên).

    // Tìm dòng "N mặt hàng" — ưu tiên tìm SAU dòng header "Tên • MãĐơn" của modal
    // (tránh nhầm với "D457E • 2 mặt hàng" từ card bên trái)
    let customerHeaderIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      // Dòng header modal: kết thúc bằng "• ABCD1" (mã đơn), KHÔNG chứa "mặt hàng"
      if (/\s*[·•]\s*[A-Z0-9]{4,6}\s*$/.test(lines[i]) && !hasOrderItemsHeader(lines[i])) {
        customerHeaderIdx = i; break;
      }
    }
    let headerIdx = -1;
    const noteSearchFrom = customerHeaderIdx >= 0 ? customerHeaderIdx : 0;
    for (let i = noteSearchFrom; i < lines.length; i++) {
      if (hasOrderItemsHeader(lines[i])) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return ''; // không có header → không đọc ghi chú

    dbg('[UberEats Bridge] readOrderNote window:', lines.slice(headerIdx, Math.min(headerIdx + 25, lines.length)));

    // Tìm vị trí dòng items thực sự
    // Cũng dừng sớm nếu gặp marker của panel phải (đã sẵn sàng, bắt đầu giao hàng...)
    const PANEL_RIGHT_MARKERS = /^(da san sang|bat dau giao hang|dieu chinh don hang|giao hang voi|chung toi dang|bereit|als bereit markieren|lieferung starten|lieferung beginnen|auslieferung starten|auslieferung beginnen|bestellung anpassen|lieferung durch|wir bereiten)/i;
    const ORDER_PRICE_LINE_RE = /^(?:\s*(?:EUR\s*\d+[,.]\d{2}|\d+[,.]\d{2}\s*(?:EUR|\u20AC)|\u20AC\s*\d+[,.]\d{2})\s*)+$/i;
    const isOrderPriceLine = text => ORDER_PRICE_LINE_RE.test(nt(text).replace(/[\u22EE\u2026]/g, '').trim());
    const isMoneyOnlyOrderLine = text => /^(?:(?:EUR\s*)?\d+[,.]\d{2}\s*(?:EUR|\u20AC)?|\u20AC\s*\d+[,.]\d{2})$/i.test(nt(text).replace(/[\u22EE\u2026]/g, '').trim());
    let itemsStartIdx = Math.min(headerIdx + 20, lines.length); // window tối đa 20 dòng
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (PANEL_RIGHT_MARKERS.test(nct(lines[i]))) { itemsStartIdx = i; break; }
      if (/^\d+\s*[x×]/i.test(lines[i])) { itemsStartIdx = i; break; }
      // Dòng chỉ là số nhỏ (1-9, là qty món) VÀ dòng tiếp là "×" hoặc tên món
      // KHÔNG dừng ở số lớn như "40" (phút giao hàng) hoặc giá tiền
      if (/^\d$/.test(lines[i])) {
        const next = lines[i + 1] || '';
        const afterNext = lines[i + 2] || '';
        if (/^[x×]$/i.test(next)
            || (next.length > 2 && !/^\d/.test(next) && !/^(phut|sua|tong|phi|minuten?|bearbeiten|gesamt|zwischensumme|liefergebuhr)/i.test(nct(next)))
            // Case D: qty / tên-bắt-đầu-bằng-chữ-số / giá (€11,70 hoặc 11,70 €)
            || (next.length >= 2 && !/^(phut|sua|tong|phi|minuten?|bearbeiten|gesamt|zwischensumme|liefergebuhr)/i.test(nct(next))
                && isOrderPriceLine(afterNext))) {
          itemsStartIdx = i; break;
        }
      }
    }

    // Chỉ tìm ghi chú trong vùng [header+1 .. itemsStart)
    // Bỏ qua các dòng không phải ghi chú: payment, cutlery badge, số phút giao hàng, v.v.
    const SKIP_PATTERNS = [
      /^(thu tiền mặt|số tiền đã|cash|online|payment|thanh toán|bargeld|barzahlung|bezahlt|zahlung|nimm\s+bei\s+dieser\s+bestellung\s+bargeld|nimm.*bargeld|bargeld\s+entgegen)/i,
      /^(thời gian|giao hàng sau|ước tính|giao hang sau|uoc tinh|lieferzeit|voraussichtlich|geschatzte)/i,
      /^(khách hàng mới|khach hang moi|new customer|neuer kunde)/i,
      /^(khách hàng thường xuyên|khach hang thuong xuyen|regular customer|returning customer|frequent customer|stammkund|wiederkehrender kunde)/i,
      /\(\s*\d+\s*(đơn hàng|don hang|orders?|bestellungen?)\s*\)/i,
      /^(khách hàng|khach hang|customer|kunde)\s*$/i,
      /^(giao hàng với nhân viên|giao hang voi nhan vien|driver delivery|lieferung durch)/i,
      /^(giao hàng sau|giao hang sau|delivery after|lieferung nach)/i,
      /^(điều chỉnh|dieu chinh|chấp nhận|chap nhan|anpassen|annehmen)/i,
      /^(đã sẵn sàng|da san sang|ready|mark as ready|đánh dấu|bereit|als bereit markieren)/i,
      /^(bắt đầu giao hàng|bat dau giao hang|start delivery|lieferung starten|lieferung beginnen|auslieferung starten|auslieferung beginnen)/i,
      /^(giao hàng với|giao hang voi)/i,
      /^(chúng tôi|chung toi|we are)/i,
      /^\d{2,}\s*(phút|min|giờ|h|minuten?|stunden?)/i,
      /^(có|không|co|khong|mới|moi|ja|nein|neu)\s*$/i,
      /^\d{1,2}:\d{2}$/,
      /^(sửa|bearbeiten)\s*$/i,
      /^\p{Emoji}/u,
      // Label thanh toán (UberEats đôi khi render vùng payment trước items trong DOM)
      /^(tổng|phí giao hàng|phí bán hàng|tiền mặt phải trả|ưu đãi|tong|phi giao hang|phi ban hang|subtotal|total|delivery fee|gesamt|zwischensumme|liefergebühr|lieferkosten|verkaufsgebühr|bar zu zahlen|rabatt)/i,
      /^\(?\d+[,.]\d{2}\s*[€$]/, // dòng giá tiền: "55,10 €" hoặc "(5,90 €)"
    ];
    const cleanOrderNoteLine = line => nt(line)
      .replace(/^[-•\u2022\s]+/, '')
      .replace(/^["\u201c\u201e\u201d"]|["\u201c\u201e\u201d"]$/g, '')
      .trim();
    const isSkippedOrderNoteLine = line => {
      if (!line || isOrderPriceLine(line) || isMoneyOnlyOrderLine(line)) return true;
      return SKIP_PATTERNS.some(re => {
        try { return re.test(line) || re.test(nct(line)); } catch (_) { return false; }
      });
    };

    // UberEats order-level note is usually quoted in the blue note bubble.
    // Pick it before generic text badges like "Khách hàng thường xuyên (6 đơn hàng)".
    for (let i = headerIdx + 1; i < itemsStartIdx; i++) {
      const line = lines[i];
      if (!/^[-•\u2022\s]*["\u201c\u201e\u201d"]/.test(line)) continue;
      if (isSkippedOrderNoteLine(line)) continue;
      const note = cleanOrderNoteLine(line);
      if (note.length >= 1) return note;
    }

    for (let i = headerIdx + 1; i < itemsStartIdx; i++) {
      const line = lines[i];
      if (!line || line.length < 1 || line.length > 300) continue;
      if (isSkippedOrderNoteLine(line)) continue;
      // Dòng có dấu ngoặc kép ở đầu → bỏ quotes rồi trả về
      if (/^["\u201c\u201e\u201d"]/.test(line)) {
        return cleanOrderNoteLine(line);
      }
      // Label "ghi chú:" → dòng tiếp
      if (/^(ghi chú|note|anmerkung|hinweis)\s*:?\s*$/i.test(line)) {
        return cleanOrderNoteLine(lines[i + 1] || '');
      }
      // Fallback: chỉ lấy dòng text thuần khi đủ dài (tránh lấy từ đơn lẻ chưa lọc được)
      if (line.length >= 3) {
        return cleanOrderNoteLine(line);
      }
    }
    return '';
  }

  /** Đọc yêu cầu dao nĩa (cutlery): tìm chữ "Có" / "Không" gần icon 🍴 hoặc "mặt hàng" */
  function readCutlery(modal) {
    const roots = [modal, document.body].filter(Boolean);
    for (const root of roots) {
      const lines = (root.innerText || '').split('\n').map(nt).filter(Boolean);

      for (let i = 0; i < lines.length; i++) {
        const marker = nct(lines[i]);
        if (!/besteck|cutlery|utensils?|dao nia/.test(marker) && !/🍴/.test(lines[i])) continue;
        const nearby = lines.slice(i, Math.min(i + 4, lines.length)).map(nct);
        const joined = nearby.join(' ');
        if (/kein besteck|ohne besteck|besteck.*nein|cutlery.*no|utensils?.*no/.test(joined) || nearby.includes('khong') || nearby.includes('nein') || nearby.includes('no')) return 'Không';
        if (/mit besteck|besteck.*gewunscht|besteck.*ja|cutlery.*yes|utensils?.*yes/.test(joined) || nearby.includes('co') || nearby.includes('ja') || nearby.includes('yes')) return 'Có';
      }

      for (let i = 0; i < lines.length; i++) {
        if (!hasOrderItemsHeader(lines[i])) continue;
        const nearby = lines.slice(i + 1, Math.min(i + 6, lines.length)).map(nct);
        if (nearby.includes('khong') || nearby.includes('nein') || nearby.includes('no')) return 'Không';
        if (nearby.includes('co') || nearby.includes('ja') || nearby.includes('yes')) return 'Có';
      }
    }
    return '';
  }

  // ── Dialog "Chi tiết giao hàng" ────────────────────────────────────────────

  function findXemChiTietBtn() {
    return findByText('xem chi tiết',  'button,a,[role="button"]')
        || findByText('view details',   'button,a,[role="button"]')
        || findByText('see details',    'button,a,[role="button"]')
        || findByText('details anzeigen', 'button,a,[role="button"]')
        || findByText('details ansehen',  'button,a,[role="button"]')
        || findByText('lieferdetails',    'button,a,[role="button"]');
  }

  function findDeliveryDialog() {
    // Dialog "Chi tiết giao hàng" xuất hiện sau khi click "Xem chi tiết"
    // Dấu hiệu chắc chắn: chứa "chi tiết giao hàng" HOAC có nút "Hoàn tất/Done/Close"
    // KHÔNG dùng SĐT địn thuần vì modal chính cũng có SĐT
    const all = [...document.querySelectorAll('[role="dialog"],dialog,div,section,aside')].filter(isVisible);
    const hasPhoneText = text => /\+\d[\d\s\-\/]{7,}/.test(String(text || ''));
    const hasAddressText = text => /\d{5}\s+\S/.test(String(text || ''));

    // Ưu tiên 1: vùng có tiêu đề và dữ liệu thật. Tránh lấy div chỉ chứa
    // riêng heading "Chi tiết giao hàng" trước khi nội dung render xong.
    const byLabel = all
      .filter(el => /chi tiết giao hàng|delivery details|lieferdetails|lieferinformationen/i.test(el.innerText || ''))
      .sort((a, b) => {
        const score = (el) => {
          const text = el.innerText || '';
          let value = 0;
          if (hasAddressText(text)) value += 200;
          if (hasPhoneText(text)) value += 100;
          if (/hoan tat|done|close|fertig|schlie(?:ss|ß)en/.test(nct(text))) value += 40;
          value += Math.min(30, text.split('\n').filter(Boolean).length);
          return value;
        };
        return score(b) - score(a);
      });
    if (byLabel.length) return byLabel[0];

    // Ưu tiên 2: element có nút "Hoàn tất" và SĐT
    const withDone = all.find(el => {
      const t = el.innerText || '';
      return /hoan tat|done|close|fertig|schlie(?:ss|ß)en/.test(nct(t)) && hasPhoneText(t);
    });
    if (withDone) return withDone;

    // Fallback: element có SĐT + địa chỉ (đường phố + mã bưu chính) mà không phải modal chính
    const mainModal = findOrderModal();
    const withPhone = all.filter(el => {
      if (el === mainModal || (mainModal && mainModal.contains(el) && el !== mainModal)) return false;
      const t = el.innerText || '';
      return hasPhoneText(t) && hasAddressText(t); // SĐT + zip + city
    });
    if (withPhone.length) {
      withPhone.sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (ra.width * ra.height) - (rb.width * rb.height);
      });
      return withPhone[0];
    }
    return null;
  }

  /** Đọc địa chỉ + SĐT + tầng + ghi chú giao hàng từ dialog "Chi tiết giao hàng" */
  function readDeliveryDetails(dialog, options) {
    const root = dialog || document;
    const allowUnlabeledAddressInfo = !!(options && options.allowUnlabeledAddressInfo);
    const lines = (root.innerText || root.textContent || '').split('\n').map(nt).filter(Boolean);
    let address = '', phone = '', floor = '', doorNote = '', firma = '', hotel = '', codeHaus = '', nameNummer = '', additionalAddressInfo = '';
    const stripCountrySuffix = (text) => nt(text).replace(/,?\s*(Deutschland|Germany|Allemagne)\s*$/i, '').trim();
    const isDialogActionLine = text => /hoan tat|done|close|fertig|schlie(?:ss|ß)en/.test(nct(text));
    const isOrderActionLine = text => /dieu chinh don hang|bestellung anpassen|adjust order|chap nhan|accept|annehmen|da san sang|bereit|bat dau giao hang|lieferung starten|lieferung beginnen|auslieferung starten|auslieferung beginnen|start delivery/.test(nct(text));
    const isFloorValue = text => /(\d+\s*\.?\s*(?:etage|stock|stockwerk|floor|tang)|(?:etage|stock|stockwerk|floor|tang)\s*\d+|eg|erdgeschoss|ground floor)/i.test(nct(text));
    const hasStreetToken = (text) => /(straße|strasse|str\.|str\b|gasse|weg|allee|platz|ring|damm|chaussee|ufer|markt|hof|promenade)/i.test(`${nt(text)} ${nct(text)}`);
    const isHotelLabelLine = (text) => /^(?:ten khach san|hotel(?:\s*name)?|name des hotels?)\s*(?::|$)/i.test(nct(text));
    const isAddressMetaLine = (text) => {
      const t = nct(text);
      if (isHotelLabelLine(text)) return true;
      return /chi tiet giao hang|lieferdetails|lieferinformationen|xem chi tiet|view details|see details|details ansehen|details anzeigen|hoan tat|done|close|fertig|schlie(?:ss|ß)en|giao hang tan cua|giao o ben ngoai|de o cua|liefern an die tur|an die haustur liefern|an der tur abgeben|vor der tur abstellen|draussen treffen|leave at door|leave outside|meet outside|so nha hoac ten|house number or name|hausnummer oder name|hausnummer oder gebaudename|nummer oder name|thong tin dia chi bo sung|dia chi bo sung|additional address|address additional|adresszusatz|zusatzadresse|zusatzliche adress|zusatzliche information|erganzende adress|ten cong ty|ten toa nha|firmenname|unternehmensname|gebaude|company|building|ma tham gia|zugangscode|hauscode|turcode|klingelcode|floor|apartment|wohnung|zimmer|etage|stockwerk|can ho|buong|tang/.test(t);
    };
    const comparableKey = text => nct(text).replace(/[^a-z0-9]+/g, '');
    const isUnlabeledAddressInfo = (text, fullAddress) => {
      const value = nt(text);
      if (!value || value.length > 120) return false;
      if (/\+\d|\d{5}/.test(value)) return false;
      if (isDialogActionLine(value) || isOrderActionLine(value) || isAddressMetaLine(value) || isFloorValue(value)) return false;
      if (/^(?:deutschland|germany|allemagne)$/i.test(value)) return false;
      if (hasStreetToken(value)) return false;
      const valueKey = comparableKey(value);
      const addressKey = comparableKey(stripCountrySuffix(fullAddress));
      if (!valueKey || (addressKey && addressKey.includes(valueKey))) return false;
      return /[a-zA-ZÀ-ÿ]/.test(value);
    };
    let zipAddressFallback = '';
    let unlabeledAddressInfo = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNct = nct(line);

      // SĐT: "DE +49 175 1559898" hoặc "+49..."
      const mPhone = line.match(/(?:DE\s+)?(\+\d[\d\s\-\/]{7,})/);
      if (mPhone) { phone = nt(mPhone[1]).replace(/\s+/g, ''); continue; }

      // Số nhà hoặc tên: "số nhà hoặc tên: thai"
      if (!nameNummer && /so nha hoac ten|hausnummer oder name|hausnummer oder gebaudename|house number or name|nummer oder name/i.test(lineNct)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx >= 0) {
          const val = nt(line.slice(colonIdx + 1));
          if (val) { nameNummer = val; continue; }
          const next = lines[i + 1] || '';
          if (next && !/\+\d/.test(next) && !/\d{5}/.test(next) && !isDialogActionLine(next)) {
            nameNummer = nt(next); i++;
          }
        }
        continue;
      }

      // Thông tin địa chỉ bổ sung: có thể nằm cùng dòng hoặc bị tách dòng do giao diện hẹp.
      if (!additionalAddressInfo && /thong tin dia chi bo sung|additional address(?: information| details)?|address additional|adresszusatz|zusatzadresse|zusatzliche adress(?:informationen|angaben)?|zusatzliche informationen?|erganzende adress(?:informationen|angaben)?/i.test(lineNct)) {
        const colonIdx = line.indexOf(':');
        let value = colonIdx >= 0 ? nt(line.slice(colonIdx + 1)) : '';
        const next = lines[i + 1] || '';
        const nextNct = nct(next);
        const canAppendNext = next
          && !/\+\d/.test(next)
          && !isAddressMetaLine(next)
          && !isDialogActionLine(next)
          && (!value || /[,/]$/.test(value) || /^\d{5}\b/.test(next));
        if (canAppendNext) {
          value = nt(`${value} ${next}`);
          i++;
        }
        if (value) additionalAddressInfo = value;
        continue;
      }

      // Mã tham gia (code haus): "Mã tham gia: 123456"
      if (!codeHaus && /ma tham gia|zugangscode|hauscode|turcode|klingelcode|code (haus|door|building)/i.test(lineNct)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx >= 0) {
          const val = nt(line.slice(colonIdx + 1));
          if (val) { codeHaus = val; continue; }
          const next = lines[i + 1] || '';
          if (next && !/\+\d/.test(next) && !/\d{5}/.test(next) && !isDialogActionLine(next)) {
            codeHaus = nt(next); i++;
          }
        }
        continue;
      }

      // Tên khách sạn: "Tên khách sạn: sao mai"
      if (!hotel && isHotelLabelLine(line)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx >= 0) {
          const val = nt(line.slice(colonIdx + 1));
          if (val) { hotel = val; continue; }
          const next = lines[i + 1] || '';
          if (next && !/\+\d/.test(next) && !/\d{5}/.test(next) && !isDialogActionLine(next)) {
            hotel = nt(next); i++;
          }
        }
        continue;
      }

      // Tên công ty / tên tòa nhà: "Tên công ty hoặc tên tòa nhà: Acme GmbH"
      if (!firma && /ten cong ty|ten toa nha|company|building name|firmenname|unternehmensname|gebaude/i.test(lineNct)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx >= 0) {
          const val = nt(line.slice(colonIdx + 1));
          if (val) { firma = val; continue; }
          // Giá trị có thể nằm trên dòng tiếp
          const next = lines[i + 1] || '';
          if (next && !/\+\d/.test(next) && !/\d{5}/.test(next) && !isDialogActionLine(next)) {
            firma = nt(next); i++;
          }
        }
        continue;
      }

      // Tầng/Căn hộ: "Căn hộ / Buồng / Tầng: etage 2"
      if (!floor && /can ho|buong|tang|apartment|floor|wohnung|zimmer|etage|stockwerk/i.test(lineNct)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx >= 0) {
          const val = nt(line.slice(colonIdx + 1));
          if (val) { floor = val; continue; }
        }
        const next = lines[i + 1] || '';
        if (next && isFloorValue(next) && !/\+\d/.test(next) && !/\d{5}/.test(next) && !isDialogActionLine(next) && !isOrderActionLine(next)) {
          floor = nt(next);
          i++;
        }
        continue;
      }

      // Ghi chú cửa: dòng sau label giao hàng bất kỳ
      // "Giao hàng tận cửa", "Giao ở bên ngoài", "Để ở cửa", "Liefern an die Tür", "Außen lassen", v.v.
      if (!doorNote && /giao hang tan cua|giao o ben ngoai|de o cua|liefern an die tur|an der tur abgeben|vor der tur abstellen|draussen treffen|au.en lassen|leave at door|leave outside|meet outside/i.test(lineNct)) {
        if (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next && !/\+\d/.test(next) && !/\d{5}/.test(next) && !isDialogActionLine(next) && !isOrderActionLine(next) && !isAddressMetaLine(next)) {
            doorNote = next;
            i++;
          }
        }
        continue;
      }

      // Địa chỉ đầy đủ: có mã bưu chính 5 chữ số
      // Ví dụ: "Leipziger Ch 147, 06112 Halle (Saale), Deutschland"
      // Loại trừ dòng header "Tên khách • MãĐơn" (chứa dấu •) — không phải địa chỉ
      if (/\d{5}/.test(line) && line.length > 10 && line.length < 250
          && !/\s*•\s*/.test(line)
          && !isAddressMetaLine(line)) {
        const candidate = stripCountrySuffix(line);
        if (!zipAddressFallback) zipAddressFallback = candidate;
        if (hasStreetToken(candidate) || /,\s*\d{5}\s+/.test(candidate)) {
          if (!address) address = candidate;
          const next = lines[i + 1] || '';
          if (allowUnlabeledAddressInfo && !unlabeledAddressInfo && isUnlabeledAddressInfo(next, candidate)) {
            unlabeledAddressInfo = nt(next);
          }
        }
        continue;
      }
    }

    // Nếu địa chỉ chưa lấy được từ 1 dòng, thử ghép "Tên đường" + "Thành phố"
    if (!address) {
      for (let i = 0; i < lines.length; i++) {
        if (isAddressMetaLine(lines[i])) continue;
        if (/\d+[a-zA-Z]?$/.test(lines[i]) && lines[i].length < 80 && (hasStreetToken(lines[i]) || /[,/]/.test(lines[i]))) {
          const next = lines[i + 1] || '';
          if (/\d{5}/.test(next) && !isAddressMetaLine(next)) {
            address = `${lines[i]}, ${next}`.replace(/,?\s*(Deutschland|Germany)\s*$/i, '').trim();
            break;
          }
        }
      }
    }

    // Case dac biet UberEats:
    // Dong 1: "06184 Kabelsketal, Deutschland"
    // Dong 2: "Grobers, Industriestr./Sud"
    // => combine lai de parser admin nhan du "street line" day du.
    for (let i = 0; i < lines.length; i++) {
      const zipCityLine = stripCountrySuffix(lines[i]);
      if (!/^\d{5}\s+.+/.test(zipCityLine)) continue;
      const next = stripCountrySuffix(lines[i + 1] || '');
      const nextNct = nct(next);
      if (!next) continue;
      if (/^\d{5}\s+.+/.test(next)) continue;
      if (isAddressMetaLine(next)) continue;
      if (!/[,/]/.test(next) && !/\bstr\b|\bstr\.\b|\bstrasse\b|\ballee\b|\bweg\b|\bgasse\b|\bplatz\b/.test(nextNct)) continue;
      address = `${next}, ${zipCityLine}`.replace(/\s+,/g, ',').trim();
      break;
    }

    if (!address && zipAddressFallback) address = zipAddressFallback;

    // Uber can render an unlabeled landmark/building directly below the full
    // address (for example "Sparkassen-Eisdom"). Keep it as additional address
    // information, unless a labeled hotel/company field already represents it.
    if (!additionalAddressInfo && unlabeledAddressInfo) {
      const candidateKey = comparableKey(unlabeledAddressInfo);
      const representedElsewhere = [hotel, firma, nameNummer]
        .map(comparableKey)
        .filter(Boolean)
        .some(key => key === candidateKey || key.includes(candidateKey) || candidateKey.includes(key));
      if (!representedElsewhere) additionalAddressInfo = unlabeledAddressInfo;
    }

    return {
      address: nt(address),
      phone: nt(phone),
      floor: nt(floor),
      doorNote: nt(doorNote),
      firma: nt(firma),
      hotel: nt(hotel),
      codeHaus: nt(codeHaus),
      nameNummer: nt(nameNummer),
      additionalAddressInfo: nt(additionalAddressInfo),
    };
  }

  function findHoanTatBtn(dialog) {
    const root = dialog || document;
    return findByText('hoàn tất', 'button,[role="button"]', root)
        || findByText('done',     'button,[role="button"]', root)
        || findByText('close',    'button,[role="button"]', root)
        || findByText('fertig',   'button,[role="button"]', root)
        || findByText('schließen','button,[role="button"]', root);
  }

  function findDaSanSangBtn() {
    return findByText('đã sẵn sàng', 'button,[role="button"]')
        || findByText('ready',        'button,[role="button"]')
        || findByText('mark as ready','button,[role="button"]')
        || findByText('als bereit markieren', 'button,[role="button"]')
        || findByText('bereit', 'button,[role="button"]');
  }

  function findDanhDauDaSanSangBtn() {
    // Nút xác nhận trong dialog: "Đánh dấu là đã sẵn sàng"
    return findByText('đánh dấu là đã sẵn sàng', 'button,[role="button"]')
        || findByText('đánh dấu đã sẵn sàng',    'button,[role="button"]')
        || findByText('mark as ready',            'button,[role="button"]')
        || findByText('als bereit markieren',     'button,[role="button"]');
  }

  function findChapNhanBtn() {
    return findByText('chấp nhận', 'button,[role="button"]')
        || findByText('accept',       'button,[role="button"]')
        || findByText('annehmen',     'button,[role="button"]');
  }

  function findBatDauGiaoHangBtn() {
    return findByText('bắt đầu giao hàng', 'button,[role="button"]')
        || findByText('start delivery',    'button,[role="button"]')
        || findByText('lieferung starten', 'button,[role="button"]')
        || findByText('lieferung beginnen', 'button,[role="button"]')
        || findByText('auslieferung starten', 'button,[role="button"]')
        || findByText('auslieferung beginnen', 'button,[role="button"]');
  }

  function findCloseOrderModalBtn(modalRoot) {
    // Nút ✕ bên trái tên khách hàng — đóng modal đơn hàng (hỗ trợ đa ngôn ngữ Đức/Việt/Anh, SVG, testId)
    const modal = modalRoot || findOrderModal() || document;
    const candidates = [...modal.querySelectorAll('button,[role="button"],a,div[tabindex="0"]')].filter(isVisible);

    // 1. Khớp theo aria-label hoặc title (Đức: Schließen/Dialog schließen, Việt: Đóng, Anh: Close)
    for (const btn of candidates) {
      const label = nct(btn.getAttribute('aria-label') || btn.getAttribute('title') || '');
      if (/close|dong|thoat|schliessen|schlie|abbrechen|dismiss|zuruck|back/.test(label)) return btn;
    }

    // 2. Khớp theo data-testid hoặc data-tracking-name
    for (const btn of candidates) {
      const testId = (btn.getAttribute('data-testid') || btn.getAttribute('data-tracking-name') || '').toLowerCase();
      if (/close|dismiss|back|modal-close|dialog-close/.test(testId)) return btn;
    }

    // 3. Khớp theo text trực tiếp (các biến thể ký tự dấu X)
    for (const btn of candidates) {
      const txt = (btn.textContent || '').trim();
      if (/^[×✕✖✗⨯xX\u00d7\u2715\u2716\u2573]$/.test(txt)) return btn;
    }

    // 4. Khớp theo icon SVG con bên trong nút
    for (const btn of candidates) {
      const svgs = btn.querySelectorAll('svg');
      for (const svg of svgs) {
        const name = (svg.getAttribute('data-name') || svg.getAttribute('name') || svg.getAttribute('aria-label') || '').toLowerCase();
        if (/cross|close|x|schliessen|cancel/.test(name)) return btn;
      }
    }

    // 5. Header context fallback: Nút vuông nhỏ ở phần đầu modal (bên cạnh hoặc trước tên khách)
    if (modal && modal !== document) {
      const headerBtns = [...modal.querySelectorAll('button,[role="button"]')].filter(isVisible);
      for (const b of headerBtns) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.width <= 60 && r.height > 0 && r.height <= 60) {
          const txt = (b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '');
          if (!/print|in|druck/i.test(txt)) {
            return b;
          }
        }
      }
    }

    return null;
  }

  /** Đóng modal đơn hàng an toàn với nhiều cơ chế fallback: Click X → Escape Key → Click Backdrop */
  async function dismissOrderModal(maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!findOrderModal()) return true;

      // 1. Thử click nút X
      const closeBtn = findCloseOrderModalBtn();
      if (closeBtn) {
        clickEl(closeBtn);
        hardClick(closeBtn);
        await sleep(350);
        if (!findOrderModal()) return true;
      }

      // 2. Thử gửi phím Escape
      try {
        const modal = findOrderModal();
        const targets = [modal, document.activeElement, document.body, window].filter(Boolean);
        for (const target of targets) {
          target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
        }
      } catch (_) {}
      await sleep(350);
      if (!findOrderModal()) return true;

      // 3. Thử click Backdrop/Overlay
      try {
        const backdrops = [...document.querySelectorAll('[data-baseweb="backdrop"], div[class*="backdrop"], div[class*="overlay"], div[class*="Backdrop"]')]
          .filter(isVisible);
        for (const bd of backdrops) {
          clickEl(bd);
          hardClick(bd);
        }
      } catch (_) {}
      await sleep(400);
      if (!findOrderModal()) return true;
    }

    return !findOrderModal();
  }

  // ── Parse địa chỉ Đức ─────────────────────────────────────────────────────

  function parseGermanAddress(raw) {
    const text = nt(raw);
    if (!text) return { zip: '', city: '', street: '', houseNumber: '' };
    let m = text.match(/^(.+?)\s*,\s*(\d{5})\s+(.+)$/);
    if (m) {
      const s = parseStreet(nt(m[1]));
      return { zip: m[2], city: nt(m[3].replace(/[()]/g, '').split(',')[0]), ...s };
    }
    m = text.match(/^(\d{5})\s+([^,]+),\s*(.+)$/);
    if (m) {
      const s = parseStreet(nt(m[3]));
      return { zip: m[1], city: nt(m[2]), ...s };
    }
    return { zip: '', city: '', ...parseStreet(text) };
  }

  function parseStreet(raw) {
    const m = raw.match(/^(.*?)\s+(\d+\s*[a-zA-Z\-\/]*)$/);
    if (m) return { street: nt(m[1]), houseNumber: nt(m[2]) };
    return { street: raw, houseNumber: '' };
  }

  // ── Build payload ─────────────────────────────────────────────────────────

  function buildPayload({ customerName, orderCode, phone, address, items,
                          paymentMethod, subtotal, deliveryFee, total, deliveryTime, customerNote, cutlery, postItemsNote = '',
                          floor = '', doorNote = '', firma = '', hotel = '', codeHaus = '', nameNummer = '', additionalAddressInfo = '' }) {
    return {
      source:           'merchants-beta.ubereats.com',
      capturedAt:       new Date().toISOString(),
      orderCode:        nt(orderCode),
      customerName:     nt(customerName),
      phone:            nt(phone),
      address:          nt(address),
      floor:            nt(floor),
      doorNote:         nt(doorNote),
      firma:            nt(firma),
      hotel:            nt(hotel),
      codeHaus:         nt(codeHaus),
      nameNummer:       nt(nameNummer),
      additionalAddressInfo: nt(additionalAddressInfo),
      confirmationCode: '',
      paymentMethod,
      deliveryTime:     nt(deliveryTime),
      acceptedAt:       '',
      customerNote:     nt(customerNote),
      postItemsNote:    nt(postItemsNote),
      cutlery:          nt(cutlery || ''),
      subtotal:         nt(subtotal),
      deliveryFee:      nt(deliveryFee),
      total:            nt(total),
      items,
    };
  }

  // ── Panel UI ──────────────────────────────────────────────────────────────

  function formatItem(it) {
    let code = nt(it?.code || '').replace(/\.$/, '');
    // Bỏ tên món sau số thứ tự: "18. Seetang Salat" → "18", "Bowl 10. Lachs Bowl" → "Bowl 10"
    code = code.replace(/(\d+)\.\s+.+$/, '$1');
    const note = nt(it?.note || '');
    if (!code) return '';
    return note ? `${it.qty} x ${code}  :  ${note}` : `${it.qty} x ${code}`;
  }

  function buildText(p) {
    return [
      `Name: ${p.customerName || ''}`,
      `Phone: ${p.phone || ''}`,
      `Address: ${p.address || ''}`,
      `House number/name: ${p.nameNummer || ''}`,
      `Additional address info: ${p.additionalAddressInfo || ''}`,
      `Order code: ${p.orderCode || ''}`,
      `Payment: ${p.paymentMethod || ''}`,
      `Delivery time: ${p.deliveryTime || ''}`,
      `Note: ${p.customerNote || ''}`,
      `Subtotal: ${p.subtotal || ''}`,
      `Delivery fee: ${p.deliveryFee || ''}`,
      `Total: ${p.total || ''}`,
      '', 'Items:',
      (p.items || []).map(formatItem).filter(Boolean).join(' + '),
    ].join('\n');
  }

  const CONTROLS_ID = 'ubereats-controls-dock';

  function getControlsDock() {
    let dock = document.getElementById(CONTROLS_ID);
    if (dock) return dock;
    dock = document.createElement('div');
    dock.id = CONTROLS_ID;
    dock.title = 'Bấm giữ chuột vào khoảng trắng để kéo di chuyển panel';
    Object.assign(dock.style, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      zIndex: '10000000',
      display: 'flex',
      justifyContent: 'flex-end',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '10px',
      maxWidth: 'calc(100vw - 36px)',
      padding: '7px 11px',
      background: '#fff',
      border: '1px solid #d8e1ea',
      borderRadius: '12px',
      boxShadow: '0 8px 28px rgba(0,0,0,.24)',
      cursor: 'grab',
      userSelect: 'none',
      touchAction: 'none',
      pointerEvents: 'auto',
    });
    document.body.appendChild(dock);

    // Kéo thả panel tự do trên màn hình
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    dock.addEventListener('mousedown', function (e) {
      if (e.target.tagName === 'BUTTON' || (e.target.closest && e.target.closest('button'))) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = dock.getBoundingClientRect();
      initialLeft = rect.left;
      initialTop = rect.top;
      dock.style.bottom = 'auto';
      dock.style.right = 'auto';
      dock.style.left = initialLeft + 'px';
      dock.style.top = initialTop + 'px';
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newLeft = Math.max(8, Math.min(window.innerWidth - dock.offsetWidth - 8, initialLeft + dx));
      const newTop = Math.max(8, Math.min(window.innerHeight - dock.offsetHeight - 8, initialTop + dy));
      dock.style.left = newLeft + 'px';
      dock.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', function () {
      isDragging = false;
    });

    return dock;
  }

  function layoutBridgePanel() {
    const panel = document.getElementById('ubereats-bridge-panel');
    if (!panel) return;
    const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight || 1);
    const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth || 1);
    const width = Math.max(160, Math.min(320, viewportWidth - 24));
    panel.style.top = 'auto';
    panel.style.bottom = '75px';
    panel.style.right = '18px';
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.min(440, Math.max(120, Math.round(viewportHeight * 0.48)))}px`;
  }

  if (!window.__thaiasiaUberPanelLayoutInstalled) {
    window.__thaiasiaUberPanelLayoutInstalled = true;
    window.addEventListener('resize', () => requestAnimationFrame(layoutBridgePanel));
  }

  function showPanel(payload, statusMsg) {
    const PANEL_ID = 'ubereats-bridge-panel';
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      Object.assign(panel.style, {
        position:'fixed', right:'18px', bottom:'75px', top:'auto', width:'320px',
        maxHeight:'min(440px, 48vh)', overflow:'auto', zIndex:'9999999',
        boxSizing:'border-box',
        background:'#fff', color:'#222', border:'2px solid #06C167',
        borderRadius:'12px', padding:'10px 12px', boxShadow:'0 8px 28px rgba(0,0,0,.22)',
        fontFamily:'system-ui,-apple-system,Arial,sans-serif',
      });
      document.body.appendChild(panel);
    }

    const safe  = payload || {};
    const items = (safe.items || []).map((it, i) => {
      const line = formatItem(it);
      return line ? `<div>${i+1}. ${eh(line)}</div>` : '';
    }).join('');

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span style="font-weight:700;font-size:13px;color:#06C167;">🟢 UberEats → ThaiAsia</span>
        <button id="ub-close" style="border:none;background:#eee;border-radius:5px;padding:2px 7px;cursor:pointer;font-weight:700;font-size:12px;">×</button>
      </div>
      ${statusMsg ? `<div style="background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;padding:5px 8px;margin-bottom:6px;font-size:11px;line-height:1.4;">${eh(statusMsg)}</div>` : ''}
      <div style="font-size:11.5px;line-height:1.45;display:grid;grid-template-columns:1fr;gap:2px;">
        <div><b>Name:</b> ${eh(safe.customerName||'—')}</div>
        <div><b>Tel:</b> ${eh(safe.phone||'—')}</div>
        <div><b>Adresse:</b> ${eh(safe.address||'—')}</div>
        ${safe.nameNummer ? `<div><b>Hausnr/Name:</b> ${eh(safe.nameNummer)}</div>` : ''}
        ${safe.additionalAddressInfo ? `<div><b>Zusatz:</b> ${eh(safe.additionalAddressInfo)}</div>` : ''}
        <div><b>Code:</b> ${eh(safe.orderCode||'—')}</div>
        <div><b>Zahlung:</b> ${eh(safe.paymentMethod||'—')} | <b>Zeit:</b> ${eh(safe.deliveryTime||'—')}</div>
        ${safe.customerNote ? `<div><b>Note:</b> ${eh(safe.customerNote)}</div>` : ''}
        ${safe.cutlery ? `<div><b>Dao nĩa:</b> ${eh(safe.cutlery)}</div>` : ''}
        <div><b>Total:</b> <span style="font-weight:700;color:#06C167;">${eh(safe.total||'—')}</span></div>
      </div>
      <div style="margin:6px 0 2px;font-weight:700;font-size:11.5px;">Artikel</div>
      <div style="max-height:85px;overflow:auto;border:1px solid #eee;padding:5px 7px;border-radius:6px;font-size:11px;background:#f9f9f9;line-height:1.35;">
        ${items || '<span style="color:#aaa">Keine Artikel</span>'}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        <button id="ub-send" style="border:none;background:#06C167;color:#fff;border-radius:6px;padding:6px 11px;font-weight:700;cursor:pointer;font-size:11.5px;">📤 Gửi sang Admin</button>
        <button id="ub-copy" style="border:none;background:#555;color:#fff;border-radius:6px;padding:6px 9px;font-weight:700;cursor:pointer;font-size:11.5px;">Copy</button>
        <button id="ub-clear" style="border:none;background:#999;color:#fff;border-radius:6px;padding:6px 9px;font-weight:700;cursor:pointer;font-size:11.5px;">Xóa</button>
      </div>
      <div style="font-size:9.5px;color:#aaa;margin-top:4px;text-align:right;">Admin tự điền form</div>
    `;
    requestAnimationFrame(layoutBridgePanel);

    document.getElementById('ub-close')?.addEventListener('click', () => panel.remove());

    document.getElementById('ub-send')?.addEventListener('click', async () => {
      if (!safe.customerName && !safe.address && !(safe.items||[]).length) {
        alert('Chưa có dữ liệu đơn.'); return;
      }
      const storageKey = await savePayload(safe, { autoSubmit: false });
      try { GM_openInTab(THAIASIA_URL, { storageKey, show: true, active: true }); } catch (_) { window.open(THAIASIA_URL, '_blank'); }
    });

    document.getElementById('ub-copy')?.addEventListener('click', () => {
      try { GM_setClipboard(buildText(safe)); } catch (_) {}
    });

    document.getElementById('ub-clear')?.addEventListener('click', () => {
      panel.remove();
    });

    return panel;
  }

  function updateStatus(msg) {
    const panel = document.getElementById('ubereats-bridge-panel');
    if (!panel) return;
    let el = panel.querySelector('#ub-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ub-status';
      el.style.cssText = 'background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;padding:6px 10px;margin-bottom:8px;font-size:12px;';
      panel.insertBefore(el, panel.children[1]);
    }
    el.textContent = msg;
  }

  // ── Luồng chính ───────────────────────────────────────────────────────────

  async function captureOrder(cardEl, queueMeta) {
    if (_state !== 'idle') return;
    setBridgeState('working'); _stateTs = Date.now();
    const captureStartedAt = Date.now();
    const queuedCodeHint = nt(queueMeta && queueMeta.code);
    const queuedCustomerNameHint = nt(queueMeta && queueMeta.customerName);
    const queuedAtHint = Number(queueMeta && queueMeta.queuedAt) || 0;
    const firstSeenHint = Number(queueMeta && queueMeta.firstSeenAt) || 0;
    let finalOrderCode = queuedCodeHint || '';
    let workflowCompleted = false;
    let completionStage = 'capture_started';
    let captureFailure = '';
    emitDiag('order_activity', {
      page: 'uberEatsWin',
      action: 'uber_capture_start',
      orderCode: queuedCodeHint,
      queueLength: _orderQueue.length,
      queueWaitMs: queuedAtHint > 0 ? Math.max(0, Date.now() - queuedAtHint) : null,
      detectToStartMs: firstSeenHint > 0 ? Math.max(0, Date.now() - firstSeenHint) : null,
      trigger: queueMeta ? (queueMeta.enqueueSource || 'queue') : 'manual'
    });

    try {
      showPanel({}, '⏳ Đang đọc thông tin đơn...');

      // Bước 0 (auto-mode): click thẻ đơn rồi chờ modal xuất hiện
      if (cardEl) { clickEl(cardEl); await sleep(800); }

      // Dismiss tooltip "Tôi đã hiểu" nếu UberEats đang hiện (có thể block click Xem chi tiết)
      try {
        const toiDaHieuBtn = findByText('tôi đã hiểu', 'button,[role="button"]')
                          || findByText('got it',       'button,[role="button"]')
                          || findByText('i understand', 'button,[role="button"]')
                          || findByText('verstanden',   'button,[role="button"]');
        if (toiDaHieuBtn) { clickEl(toiDaHieuBtn); await sleep(400); }
      } catch (_) {}

      // Bước 1: Đọc modal đang mở
      let modal;
      if (cardEl) {
        // Chờ items xuất hiện trong page (document.body), rồi tìm modal fresh
        // UberEats flex layout: qty/×/name có thể trên 3 dòng riêng → check cả \n×\n
        await waitFor(() => {
          const t = document.body.innerText || '';
          return /\d+\s*[x×]/i.test(t) || /\n×\n/.test(t) || /\n×[^\n]/.test(t);
        }, 8000, 200).catch(() => {});
        await sleep(300); // thêm buffer để React render xong
        modal = findOrderModal();
      } else {
        // Chờ tối đa 3s để DOM đơn load xong (khi gọi tự động không qua cardEl)
        await waitFor(() => {
          const tnct = nct(document.body.innerText || '');
          return hasOrderItemsText(tnct) && hasAcceptActionText(tnct);
        }, 3000, 200).catch(() => {});
        modal = findOrderModal();
        // Fallback: modal không tìm thấy nhưng trang đang hiện nội dung đơn hàng (sau khi app treo)
        if (!modal) {
          const bodyText = nt(document.body.innerText || '');
          const bodyNct = nct(bodyText);
          // Tín hiệu chắc chắn: có "mặt hàng" + "chấp nhận" → đơn đang mở
          if (hasOrderItemsText(bodyNct) && hasAcceptActionText(bodyNct)) {
            modal = document.body;
            dbg('[UberEats Bridge] Dùng document.body làm modal fallback (full-page order view)');
          }
        }
      }
      if (!modal) {
        showPanel({}, '⚠️ Hãy click vào thẻ đơn hàng để mở chi tiết trước.');
        return;
      }

      const header = readHeader(modal, queuedCodeHint);
      const customerName = queuedCustomerNameHint || nt(header.customerName);
      const orderCode = nt(header.orderCode || queuedCodeHint);
      finalOrderCode = nt(orderCode || finalOrderCode);
      if (finalOrderCode) rememberOrderSeen(finalOrderCode, 'capture_header');
      let items = readItems(modal);
      if (!items.length) {
        console.warn('[UberEats Bridge] readItems(modal) empty — bỏ qua document.body để tránh lấy nhầm lịch sử đơn');
      }
      const { paymentMethod, subtotal, deliveryFee, total } = readPayment(modal);
      const rawDeliveryTime = readDeliveryTime(modal);
      const scheduled      = isScheduledOrder(modal);
      const postItemsNote  = scheduled ? readFuturePreparationNote(modal) : '';
      // Đơn đặt trước: fill zeit = giờ dự kiến + 35 phút
      // Đơn xanh lá: luôn dùng ASAP → admin sẽ fill "schnell wie möglich"
      const deliveryTime    = scheduled
        ? (rawDeliveryTime ? addMinutesToTime(rawDeliveryTime, 35) : rawDeliveryTime)
        : 'ASAP';
      const customerNote  = readOrderNote(modal);
      const cutlery       = readCutlery(modal);

      dbg('[UberEats Bridge] Bước 1:', { customerName, orderCode, items, paymentMethod, total, scheduled, rawDeliveryTime, deliveryTime });

      // Uber often already shows the full address in the order summary. Keep it
      // as a fallback in case the delivery-details panel renders slowly.
      const summaryDetails = readDeliveryDetails(modal);
      let phone = summaryDetails.phone || '';
      let address = summaryDetails.address || '';
      let floor = summaryDetails.floor || '';
      let doorNote = summaryDetails.doorNote || '';
      let firma = summaryDetails.firma || '';
      let hotel = summaryDetails.hotel || '';
      let codeHaus = summaryDetails.codeHaus || '';
      let nameNummer = summaryDetails.nameNummer || '';
      let additionalAddressInfo = summaryDetails.additionalAddressInfo || '';
      let addressSource = address ? 'order_summary' : '';
      let deliveryDialogOpened = false;

      const mergeDeliveryDetails = (details) => {
        if (!details || typeof details !== 'object') return;
        phone = details.phone || phone;
        if (details.address) {
          address = details.address;
          addressSource = 'delivery_dialog';
        }
        floor = details.floor || floor;
        doorNote = details.doorNote || doorNote;
        firma = details.firma || firma;
        hotel = details.hotel || hotel;
        codeHaus = details.codeHaus || codeHaus;
        nameNummer = details.nameNummer || nameNummer;
        additionalAddressInfo = details.additionalAddressInfo || additionalAddressInfo;
      };

      showPanel({
        customerName, orderCode, items, paymentMethod, cutlery,
        subtotal, deliveryFee, total, deliveryTime, customerNote, postItemsNote, phone, address,
      }, '⏳ Click "Xem chi tiết" để lấy địa chỉ + SĐT...');

      // Bước 2: Click "Xem chi tiết"
      await sleep(300);
      const xemBtn = findXemChiTietBtn();
      if (!xemBtn) {
        showPanel({
          customerName, orderCode, items, paymentMethod, cutlery,
          subtotal, deliveryFee, total, deliveryTime, customerNote, postItemsNote, phone, address,
        }, address
          ? '✅ Đã lấy địa chỉ trực tiếp từ tóm tắt đơn.'
          : '⚠️ Không tìm thấy "Xem chi tiết" và chưa đọc được địa chỉ.');
        emitDiag('order_activity', {
          page: 'uberEatsWin',
          action: 'uber_delivery_details_unavailable',
          orderCode: nt(orderCode || ''),
          summaryAddressPresent: !!address
        });
      } else {
        clickEl(xemBtn);

        try {
          let dlg = await waitFor(findDeliveryDialog, 7000);
          deliveryDialogOpened = true;
          let details = null;
          // React can mount the dialog shell before its delivery data. Re-read a
          // few times instead of accepting an empty address on the first frame.
          for (let attempt = 0; attempt < 5; attempt++) {
            dlg = findDeliveryDialog() || dlg;
            details = readDeliveryDetails(dlg, { allowUnlabeledAddressInfo: true });
            mergeDeliveryDetails(details);
            // `address` may already come from the summary. Wait until the actual
            // delivery dialog has rendered contact data, plus a short extra pass
            // for landmarks/building names that React can paint slightly later.
            if (details.address && details.phone && (details.additionalAddressInfo || attempt >= 2)) break;
            await sleep(250);
          }
          dbg('[UberEats Bridge] Bước 2:', details);

          // Click "Hoàn tất" để đóng dialog
          const hoanTatBtn = findHoanTatBtn(dlg);
          if (hoanTatBtn) { clickEl(hoanTatBtn); await sleep(500); }
        } catch (e) {
          console.warn('[UberEats Bridge] Dialog không xuất hiện:', e.message);
          emitDiag('order_activity', {
            page: 'uberEatsWin',
            action: 'uber_delivery_dialog_failed',
            orderCode: nt(orderCode || ''),
            error: String((e && e.message) || e || '')
          });
        }
      }

      if (!address) {
        emitDiag('order_activity', {
          page: 'uberEatsWin',
          action: 'uber_delivery_address_missing',
          orderCode: nt(orderCode || ''),
          detailsButtonPresent: !!xemBtn,
          deliveryDialogOpened,
          summaryHasPostalCode: /\d{5}/.test(modal.innerText || modal.textContent || '')
        });
        throw new Error('Không đọc được địa chỉ giao hàng. Đã dừng gửi Admin và dừng tự động xử lý Uber để tránh tạo đơn thiếu địa chỉ.');
      }

      emitDiag('order_activity', {
        page: 'uberEatsWin',
        action: 'uber_delivery_details_captured',
        orderCode: nt(orderCode || ''),
        addressSource,
        phonePresent: !!phone,
        hotelPresent: !!hotel,
        additionalAddressPresent: !!additionalAddressInfo
      });
      completionStage = 'delivery_details_captured';

        // Bước 3: Build & save payload
        const payload = buildPayload({
          customerName, orderCode, phone, address, items,
          paymentMethod, subtotal, deliveryFee, total, deliveryTime, customerNote, cutlery, postItemsNote,
          floor, doorNote, firma, hotel, codeHaus, nameNummer, additionalAddressInfo,
        });

        const isManual = !queueMeta || queueMeta.enqueueSource === 'manual';
        const autoSubmit = !isManual;

        const storageKey = await savePayload(payload, { autoSubmit });
        if (orderCode) await markSent(orderCode);
        emitDiag('order_activity', {
          page: 'uberEatsWin',
          action: 'uber_payload_saved',
          orderCode: nt(orderCode || ''),
          itemCount: Array.isArray(items) ? items.length : 0,
          scheduled: !!scheduled,
          futurePreparationNoteIncluded: !!postItemsNote,
          futurePreparationNote: postItemsNote,
          trigger: isManual ? 'manual' : 'auto'
        });
        completionStage = 'payload_saved';
        try { GM_setClipboard(buildText(payload)); } catch (_) {}

        showPanel(payload, isManual ? '✅ Đã lấy đơn! Mở Admin nổi (chờ Submit).' : '✅ Đã lấy đơn! Đang tự động xử lý...');
        dbg('[UberEats Bridge] Payload:', payload);

        // Mở tab admin: nếu thủ công thì mở nổi (active: true, show: true), tự động thì mở ngầm
        try {
          GM_openInTab(THAIASIA_URL, {
            storageKey,
            show: isManual,
            active: isManual
          });
        } catch (_) {
          window.open(THAIASIA_URL, '_blank');
        }

        if (isManual) {
          dbg('[UberEats Bridge] Luồng THỦ CÔNG: Đã điền form Admin và mở nổi, dừng lại ở Submit để người dùng kiểm tra.');
          workflowCompleted = true;
          return;
        }

        // Bước 4: Click "Chấp nhận"
        await sleep(500);
        const chapNhanBtn = findChapNhanBtn();
        if (chapNhanBtn) {
          clickEl(chapNhanBtn);
          dbg('[UberEats Bridge] Đã bấm Chấp nhận');
          emitDiag('order_activity', {
            page: 'uberEatsWin',
            action: 'uber_accept_clicked',
            orderCode: nt(orderCode || '')
          });
          completionStage = 'accepted';
        }

        if (!scheduled) {
          // ── Đơn xanh lá: Đã sẵn sàng → Bắt đầu giao hàng ──
          await sleep(1500);
          try {
            const daSanSangBtn = await waitFor(findDaSanSangBtn, 10000);
            clickEl(daSanSangBtn);
            dbg('[UberEats Bridge] Đã bấm Đã sẵn sàng');
            emitDiag('order_activity', {
              page: 'uberEatsWin',
              action: 'uber_ready_clicked',
              orderCode: nt(orderCode || '')
            });
            completionStage = 'ready_clicked';
            await sleep(1200);
            // Xác nhận dialog: "Đánh dấu là đã sẵn sàng"
            try {
              const danhDauBtn = await waitFor(findDanhDauDaSanSangBtn, 5000);
              clickEl(danhDauBtn);
              dbg('[UberEats Bridge] Đã bấm Đánh dấu là đã sẵn sàng');
            } catch (_) { /* không có dialog xác nhận thì bỏ qua */ }
            await sleep(1500);
            const batDauBtn = await waitFor(findBatDauGiaoHangBtn, 10000);
            clickEl(batDauBtn);
            dbg('[UberEats Bridge] Đã bấm Bắt đầu giao hàng');
            emitDiag('order_activity', {
              page: 'uberEatsWin',
              action: 'uber_start_delivery_clicked',
              orderCode: nt(orderCode || '')
            });
            completionStage = 'start_delivery_clicked';
            workflowCompleted = true;
            await sleep(1200);
            // Đóng modal đơn (bấm dấu X + phím Esc + click backdrop)
            await dismissOrderModal(3);
            dbg('[UberEats Bridge] Đã đóng modal sau Bắt đầu giao hàng');
            // Quay về trang danh sách đơn (chỉ khi queue rỗng)
            safeNavigateToOverview();
          } catch (e) {
            console.warn('[UberEats Bridge] Không tìm được nút sau Chấp nhận:', e.message);
            const postAcceptError = String((e && e.message) || e || 'Không tìm thấy nút xử lý tiếp theo');
            emitDiag('order_activity', {
              page: 'uberEatsWin',
              action: 'uber_post_accept_failed',
              orderCode: nt(orderCode || ''),
              completionStage,
              error: postAcceptError
            });
            throw new Error(`Uber chưa hoàn tất sau khi chấp nhận đơn (${completionStage}): ${postAcceptError}`);
          }
        } else {
          // ── Đơn xanh nước biển: đánh dấu 24h + đóng modal ──
          await markAdminSent(orderCode);
          setTimeout(() => autoProcessed.delete(orderCode), 60000);
          dbg('[UberEats Bridge] Đơn đặt trước, đã markAdminSent:', orderCode);
          emitDiag('order_activity', {
            page: 'uberEatsWin',
            action: 'uber_scheduled_marked_admin_sent',
            orderCode: nt(orderCode || '')
          });
          completionStage = 'scheduled_marked_admin_sent';
          workflowCompleted = true;
          await sleep(800);
          try {
            await dismissOrderModal(3);
            dbg('[UberEats Bridge] Đã đóng modal đơn đặt trước');
            safeNavigateToOverview(); // chỉ navigate khi queue rỗng
          } catch (e) {
            console.warn('[UberEats Bridge] Không đóng được modal đơn đặt trước:', e.message);
          }
        }

        // (Tab admin đã mở ngay sau khi lấy payload ở trên)
    } catch (err) {
      captureFailure = String((err && err.message) || err || '');
      emitDiag('order_activity', {
        page: 'uberEatsWin',
        action: 'uber_capture_error',
        orderCode: finalOrderCode,
        error: captureFailure
      });
      console.error('[UberEats Bridge]', err);
      showPanel({}, `❌ Lỗi: ${err.message || String(err)}`);
    } finally {
      const nowTs = Date.now();
      emitDiag('order_activity', {
        page: 'uberEatsWin',
        action: workflowCompleted ? 'uber_capture_done' : 'uber_capture_incomplete',
        orderCode: finalOrderCode,
        completed: workflowCompleted,
        completionStage,
        error: captureFailure,
        durationMs: Math.max(0, nowTs - captureStartedAt),
        queueWaitMs: queuedAtHint > 0 ? Math.max(0, captureStartedAt - queuedAtHint) : null,
        detectToDoneMs: firstSeenHint > 0 ? Math.max(0, nowTs - firstSeenHint) : null
      });
      setBridgeState('idle');
      setTimeout(processNextQueued, 300); // xử lý đơn tiếp theo trong queue (nếu có)
    }
  }

  // ── Tìm thẻ đơn mới chưa xử lý ──────────────────────────────────────────────

  function findNewOrderCards() {
    const results = [];
    const seen = new Set();
    [...document.querySelectorAll('div,li,article')]
      .filter(isVisible)
      .filter(el => {
        const t = el.innerText || '';
        // Thẻ đơn UberEats: xanh lá = "Mới" + "mặt hàng", xanh nước biển = "Đã đặt trước" + "mặt hàng"
        // Cũng khớp khi thẻ hiển thị "Chấp nhận trong vòng N phút" (một dạng badge Mới khác)
        const normalizedText = nct(t);
        const hasNewOrderStatus = /\bmoi\b|\bnew\b|\bneu\b|dat truoc|scheduled|vorbestell|chap nhan trong vong|annehmen|innerhalb/i.test(normalizedText);
        return hasNewOrderStatus && !!readOrderCardCode(t);
      })
      // Ưu tiên node chứa ít text nhất, không dùng pixel nên độc lập mức zoom.
      .sort((a, b) => {
        const textDiff = nt(a.innerText || '').length - nt(b.innerText || '').length;
        if (textDiff) return textDiff;
        return a.querySelectorAll('*').length - b.querySelectorAll('*').length;
      })
      .forEach(el => {
        const code = readOrderCardCode(el.innerText || '');
        if (!code) return;
        if (autoProcessed.has(code) || seen.has(code)) return;
        seen.add(code);
        let cardRoot = el;
        let customerName = readOrderCardCustomerName(cardRoot.innerText || '', code);
        for (let depth = 0; !customerName && depth < 4 && cardRoot.parentElement; depth++) {
          const parent = cardRoot.parentElement;
          if (!isVisible(parent) || readOrderCardCode(parent.innerText || '') !== code) break;
          cardRoot = parent;
          customerName = readOrderCardCustomerName(cardRoot.innerText || '', code);
        }
        const clickable = el.closest('[role="button"],button,a') || el;
        results.push({ el: clickable, code, customerName });
      });
    return results;
  }

  // ── FIFO Queue: xử lý tuần tự khi 2 đơn vào cùng lúc ───────────────────────
  // Logic: peek phần tử đầu queue (không shift ngay) → sau await mới shift để tránh
  // 2 cuộc gọi đồng thời đều lấy cùng 1 đơn rồi gọi captureOrder 2 lần.

  /**
   * Chỉ navigate về orders/overview khi queue rỗng.
   * Nếu còn đơn trong queue → KHÔNG navigate (tránh full-page reload làm mất queue
   * và stale element). UberEats SPA tự trả về list sau khi modal đóng,
   * MutationObserver + checkForNewOrders sẽ pick up đơn tiếp theo.
   */
  function safeNavigateToOverview() {
    if (_orderQueue.length > 0) return; // còn đơn chờ → bỏ qua, giữ nguyên DOM
    if (!window.location.href.includes('orders/overview')) {
      emitDiag('reload', {
        page: 'uberEatsWin',
        reason: 'NAVIGATE_OVERVIEW_WHEN_QUEUE_EMPTY',
        action: 'location.href',
        queueLength: _orderQueue.length
      });
      window.location.href = 'https://merchants-beta.ubereats.com/orders/overview';
    }
  }

  async function processNextQueued() {
    if (_state !== 'idle' || !_orderQueue.length) return;

    // Peek – không remove trước await để tránh race giữa 2 lần gọi đồng thời
    const item = _orderQueue[0];
    const { el, code } = item;
    const queuedAt = Number(item && item.queuedAt) || Number(_orderEnqueuedAt.get(code) || 0);
    const firstSeenAt = Number(_orderFirstSeenAt.get(code) || 0);
    emitDiag('order_activity', {
      page: 'uberEatsWin',
      action: 'uber_queue_dequeue_start',
      orderCode: nt(code || ''),
      queueLength: _orderQueue.length,
      queueWaitMs: queuedAt > 0 ? Math.max(0, Date.now() - queuedAt) : null,
      detectToStartMs: firstSeenAt > 0 ? Math.max(0, Date.now() - firstSeenAt) : null
    });

    let alreadySent = false;
    try { alreadySent = await wasAdminSent(code); } catch (_) {}

    // Sau await: nếu một task khác đã chiếm _state thì dừng (đơn vẫn còn trong queue)
    if (_state !== 'idle') return;

    // Chính thức lấy ra khỏi queue (chỉ remove khi vẫn là phần tử đầu)
    if (_orderQueue[0] === item) _orderQueue.shift();

    if (alreadySent) {
      dbg('[UberEats Bridge] [Queue] Đơn xuất hiện lại, chỉ Chấp nhận không gửi admin:', code);
      emitDiag('order_activity', {
        page: 'uberEatsWin',
        action: 'uber_repeated_order_processing_start',
        orderCode: nt(code || '')
      });
      setBridgeState('working'); _stateTs = Date.now();
      const repeatedStartedAt = Date.now();
      try {
        clickEl(el);
        await sleep(1200);

        let modal = null;
        try {
          await waitFor(() => {
            const t = document.body.innerText || '';
            return /\d+\s*[x×]/i.test(t) || /\n×\n/.test(t) || /\n×[^\n]/.test(t);
          }, 8000, 200).catch(() => {});
          await sleep(300);
          modal = findOrderModal();
        } catch (_) {}
        const scheduled = isScheduledOrder(modal);

        const chapNhanBtn = findChapNhanBtn();
        if (chapNhanBtn) {
          clickEl(chapNhanBtn);
          dbg('[UberEats Bridge] [Queue] Đơn lặp lại: đã bấm Chấp nhận, không gửi admin.');
        }

        if (!scheduled) {
          await sleep(1500);
          try {
            const daSanSangBtn = await waitFor(findDaSanSangBtn, 10000);
            clickEl(daSanSangBtn);
            dbg('[UberEats Bridge] [Queue] Đơn lặp lại: đã bấm Đã sẵn sàng');
            await sleep(1200);
            try {
              const danhDauBtn = await waitFor(findDanhDauDaSanSangBtn, 5000);
              clickEl(danhDauBtn);
              dbg('[UberEats Bridge] [Queue] Đơn lặp lại: đã bấm Đánh dấu là đã sẵn sàng');
            } catch (_) {}
            await sleep(1500);
            const batDauBtn = await waitFor(findBatDauGiaoHangBtn, 10000);
            clickEl(batDauBtn);
            dbg('[UberEats Bridge] [Queue] Đơn lặp lại: đã bấm Bắt đầu giao hàng');
            await sleep(1200);
            await dismissOrderModal(3);
            safeNavigateToOverview();
          } catch (e) {
            console.warn('[UberEats Bridge] [Queue] Đơn lặp lại: lỗi sau Chấp nhận:', e.message);
          }
        } else {
          await sleep(800);
          try {
            await dismissOrderModal(3);
            safeNavigateToOverview();
          } catch (e) {
            console.warn('[UberEats Bridge] [Queue] Đơn lặp lại (đặt trước): lỗi đóng modal:', e.message);
          }
        }
      } finally {
        emitDiag('order_activity', {
          page: 'uberEatsWin',
          action: 'uber_repeated_order_processing_done',
          orderCode: nt(code || ''),
          durationMs: Math.max(0, Date.now() - repeatedStartedAt)
        });
        setBridgeState('idle');
        setTimeout(processNextQueued, 300); // xử lý đơn tiếp theo trong queue
      }
      return;
    }

    captureOrder(el && document.contains(el) ? el : null, {
      code,
      customerName: item && item.customerName,
      queuedAt,
      firstSeenAt,
      enqueueSource: item && item.enqueueSource
    });
    // captureOrder's own finally sẽ gọi processNextQueued() cho đơn kế tiếp
  }

  // ── Tự động phát hiện đơn mới ────────────────────────────────────────────────

  function startAutoDetect() {
    let _detectTimer = null;
    let _overlaySeenTs = 0;
    let _overlayHitCount = 0;

    async function checkForNewOrders() {
      if (_state !== 'idle') {
        // Auto-reset nếu _state kẹt quá 3 phút (ví dụ: exception xảy ra trước finally)
        if (Date.now() - _stateTs > 3 * 60 * 1000) {
          console.warn('[UberEats Bridge] _state kẹt > 3 phút → auto-reset idle');
          setBridgeState('idle');
        } else {
          return;
        }
      }

      // Phát hiện overlay toàn màn hình "Đơn hàng mới" (che order list)
      // Phần tử ở sau overlay vẫn có rect hợp lệ → findNewOrderCards() vẫn tìm thấy thẻ
      // → phải phát hiện overlay theo kích thước + nội dung, không dựa vào cards
      const overlayEl = [...document.querySelectorAll('div,section,main,article')]
        .filter(el => isVisible(el))
        .find(el => {
          const r = el.getBoundingClientRect();
          if (r.width < window.innerWidth * 0.6 || r.height < window.innerHeight * 0.5) return false;
          const txtRaw = nt(el.innerText || '');
          const txtCmp = nct(txtRaw);
          return /don hang moi|new order|neue bestellung/.test(txtCmp) || /đơn hàng mới/i.test(txtRaw);
        });
      if (overlayEl) {
        // Kiểm tra modal đơn đang mở sẵn (app treo rồi UberEats tự mở modal)
        const openModal = findOrderModal();
        if (openModal && findChapNhanBtn()) {
          const { customerName, orderCode } = readHeader(openModal);
          if (orderCode && !autoProcessed.has(orderCode)) {
            dbg('[UberEats Bridge] Overlay + modal mở sẵn, xử lý:', orderCode);
            autoProcessed.set(orderCode, Date.now());
            enqueueOrder({ el: null, code: orderCode, customerName }, 'overlay_modal_open');
            processNextQueued();
            return;
          }
        }
        if (Date.now() - _overlaySeenTs > 12000) _overlayHitCount = 0;
        _overlaySeenTs = Date.now();
        const xemLaiBtn = findOverlayReviewBtn(overlayEl)
                       || findOverlayReviewBtn(document)
                       || findByText('xem lại', 'button,[role="button"],a,div,span', overlayEl)
                       || findByText('xem lai', 'button,[role="button"],a,div,span', overlayEl)
                       || findByText('xem lại', 'button,[role="button"],a,div,span')
                       || findByText('xem lai', 'button,[role="button"],a,div,span');
        if (xemLaiBtn) {
          dbg('[UberEats Bridge] Overlay "Đơn hàng mới", click Xem lại...');
          hardClick(xemLaiBtn);
          _overlayHitCount++;
          clearTimeout(_detectTimer);
          _detectTimer = setTimeout(checkForNewOrders, 700);
          if (_overlayHitCount >= 4) {
            dbg('[UberEats Bridge] Overlay lặp nhiều lần, ép về overview...');
            safeNavigateToOverview();
            _overlayHitCount = 0;
          }
          return; // Overlay thực sự (có nút Xem lại) → chờ UberEats tải lại danh sách
        }
        // Header "Đơn hàng mới" nằm trong container lớn cũng có thể bị hiểu nhầm là overlay.
        // Không có CTA "Xem lại" thì không reload/navigate; tiếp tục ưu tiên thẻ đơn đang thấy.
        _overlayHitCount = 0;
        dbg('[UberEats Bridge] Có chữ "Đơn hàng mới" nhưng không có CTA overlay → tìm thẻ đơn trực tiếp');
      } else {
        _overlayHitCount = 0;
      }

      const cards = findNewOrderCards();
      if (!cards.length) {
        // Fallback: kiểm tra có nút Chấp nhận đang hiện không (đơn mở sẵn, list ẩn sau modal)
        const chapNhanVisible = findChapNhanBtn();
        if (chapNhanVisible) {
          const openModal = findOrderModal() || document.body;
          const { customerName, orderCode } = readHeader(openModal);
          if (orderCode && !autoProcessed.has(orderCode)) {
            dbg('[UberEats Bridge] Modal đơn mở sẵn (không thấy thẻ mới):', orderCode);
            autoProcessed.set(orderCode, Date.now());
            enqueueOrder({ el: null, code: orderCode, customerName }, 'accept_visible_modal');
            processNextQueued();
          } else if (!orderCode) {
            // Không đọc được mã đơn nhưng nút Chấp nhận đang hiện → thử capture bằng document.body
            const anyCode = nt(document.body.innerText || '').match(/\b([A-Z0-9]{4,6})\s*[·•\u00B7\u2022]/)?.[1];
            if (anyCode && !autoProcessed.has(anyCode)) {
              dbg('[UberEats Bridge] Fallback code từ body text:', anyCode);
              autoProcessed.set(anyCode, Date.now());
              enqueueOrder({ el: null, code: anyCode }, 'accept_visible_body_fallback');
              processNextQueued();
            }
          }
        } else if (_state === 'idle' && !_orderQueue.length) {
          // Tự động dọn dẹp modal của đơn đã xử lý xong còn mở trên màn hình (như trạng thái "Đang giao hàng" / "Đã hoàn tất" / đơn đã gửi Admin)
          const openModal = findOrderModal();
          if (openModal) {
            const { orderCode } = readHeader(openModal);
            const modalText = nct(openModal.innerText || '');
            const isCompletedStatus = /dang giao hang|in delivery|unterwegs|auslieferung|da hoan tat|completed|fertig|abgeschlossen|da giao hang/.test(modalText);
            const isKnownSent = orderCode ? (autoProcessed.has(orderCode) || await wasAdminSent(orderCode)) : false;
            const hasPendingAction = !!(findChapNhanBtn() || findDaSanSangBtn() || findBatDauGiaoHangBtn() || findDanhDauDaSanSangBtn());

            if (!hasPendingAction && (isCompletedStatus || isKnownSent)) {
              dbg('[UberEats Bridge] Dọn dẹp modal đơn đã xong còn mở (' + (orderCode || 'không rõ mã') + ') → tự động đóng modal');
              await dismissOrderModal(2);
            }
          }
        }
        return;
      }
      // Enqueue tất cả thẻ đơn mới vào FIFO queue — xử lý tuần tự, không bỏ sót đơn
      for (const card of cards) {
        autoProcessed.set(card.code, Date.now());
        if (enqueueOrder(card, 'new_order_card')) {
          dbg('[UberEats Bridge] Queued order:', card.code, '| queue length:', _orderQueue.length);
        }
      }
      processNextQueued();
    }
    // MutationObserver: phát hiện ngay khi DOM thay đổi
    new MutationObserver(() => {
      clearTimeout(_detectTimer);
      _detectTimer = setTimeout(checkForNewOrders, 400);
    }).observe(document.body, { childList: true, subtree: true });
    // Fallback polling mỗi 4 giây
    setInterval(checkForNewOrders, 4000);
    // Dọn autoProcessed entries cũ (> 12h) mỗi 30 phút để tránh Map tích lũy vô hạn
    setInterval(() => {
      const cutoff = Date.now() - 12 * 60 * 60 * 1000;
      for (const [code, ts] of autoProcessed) {
        if (ts < cutoff) autoProcessed.delete(code);
      }
      for (const [code, ts] of _orderFirstSeenAt) {
        if (ts < cutoff) _orderFirstSeenAt.delete(code);
      }
      for (const [code, ts] of _orderEnqueuedAt) {
        if (ts < cutoff) _orderEnqueuedAt.delete(code);
      }
    }, 30 * 60 * 1000);
    // Kiểm tra lần đầu sau khi trang load xong
    setTimeout(checkForNewOrders, 3000);
    // Kiểm tra ngay khi app được focus / trang trở lại visible (sau background)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(_detectTimer);
        _detectTimer = setTimeout(checkForNewOrders, 500);
      }
    });
    window.addEventListener('focus', () => {
      clearTimeout(_detectTimer);
      _detectTimer = setTimeout(checkForNewOrders, 500);
    });
  }

  // ── Nút capture ───────────────────────────────────────────────────────────

  function installBtn() {
    const BTN_ID = 'ubereats-capture-btn';
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id   = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📋 Lấy đơn UberEats';
    Object.assign(btn.style, {
      padding:'9px 16px', border:'none', borderRadius:'9px',
      background:'#06C167', color:'#fff', fontWeight:'700',
      fontSize:'13px', cursor:'pointer',
      boxShadow:'0 6px 20px rgba(0,0,0,.2)',
      fontFamily:'system-ui,-apple-system,Arial,sans-serif',
      pointerEvents:'auto', whiteSpace:'nowrap', order:'2',
    });
    btn.addEventListener('click', () => captureOrder(null, { enqueueSource: 'manual' }));
    getControlsDock().appendChild(btn);
    requestAnimationFrame(layoutBridgePanel);
  }

  function installLanguageBtn() {
    const BTN_ID = 'ubereats-language-btn';
    if (document.getElementById(BTN_ID)) return;

    const languageApi = window.thaiasiaUberLanguage;
    const currentMode = languageApi && typeof languageApi.getMode === 'function'
      ? languageApi.getMode()
      : (String(navigator.language || '').toLowerCase().startsWith('de') ? 'de' : 'vi');
    const targetMode = currentMode === 'de' ? 'vi' : 'de';

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = targetMode === 'de' ? '🇩🇪 Deutsch' : '🇻🇳 Tiếng Việt';
    btn.title = targetMode === 'de'
      ? 'Chuyển trang UberEats sang tiếng Đức'
      : 'Chuyển trang UberEats sang tiếng Việt';
    Object.assign(btn.style, {
      padding:'9px 13px', border:'none', borderRadius:'9px',
      background: targetMode === 'de' ? '#1f2937' : '#c62828',
      color:'#fff', fontWeight:'700', fontSize:'13px', cursor:'pointer',
      boxShadow:'0 6px 20px rgba(0,0,0,.2)',
      fontFamily:'system-ui,-apple-system,Arial,sans-serif',
      pointerEvents:'auto', whiteSpace:'nowrap', order:'1',
    });
    btn.addEventListener('click', async () => {
      if (_state !== 'idle' || _orderQueue.length > 0) {
        alert('UberEats đang xử lý đơn. Hãy chờ xử lý xong rồi đổi ngôn ngữ.');
        return;
      }
      if (!languageApi || typeof languageApi.setMode !== 'function') {
        alert('Không tìm thấy chức năng đổi ngôn ngữ. Hãy khởi động lại app.');
        return;
      }
      btn.disabled = true;
      btn.style.cursor = 'wait';
      btn.textContent = '⏳ Đang đổi...';
      try {
        await languageApi.setMode(targetMode);
      } catch (error) {
        btn.disabled = false;
        btn.style.cursor = 'pointer';
        btn.textContent = targetMode === 'de' ? '🇩🇪 Deutsch' : '🇻🇳 Tiếng Việt';
        alert('Không đổi được ngôn ngữ UberEats: ' + (error && error.message || error));
      }
    });
    getControlsDock().appendChild(btn);
    requestAnimationFrame(layoutBridgePanel);
  }

  function installControls() {
    installBtn();
    installLanguageBtn();
  }

  // ── Khởi động ─────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { installControls(); startAutoDetect(); });
  } else {
    installControls();
    startAutoDetect();
  }

  // Cài lại sau SPA navigation hoặc khi React xóa button khỏi DOM
  let _lastUrl = location.href;
  new MutationObserver(() => {
    const urlChanged = location.href !== _lastUrl;
    if (urlChanged) { _lastUrl = location.href; setTimeout(installControls, 1500); return; }
    // React có thể re-render mà không đổi URL → button biến mất
    if (!document.getElementById('ubereats-capture-btn') || !document.getElementById('ubereats-language-btn')) {
      installControls();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Fallback: kiểm tra mỗi 3 giây
  setInterval(() => {
    if (!document.getElementById('ubereats-capture-btn') || !document.getElementById('ubereats-language-btn')) installControls();
  }, 3000);

  dbg('[UberEats Bridge v2.0] Loaded');

  // Phục hồi sau khi máy sleep/wake-up hoặc mất mạng. Chromium có thể phát nhiều
  // sự kiện `online` khi card mạng chập chờn, vì vậy chỉ reload sau một `offline`
  // thật, khi mạng đã ổn định và Uber không có đơn đang mở/đang xử lý.
  const ONLINE_RECOVERY_STABLE_MS = 10 * 1000;
  const ONLINE_RECOVERY_LONG_OUTAGE_MS = 10 * 1000;
  const ONLINE_RECOVERY_SHORT_COOLDOWN_MS = 10 * 60 * 1000;
  const ONLINE_RECOVERY_BUSY_RETRY_MS = 3000;
  const ONLINE_RECOVERY_LAST_RELOAD_KEY = 'thaiasia_uber_last_online_recovery_reload_at';
  let offlineStartedAt = navigator.onLine === false ? Date.now() : 0;
  let onlineRecoveryTimer = null;
  let onlineRecoveryGeneration = 0;

  const readLastOnlineRecoveryReloadAt = () => {
    try { return Number(sessionStorage.getItem(ONLINE_RECOVERY_LAST_RELOAD_KEY) || '0') || 0; } catch (_) { return 0; }
  };
  const rememberOnlineRecoveryReload = (ts) => {
    try { sessionStorage.setItem(ONLINE_RECOVERY_LAST_RELOAD_KEY, String(ts)); } catch (_) {}
  };
  const clearOnlineRecoveryTimer = () => {
    if (onlineRecoveryTimer) clearTimeout(onlineRecoveryTimer);
    onlineRecoveryTimer = null;
  };

  window.addEventListener('offline', () => {
    offlineStartedAt = Date.now();
    onlineRecoveryGeneration += 1;
    clearOnlineRecoveryTimer();
    dbg('[UberEats Bridge] Đã phát hiện mất mạng; chờ kết nối ổn định để phục hồi an toàn.');
  });

  window.addEventListener('online', () => {
    const outageStartedAt = offlineStartedAt;
    if (!outageStartedAt) {
      dbg('[UberEats Bridge] Bỏ qua tín hiệu online không có offline trước đó.');
      return;
    }

    offlineStartedAt = 0;
    const recoveredAt = Date.now();
    const outageMs = Math.max(0, recoveredAt - outageStartedAt);
    const generation = ++onlineRecoveryGeneration;
    clearOnlineRecoveryTimer();
    dbg(`[UberEats Bridge] Mạng phục hồi sau ${Math.round(outageMs / 1000)}s; chờ ổn định trước khi kiểm tra reload.`);

    const reloadWhenSafe = () => {
      if (generation !== onlineRecoveryGeneration) return;
      if (navigator.onLine === false) {
        offlineStartedAt = offlineStartedAt || Date.now();
        clearOnlineRecoveryTimer();
        return;
      }

      const stableForMs = Date.now() - recoveredAt;
      if (stableForMs < ONLINE_RECOVERY_STABLE_MS) {
        onlineRecoveryTimer = setTimeout(reloadWhenSafe, ONLINE_RECOVERY_STABLE_MS - stableForMs);
        return;
      }

      let hasOpenOrder = false;
      try { hasOpenOrder = !!findOrderModal(); } catch (_) {}
      if (_state !== 'idle' || _orderQueue.length > 0 || hasOpenOrder || window.__thaiasiaOrderProcessing === true) {
        onlineRecoveryTimer = setTimeout(reloadWhenSafe, ONLINE_RECOVERY_BUSY_RETRY_MS);
        return;
      }

      const nowTs = Date.now();
      const longOutage = outageMs >= ONLINE_RECOVERY_LONG_OUTAGE_MS;
      const lastReloadAt = readLastOnlineRecoveryReloadAt();
      const shortOutageInCooldown = !longOutage
        && lastReloadAt > 0
        && nowTs - lastReloadAt < ONLINE_RECOVERY_SHORT_COOLDOWN_MS;
      if (shortOutageInCooldown) {
        clearOnlineRecoveryTimer();
        dbg('[UberEats Bridge] Bỏ qua reload do chập mạng ngắn trong thời gian cooldown; trang Uber vẫn đang hoạt động.');
        return;
      }

      clearOnlineRecoveryTimer();
      rememberOnlineRecoveryReload(nowTs);
      emitDiag('reload', {
        page: 'uberEatsWin',
        reason: 'ONLINE_RECOVERY_RELOAD',
        action: 'location.reload',
        outageMs,
        stableForMs,
        longOutage,
        cooldownMs: ONLINE_RECOVERY_SHORT_COOLDOWN_MS
      });
      window.location.reload();
    };

    onlineRecoveryTimer = setTimeout(reloadWhenSafe, ONLINE_RECOVERY_STABLE_MS);
  });

})();

  // ── Tiện ích ─────────────────────────────────────────────────────────────────

  function now() { return Date.now(); }

  function normalizeText(t) {
    return String(t || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizeComparableText(t) {
    return normalizeText(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
    return (el.offsetWidth > 0 && el.offsetHeight > 0) || (el.scrollWidth > 0 && el.scrollHeight > 0);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalizePaymentMethod(v) {
    const s = normalizeComparableText(v);
    if (!s) return 'Online';
    if (/\bcash\b|\bbar\b/.test(s)) return 'Bar';
    return 'Online'; // UberEats thường đã thanh toán online
  }

  function parseMoneyToNumberString(v) {
    let t = normalizeText(v).replace(/EUR|€|\$/gi, '').replace(/\s+/g, '').replace(/[^\d,.-]/g, '');
    if (t.includes('.') && t.includes(',')) {
      if (t.lastIndexOf(',') > t.lastIndexOf('.')) t = t.replace(/\./g, '').replace(',', '.');
      else t = t.replace(/,/g, '');
    } else if (t.includes(',')) {
      t = t.replace(',', '.');
    }
    return t;
  }

  function normalizeDecimalDotString(v) {
    return normalizeText(v).replace(',', '.');
  }

  function sanitizeOrderCodeForKey(code) {
    return normalizeText(code || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function getBridgeOrderStorageKey(orderCode) {
    const safe = sanitizeOrderCodeForKey(orderCode);
    return safe ? `${BRIDGE_STORAGE_KEY}_${safe}` : BRIDGE_STORAGE_KEY;
  }

  // ── Storage ──────────────────────────────────────────────────────────────────

  async function upsertBridgeOrderIndex(storageKey, orderCode) {
    try {
      const raw = await GM_getValue(BRIDGE_ORDER_INDEX_KEY, []);
      const index = Array.isArray(raw) ? raw : [];
      const existing = index.findIndex(x => x.key === storageKey);
      if (existing >= 0) {
        index[existing] = { key: storageKey, code: orderCode, ts: now() };
      } else {
        index.unshift({ key: storageKey, code: orderCode, ts: now() });
      }
      await GM_setValue(BRIDGE_ORDER_INDEX_KEY, index.slice(0, 20));
    } catch (_) {}
  }

  async function savePayload(payload, opts = {}) {
    const orderCode = normalizeText(payload?.orderCode || '');
    const storageKey = orderCode ? getBridgeOrderStorageKey(orderCode) : BRIDGE_STORAGE_KEY;
    const finalPayload = {
      ...payload,
      __autoFill:     !!opts.autoFill,
      __autoSubmit:   !!opts.autoSubmit,
      __autoActionAt: opts.autoFill ? now() : null,
    };
    // Xóa key nội bộ trước khi lưu
    delete finalPayload.__storageKey;
    await GM_setValue(storageKey, finalPayload);
    await GM_setValue(BRIDGE_ACTIVE_ORDER_KEY, storageKey);
    await upsertBridgeOrderIndex(storageKey, orderCode);
    return storageKey;
  }

  async function loadPayload() {
    try {
      const activeKey = await GM_getValue(BRIDGE_ACTIVE_ORDER_KEY, '');
      if (activeKey) {
        const p = await GM_getValue(activeKey, null);
        if (p) return { ...p, __storageKey: activeKey };
      }
    } catch (_) {}
    const legacy = await GM_getValue(BRIDGE_STORAGE_KEY, null);
    return legacy ? { ...legacy, __storageKey: BRIDGE_STORAGE_KEY } : null;
  }

  async function clearPayload() {
    try {
      const p = await loadPayload();
      if (p?.__storageKey) await GM_deleteValue(p.__storageKey);
      await GM_deleteValue(BRIDGE_ACTIVE_ORDER_KEY);
    } catch (_) {}
    await GM_deleteValue(BRIDGE_STORAGE_KEY);
  }

  async function getRecentSentOrders() {
    const data = await GM_getValue(SENT_ORDERS_KEY, []);
    const cutoff = now() - DEDUP_WINDOW_MS;
    return Array.isArray(data) ? data.filter(e => e.ts > cutoff) : [];
  }

  async function wasOrderRecentlySent(code) {
    if (!code) return false;
    const recent = await getRecentSentOrders();
    return recent.some(e => e.code === normalizeText(code));
  }

  async function markOrderAsSent(code) {
    if (!code) return;
    const recent = await getRecentSentOrders();
    recent.push({ code: normalizeText(code), ts: now() });
    await GM_setValue(SENT_ORDERS_KEY, recent);
  }

  // ── Trích xuất dữ liệu từ UberEats ──────────────────────────────────────────

  /**
   * Tìm panel chi tiết đơn đang hiển thị.
   * UberEats merchant portal: danh sách đơn bên trái, chi tiết bên phải.
   */
  function findActiveOrderPanel() {
    // 1. Thử selector cụ thể của UberEats
    const knownSelectors = [
      '[data-testid="order-detail"]',
      '[data-testid="order-summary"]',
      '[class*="orderDetail"]',
      '[class*="OrderDetail"]',
      '[class*="order-detail"]',
      '[class*="OrderSummary"]',
      '[class*="order-summary"]',
    ];
    for (const sel of knownSelectors) {
      try {
        const el = [...document.querySelectorAll(sel)].find(isVisible);
        if (el) return el;
      } catch (_) {}
    }

    // 2. Fallback: panel phải có giá + món + mã đơn
    const candidates = [...document.querySelectorAll('div, section, aside, article, main')]
      .filter(el => {
        if (!isVisible(el)) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 260 || r.height < 180) return false;
        const text = normalizeText(el.innerText || '');
        if (text.length < 80) return false;
        const hasPrice   = /\d+[.,]\d{2}|\$\d|€\d|\d\s*€/i.test(text);
        const hasItems   = /subtotal|total|item/i.test(text);
        const hasOrderId = /#[A-Z0-9]{3,}|order\s*#|order\s*id/i.test(text);
        return (hasOrderId || hasItems) && hasPrice;
      });

    if (!candidates.length) return document.body;

    // Ưu tiên panel bên phải, kích thước vừa
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const score = el => {
        const r2 = el.getBoundingClientRect();
        return r2.left                               // panel phải → score cao
          + (r2.width > 250 && r2.width < 900 ? 800 : 0)
          + (r2.height > 300 ? 300 : 0);
      };
      return score(b) - score(a);
    });
    return candidates[0];
  }

  function extractOrderId(text) {
    const patterns = [
      /#([A-Z0-9]{4,})/i,
      /order\s*#\s*([A-Z0-9]{3,})/i,
      /order\s*id[:\s]*([A-Z0-9]{3,})/i,
      /(\b\d{6,}\b)/,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return normalizeText(m[1]);
    }
    return '';
  }

  function extractCustomerName(panelEl, lines) {
    if (!panelEl) return '';

    // 1. Thử thuộc tính data-testid/aria-label chứa "customer" / "name"
    const attrSelectors = [
      '[data-testid*="customer-name"]', '[data-testid*="customerName"]',
      '[data-testid*="buyer"]',         '[aria-label*="customer"]',
    ];
    for (const sel of attrSelectors) {
      try {
        const el = [...panelEl.querySelectorAll(sel)].find(isVisible);
        if (el) {
          const t = normalizeText(el.innerText || el.textContent || '');
          if (t && t.length > 1 && t.length < 80 && /\p{L}/u.test(t)) return t;
        }
      } catch (_) {}
    }

    // 2. Label "Customer:" hoặc "Name:" → dòng tiếp theo
    for (let i = 0; i < lines.length; i++) {
      if (/^(customer|name|client|buyer)\s*:?\s*$/i.test(lines[i])) {
        const next = normalizeText(lines[i + 1] || '');
        if (next && next.length < 80 && /\p{L}/u.test(next) &&
            !/street|ave|road|str\.\s*\d|\d{4,}|subtotal|total|item/i.test(next)) {
          return next;
        }
      }
    }

    // 3. Tìm dòng có dạng "Delivered to FirstName" hoặc "Für FirstName"
    for (const line of lines) {
      const m = line.match(/(?:delivered\s+to|für|for|customer)\s+([A-ZÄÖÜa-zäöüß]{2,40})/i);
      if (m) return normalizeText(m[1]);
    }

    return '';
  }

  function extractDeliveryAddress(panelEl, lines) {
    if (!panelEl) return '';

    // 1. Selector địa chỉ giao hàng
    const addrSelectors = [
      '[data-testid*="delivery-address"]', '[data-testid*="deliveryAddress"]',
      '[data-testid*="address"]',
      '[class*="deliveryAddress"]',        '[class*="delivery-address"]',
      '[class*="address"]',
    ];
    for (const sel of addrSelectors) {
      try {
        const el = [...panelEl.querySelectorAll(sel)].find(isVisible);
        if (el) {
          const t = normalizeText(el.innerText || el.textContent || '');
          if (t && /\d/.test(t) && t.length < 200) return t;
        }
      } catch (_) {}
    }

    // 2. Sau label "Delivery address:" / "Deliver to:"
    for (let i = 0; i < lines.length; i++) {
      if (/^(delivery\s+address|deliver\s+to|lieferadresse|adresse)\s*:?\s*$/i.test(lines[i])) {
        const next = normalizeText(lines[i + 1] || '');
        if (next && /\d/.test(next)) {
          // Kết hợp thêm dòng thứ 2 nếu trông như city/ZIP
          const next2 = normalizeText(lines[i + 2] || '');
          return next2 && /\d{4,}/.test(next2) ? `${next}, ${next2}` : next;
        }
      }
    }

    // 3. Tìm dòng khớp mẫu địa chỉ Đức
    for (const line of lines) {
      if (/\d{5}\s+\w/.test(line)) return line;                              // "12345 Berlin"
      if (/\w+\s+\d+[a-zA-Z]?\s*,\s*\d{5}/.test(line)) return line;        // "Hauptstr. 5, 12345"
      if (/straße|strasse|str\.\s+\d|gasse|weg\s+\d|allee|platz/i.test(line) &&
          /\d+/.test(line) && line.length < 120) return line;
    }

    return '';
  }

  function extractUberEatsItems(panelEl, lines) {
    const items = [];
    const PRICE_LINE_RE = /^(?:\s*(?:EUR\s*\d+[,.]\d{2}|\d+[,.]\d{2}\s*(?:EUR|\u20AC)|\u20AC\s*\d+[,.]\d{2}|\$\s*\d+[,.]\d{2})\s*)+$/i;
    const PRICE_TAIL_RE = /\s*(?:(?:EUR\s*\d+[,.]\d{2}|\d+[,.]\d{2}\s*(?:EUR|\u20AC)|\u20AC\s*\d+[,.]\d{2}|\$\s*\d+[,.]\d{2})\s*)+(?:[\u22EE\u2026]\s*)?$/i;
    const MENU_LINE_RE = /^[\u22EE\u2026]+$/;
    const normalizeForMatch = value => normalizeText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[đ]/g, 'd');
    const isPriceLine = value => PRICE_LINE_RE.test(normalizeText(value).replace(/[\u22EE\u2026]/g, '').trim());
    const isMenuLine = value => MENU_LINE_RE.test(normalizeText(value));
    const stripTrailingPrice = value => {
      let text = normalizeText(value).replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
      let previous = '';
      while (text && text !== previous) {
        previous = text;
        text = text.replace(PRICE_TAIL_RE, '').replace(/\s*[\u22EE\u2026]+\s*$/, '').trim();
      }
      return text.replace(/\s*[:;]\s*$/, '').trim();
    };
    const isQtyOnlyLine = value => /^\d{1,3}$/.test(normalizeText(value));
    const isTimesOnlyLine = value => /^[x×]$/i.test(normalizeText(value));
    const isQtyTimesOnlyLine = value => /^(\d{1,3})\s*[x×]\s*$/i.exec(normalizeText(value));
    const isStopLine = value =>
      /^(subtotal|sub-total|total|delivery fee|service fee|fees?|taxes?|promotion|discount|gesamt|summe|zwischensumme|liefergebuhr|lieferkosten|rabatt|tong|phi|uu dai|giam gia)\b/i.test(normalizeForMatch(value));
    const tryReadSplitItemBlock = startIdx => {
      const firstLine = lines[startIdx] || '';
      let qty = '';
      let nameIdx = startIdx + 1;
      const qtyTimes = isQtyTimesOnlyLine(firstLine);
      if (qtyTimes) {
        qty = qtyTimes[1];
      } else if (isQtyOnlyLine(firstLine)) {
        qty = normalizeText(firstLine);
        if (isTimesOnlyLine(lines[nameIdx] || '')) nameIdx++;
      } else {
        return null;
      }

      const nameLines = [];
      let sawPrice = false;
      let cursor = nameIdx;
      const maxCursor = Math.min(endIdx, nameIdx + 8);
      while (cursor < maxCursor) {
        const current = lines[cursor] || '';
        if (isPriceLine(current)) {
          sawPrice = true;
          cursor++;
          while (cursor < endIdx && (isPriceLine(lines[cursor]) || isMenuLine(lines[cursor]))) cursor++;
          break;
        }
        if (isMenuLine(current)) {
          cursor++;
          continue;
        }
        if (isStopLine(current)) break;
        if (!nameLines.length && (isTimesOnlyLine(current) || isQtyOnlyLine(current) || /^\d+\s*[x×]/i.test(current))) return null;
        if (nameLines.length && (isQtyOnlyLine(current) || /^\d+\s*[x×]/i.test(current))) break;

        const cleanLine = stripTrailingPrice(current);
        if (cleanLine && !isPriceLine(cleanLine) && !isMenuLine(cleanLine)) nameLines.push(cleanLine);
        cursor++;
      }

      const code = nameLines.join(' ').replace(/\s+/g, ' ').trim();
      if (!sawPrice || code.length < 2) return null;
      return { qty, code, nextIdx: Math.max(cursor, startIdx + 1) };
    };

    // Tìm vùng items: từ "Items" / "X items" → "Subtotal"
    let startIdx = -1, endIdx = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (startIdx === -1 &&
          (/^items?\s*:?\s*$/i.test(lines[i]) ||
           /^\d+\s+items?\s*$/i.test(lines[i]) ||
           /^your\s+order\s*:?\s*$/i.test(lines[i]) ||
           /^bestellung\s*:?\s*$/i.test(lines[i]))) {
        startIdx = i + 1;
      }
      if (startIdx !== -1 &&
          /^(subtotal|sub-total|total|delivery\s+fee|service\s+fee|fees?|taxes?|promotion)/i.test(lines[i])) {
        endIdx = i;
        break;
      }
    }

    // Nếu không tìm được vùng rõ ràng, scan toàn bộ
    if (startIdx === -1) startIdx = 0;

    let i = startIdx;
    while (i < endIdx) {
      const line = lines[i];
      if (!line) { i++; continue; }

      const splitBlock = tryReadSplitItemBlock(i);
      if (splitBlock) {
        items.push({ qty: splitBlock.qty, code: splitBlock.code, name: '', note: '' });
        i = splitBlock.nextIdx;
        continue;
      }

      // Bỏ qua dòng tổng tiền
      if (/^(subtotal|total|fee|tax|promotion|discount|\$\s*[\d.,]+|€\s*[\d.,]+)/i.test(line)) { i++; continue; }
      // Bỏ qua dòng giá đơn thuần
      if (isPriceLine(line)) { i++; continue; }

      // Mẫu "2x Spicy Tuna Roll" hoặc "2 x Spicy Tuna Roll"
      const mInline = line.match(/^(\d+)\s*[x×]\s*(.+)$/i);
      // Mẫu "2 Spicy Tuna Roll" (số đầu, chữ hoa tiếp theo)
      const mQtyName = line.match(/^(\d+)\s+([A-ZÄÖÜ].{1,80})$/);
      // Mẫu số lượng riêng, tiếp theo dòng là tên
      const mQtyOnly = /^(\d+)$/.test(line) ? line.match(/^(\d+)$/) : null;

      let qty = '', code = '';

      if (mInline) {
        qty  = mInline[1];
        code = stripTrailingPrice(mInline[2]);
      } else if (mQtyName && !/^(subtotal|total|delivery|service|fee|tax|item)/i.test(mQtyName[2])) {
        qty  = mQtyName[1];
        code = normalizeText(mQtyName[2]);
      } else if (mQtyOnly && i + 1 < endIdx) {
        const nextLine = normalizeText(lines[i + 1] || '');
        if (nextLine && !/^[\$€\d]|subtotal|total|fee/i.test(nextLine)) {
          qty  = mQtyOnly[1];
          code = nextLine;
          i++;
        } else { i++; continue; }
      } else { i++; continue; }

      // Thu thập ghi chú (modifiers): dòng tiếp theo bắt đầu bằng "-", "•", "No ", "Add ", "Extra "...
      const notes = [];
      i++;
      while (i < endIdx) {
        const next = normalizeText(lines[i] || '');
        if (!next) { i++; continue; }
        if (/^\d+/.test(next) || /^(subtotal|total|fee|tax)/i.test(next)) break;
        if (next.startsWith('-') || next.startsWith('•') || next.startsWith('·') ||
            /^(no |add |extra |with |without |special )/i.test(next)) {
          notes.push(normalizeText(next.replace(/^[-•·]\s*/, '')));
          i++;
        } else {
          // Có thể là dòng tên item tiếp theo — dừng
          break;
        }
      }

      if (qty && code && code.length > 1) {
        items.push({ qty, code, name: '', note: normalizeText(notes.join(', ')) });
      }
    }

    // Deduplicate
    const seen = new Set();
    return items.filter(it => {
      const key = `${it.qty}|${it.code}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extractPricing(lines) {
    let subtotal = '', deliveryFee = '', total = '';

    const getPrice = (line, nextLine) => {
      const inLine = line.match(/([\$€]\s*\d+[.,]\d{2}|\d+[.,]\d{2}\s*€|EUR\s*\d+[.,]\d{2})/i);
      if (inLine) return normalizeText(inLine[0]);
      const next = normalizeText(nextLine || '');
      const inNext = next.match(/([\$€]\s*\d+[.,]\d{2}|\d+[.,]\d{2}\s*€|EUR\s*\d+[.,]\d{2})/i);
      if (inNext) return normalizeText(inNext[0]);
      return '';
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^subtotal|^sub-total/i.test(line))     subtotal    = subtotal    || getPrice(line, lines[i+1]);
      else if (/^delivery\s*fee|^liefergebühr|^delivery\s*cost/i.test(line))
                                                   deliveryFee = deliveryFee || getPrice(line, lines[i+1]);
      else if (/^(order\s+)?total\s*$/i.test(line)) total      = total      || getPrice(line, lines[i+1]);
    }
    return { subtotal, deliveryFee, total };
  }

  function extractDeliveryTime(lines, rawText) {
    for (const line of lines) {
      if (/^asap$/i.test(line)) return 'ASAP';
      // Dòng chứa thời gian và từ khóa liên quan
      const m = line.match(/\b(\d{1,2}:\d{2}(?:\s*[APap][Mm])?)\b/);
      if (m && /delivery|pickup|scheduled|estimated|eta|arrives?|lieferung|abholung/i.test(line)) {
        return m[1];
      }
    }
    // Tìm trong toàn văn bản
    const m = rawText.match(/(?:estimated|eta|arrives?|delivery|scheduled)\s*:?\s*(\d{1,2}:\d{2})/i);
    if (m) return m[1];
    if (/\basap\b/i.test(rawText)) return 'ASAP';
    return '';
  }

  function extractCustomerNote(lines) {
    for (let i = 0; i < lines.length; i++) {
      if (/special\s*instruction|order\s*note|customer\s*note|note\s+to|hinweis|anmerkung|ghi\s*chú|hướng\s*dẫn\s*đặc\s*biệt|yêu\s*cầu\s*đặc\s*biệt|lưu\s*ý/i.test(lines[i])) {
        const note = normalizeText(lines[i + 1] || '');
        if (note && note.length > 2 && !/^(subtotal|total|delivery|payment|item|tổng|phí|thanh\s*toán)/i.test(note)) {
          return note;
        }
      }
    }
    return '';
  }

  function extractPaymentMethod(lines) {
    for (const line of lines) {
      const l = normalizeComparableText(line);
      if (/\bcash\b|\bbar\b/.test(l)) return 'Bar';
      if (/\bprepaid\b|\bonline\b|\bcard\b|\bcredit\b|\bdebit\b|\bpaid\b/.test(l)) return 'Online';
    }
    return 'Online';
  }

  function extractUberEatsOrder() {
    const panel = findActiveOrderPanel();
    if (!panel) throw new Error('Không tìm thấy panel đơn UberEats. Hãy click vào đơn để mở chi tiết.');

    const rawText = panel.innerText || panel.textContent || '';
    const lines   = rawText.split('\n').map(normalizeText).filter(Boolean);

    if (lines.length < 3) {
      throw new Error('Panel đơn trống hoặc chưa tải xong. Hãy click vào đơn trước.');
    }

    const fullText   = normalizeText(rawText);
    const orderCode  = extractOrderId(fullText);
    const customerName = extractCustomerName(panel, lines);
    const address    = extractDeliveryAddress(panel, lines);
    const items      = extractUberEatsItems(panel, lines);
    const { subtotal, deliveryFee, total } = extractPricing(lines);
    const deliveryTime   = extractDeliveryTime(lines, fullText);
    const paymentMethod  = extractPaymentMethod(lines);
    const customerNote   = extractCustomerNote(lines);

    if (!orderCode && !customerName && !address && !items.length) {
      throw new Error('Không đọc được dữ liệu đơn UberEats. Hãy click vào đơn để mở chi tiết.');
    }

    return {
      source:           'merchants-beta.ubereats.com',
      capturedAt:       new Date().toISOString(),
      orderCode:        normalizeText(orderCode),
      customerName:     normalizeText(customerName),
      phone:            '',   // UberEats ẩn số điện thoại
      address:          normalizeText(address),
      floor:            '',
      firma:            '',
      hotel:            '',
      codeHaus:         '',
      nameNummer:       '',
      confirmationCode: '',
      paymentMethod:    normalizePaymentMethod(paymentMethod),
      deliveryTime:     normalizeText(deliveryTime),
      acceptedAt:       '',
      customerNote:     normalizeText(customerNote),
      subtotal:         normalizeText(subtotal),
      deliveryFee:      normalizeText(deliveryFee),
      total:            normalizeText(total),
      items,
    };
  }

  // ── Hiển thị Panel ───────────────────────────────────────────────────────────

  function formatItemLine(it) {
    const qty  = normalizeText(it?.qty  || '1');
    let code   = normalizeText(it?.code || '').replace(/\.$/, '');
    // Bỏ tên món sau số thứ tự: "18. Seetang Salat" → "18", "Bowl 10. Lachs Bowl" → "Bowl 10"
    code = code.replace(/(\d+)\.\s+.+$/, '$1');
    const note = normalizeText(it?.note || '');
    if (!code) return '';
    return note ? `${qty} x ${code}  :  ${note}` : `${qty} x ${code}`;
  }

  function buildItemsText(items) {
    return (items || []).map(formatItemLine).filter(Boolean).join(' + ');
  }

  function buildText(payload) {
    return [
      `Name: ${payload.customerName || ''}`,
      `Phone: ${payload.phone || ''}`,
      `Address: ${payload.address || ''}`,
      `Order code: ${payload.orderCode || ''}`,
      `Payment: ${payload.paymentMethod || ''}`,
      `Delivery time: ${payload.deliveryTime || ''}`,
      `Customer note: ${payload.customerNote || ''}`,
      `Subtotal: ${payload.subtotal || ''}`,
      `Delivery fee: ${payload.deliveryFee || ''}`,
      `Total: ${payload.total || ''}`,
      '',
      'Items:',
      buildItemsText(payload.items),
    ].join('\n');
  }

  function renderPanel(payload) {
    const PANEL_ID = 'ubereats-order-info-panel';
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const safe = payload || {};
    const itemsHtml = (safe.items || []).map((it, idx) => {
      const line = formatItemLine(it);
      return line ? `<div style="margin:3px 0;">${idx + 1}. ${escapeHtml(line)}</div>` : '';
    }).join('');

    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-weight:700;font-size:15px;color:#06C167;">UberEats → ThaiAsia</div>
        <button id="ub-panel-close" style="
          border:none;background:#eee;border-radius:6px;
          padding:3px 9px;cursor:pointer;font-weight:700;font-size:16px;
        ">×</button>
      </div>

      <div style="font-size:13px;line-height:1.65;">
        <div><b>Name:</b> ${escapeHtml(safe.customerName || '—')}</div>
        <div><b>Address:</b> ${escapeHtml(safe.address || '—')}</div>
        <div><b>Order code:</b> ${escapeHtml(safe.orderCode || '—')}</div>
        <div><b>Payment:</b> ${escapeHtml(safe.paymentMethod || '—')}</div>
        <div><b>Delivery time:</b> ${escapeHtml(safe.deliveryTime || '—')}</div>
        <div><b>Note:</b> ${escapeHtml(safe.customerNote || '—')}</div>
        <div><b>Subtotal:</b> ${escapeHtml(safe.subtotal || '—')}</div>
        <div><b>Delivery fee:</b> ${escapeHtml(safe.deliveryFee || '—')}</div>
        <div><b>Total:</b> ${escapeHtml(safe.total || '—')}</div>
      </div>

      <div style="margin-top:10px;">
        <div style="font-weight:700;margin-bottom:6px;font-size:13px;">Items</div>
        <div style="
          max-height:130px;overflow:auto;border:1px solid #e0e0e0;
          padding:8px;border-radius:8px;background:#f9f9f9;font-size:12px;
        ">${itemsHtml || '<div style="color:#999;">Chưa có món nào</div>'}</div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">
        <button id="ub-fill-btn" style="
          border:none;background:#06C167;color:#fff;border-radius:8px;
          padding:9px 14px;font-weight:700;cursor:pointer;font-size:13px;
        ">📤 Gửi sang Admin</button>
        <button id="ub-copy-btn" style="
          border:none;background:#444;color:#fff;border-radius:8px;
          padding:9px 14px;font-weight:700;cursor:pointer;font-size:13px;
        ">Copy</button>
        <button id="ub-clear-btn" style="
          border:none;background:#888;color:#fff;border-radius:8px;
          padding:9px 14px;font-weight:700;cursor:pointer;font-size:13px;
        ">Xóa</button>
      </div>

      <div style="font-size:11px;color:#999;margin-top:10px;text-align:right;">
        Admin form sẽ tự điền — KHÔNG submit
      </div>
    `;

    Object.assign(panel.style, {
      position:    'fixed',
      right:       '20px',
      top:         '80px',
      width:       '340px',
      maxHeight:   '82vh',
      overflow:    'auto',
      zIndex:      '999999',
      background:  '#fff',
      color:       '#222',
      border:      '2px solid #06C167',
      borderRadius:'14px',
      padding:     '16px',
      boxShadow:   '0 14px 40px rgba(0,0,0,.22)',
      fontFamily:  'system-ui, -apple-system, Arial, sans-serif',
    });

    document.body.appendChild(panel);

    // Đóng panel
    document.getElementById('ub-panel-close')?.addEventListener('click', () => panel.remove());

    // Gửi sang Admin (autoFill + autoSubmit)
    document.getElementById('ub-fill-btn')?.addEventListener('click', async () => {
      const p = await loadPayload();
      if (!p) { alert('Chưa có dữ liệu đơn UberEats. Hãy bấm "Lấy đơn" trước.'); return; }
      const storageKey = await savePayload(p, { autoFill: true, autoSubmit: true });
      try { GM_openInTab(THAIASIA_URL, { storageKey }); } catch (_) { window.open(THAIASIA_URL, '_blank'); }
    });

    // Copy
    document.getElementById('ub-copy-btn')?.addEventListener('click', async () => {
      const p = await loadPayload();
      if (!p) { alert('Chưa có dữ liệu đơn.'); return; }
      try { GM_setClipboard(buildText(p)); } catch (_) {}
      console.log('[UberEats Bridge] Đã copy dữ liệu đơn');
    });

    // Xóa
    document.getElementById('ub-clear-btn')?.addEventListener('click', async () => {
      await clearPayload();
      panel.remove();
    });
  }

  // ── Nút "Lấy đơn UberEats" ──────────────────────────────────────────────────

  function installCaptureButton() {
    const BTN_ID = 'ubereats-capture-order-btn';
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement('button');
    btn.id   = BTN_ID;
    btn.type = 'button';
    btn.textContent = '📋 Lấy đơn UberEats';

    Object.assign(btn.style, {
      position:     'fixed',
      right:        '20px',
      top:          '20px',
      zIndex:       '999999',
      padding:      '12px 18px',
      border:       'none',
      borderRadius: '10px',
      background:   '#06C167',
      color:        '#fff',
      fontWeight:   '700',
      fontSize:     '14px',
      cursor:       'pointer',
      boxShadow:    '0 10px 28px rgba(0,0,0,.18)',
      fontFamily:   'system-ui, -apple-system, Arial, sans-serif',
    });

    btn.addEventListener('click', async () => {
      try {
        const order = extractUberEatsOrder();

        // Kiểm tra đơn đã gửi chưa
        if (order.orderCode && await wasOrderRecentlySent(order.orderCode)) {
          const proceed = confirm(`Đơn ${order.orderCode} đã được gửi gần đây.\nGửi lại không?`);
          if (!proceed) return;
        }

        await savePayload(order, { autoFill: true });
        if (order.orderCode) await markOrderAsSent(order.orderCode);
        try { GM_setClipboard(buildText(order)); } catch (_) {}

        renderPanel(order);
        console.log('[UberEats Bridge] Đã lấy đơn:', order);
      } catch (err) {
        console.error('[UberEats Bridge]', err);
        alert('Lỗi lấy đơn UberEats:\n' + (err.message || String(err)));
      }
    });

    document.body.appendChild(btn);
  }

  // ── Khởi động ────────────────────────────────────────────────────────────────

  async function init() {
    installCaptureButton();

    // Hiển thị lại panel nếu đã có đơn UberEats được lưu
    try {
      const existing = await loadPayload();
      if (existing && existing.source === 'merchants-beta.ubereats.com') {
        renderPanel(existing);
      }
    } catch (_) {}
  }
