// ==UserScript==
// @name         ThaiAsia All-in-One (Bridge + Queue + Übergabe)
// @namespace    thaiasia-tools
// @version      1.0.0
// @description  Kết hợp: Bridge v9.6.1 + Auto Send+Accept Queue v3.3.0 + Auto Übergabe v1.1.0 — đủ mạnh chạy nền trên máy Kasse POS
// @author       OpenAI
// @match        https://live-orders.takeaway.com/orders?tabmode=tudongsend*
// @match        https://live-orders.takeaway.com/history*
// @match        https://www.api.thaiasiasushibar.de/*
// @match        https://api.thaiasiasushibar.de/*
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        window.close
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Guard chống inject trùng khi trang reload (dom-ready bắn lại sau crash recovery)
  if (window.__thaisiaAllinoneLoaded) {
    console.log('[ThaiAsia] Script đã chạy rồi, bỏ qua inject lần này');
    return;
  }
  window.__thaisiaAllinoneLoaded = true;

  // ============================================================
  // SHARED CONSTANTS
  // ============================================================

  // ---- Bridge (Sendtothaiasia) ----
  const BRIDGE_STORAGE_KEY    = 'thaiasia_takeaway_order_bridge_v9';
  const BRIDGE_ORDER_INDEX_KEY = 'thaiasia_takeaway_order_bridge_index_v9';
  const BRIDGE_ACTIVE_ORDER_KEY= 'thaiasia_takeaway_order_bridge_active_v9';
  const THAIASIA_URL          = 'https://www.api.thaiasiasushibar.de/admin/orders/create';
  const AUTO_ACTION_TTL_MS    = 2 * 60 * 1000;
  const AUTO_SUBMIT_LOCK_KEY  = '__thaiasia_auto_submit_lock_v9600';
  const AUTO_SUBMIT_DONE_KEY  = '__thaiasia_auto_submit_done_v9600';
  const CLOSE_TAB_SIGNAL_KEY  = '__thaiasia_close_admin_tab_v9600';
  const ADMIN_SUBMIT_CONFIRM_TIMEOUT_MS = 20000;
  const ADMIN_SUBMIT_POLL_MS = 250;
  const DEFAULT_EMAIL         = 'thaiasiasushibar@gmail.com';
  const SENT_ORDERS_KEY       = 'thaiasia_sent_orders_dedup_v9';
  const DEDUP_WINDOW_MS       = 24 * 60 * 60 * 1000;
  const SEND_RESULT_KEY       = '__thaiasia_send_result_v9600';
  const STRICT_ORDER_CODE_REQUIRED = true;

  // ---- Queue (autoklicksendundaccept) ----
  const QUEUE_STATE_KEY       = 'thaiasia_auto_send_accept_state_v3';
  const LAST_CYCLE_KEY        = 'thaiasia_last_cycle_at_v3';
  const PROCESSING_LOCK_KEY   = '__thaiasia_processing_lock';
  const PROCESSING_LOCK_OWNER_KEY = '__thaiasia_processing_lock_owner';
  const PROCESSING_LOCK_TAB_KEY   = '__thaiasia_processing_lock_tab';
  const SEND_RESULT_MIRROR_KEY = '__thaiasia_send_result_v9600_mirror';
  const QUEUE_STATE_MIRROR_KEY = 'thaiasia_auto_send_accept_state_v3_mirror';

  const QUEUE_CFG = {
    ACCEPT_TEXT:                   'Annehmen',
    SEND_TEXT:                     'Lấy đơn Lieferando',
    SCAN_INTERVAL_MS:              1000,   // 1 s — matches Chrome's 1 Hz background throttle floor
    OBSERVER_DEBOUNCE_MS:          150,
    WAIT_SEND_SIGNAL_TIMEOUT_MS:   6000,   // base 6 s (× multiplier when hidden)
    AFTER_ACCEPT_SETTLE_MS:        3500,
    POLL_INTERVAL_MS:              200,    // base poll; adaptive min 1 s when hidden
    WAIT_ACCEPT_READY_TIMEOUT_MS:  3000,
    WAIT_ACCEPT_CHANGE_TIMEOUT_MS: 4000,
    WAIT_ORDER_PANEL_TIMEOUT_MS:   5000,
    STORAGE_TTL_MS:                180000, // 3 min — survive background timer jitter during resume
    MIN_CYCLE_GAP_MS:              5000,
    HIDDEN_TIMEOUT_MULTIPLIER:     10,     // × 10 when background (Chrome 1 Hz throttle)
    SEND_SIGNAL_MAX_AGE_MS:        10 * 60 * 1000,
    PROCESSING_LOCK_MAX_AGE_MS:    10 * 60 * 1000, // heartbeat may be delayed in background
    LOCK_HEARTBEAT_INTERVAL_MS:    800    // under 1 s so Chrome's 1 Hz floor still beats it
  };

  // ---- Übergabe (Klickübergabe) ----
  const UBERGABE_LAST_CLICK_KEY      = 'thaiasia_ubergabe_last_click';
  const UB_CLICK_COOLDOWN_MS         = 5000;
  const UB_PROCESSING_LOCK_MAX_AGE   = 10 * 60 * 1000;
  const UB_SEND_SIGNAL_MAX_AGE       = 10 * 60 * 1000;

  // ---- Debug flags ----
  const DEBUG_GLOBAL  = false; // Tắt cho production 24/7 — tránh log triệu dòng
  const BRIDGE_DEBUG  = DEBUG_GLOBAL && true;
  const QUEUE_DEBUG   = DEBUG_GLOBAL && true;
  const UB_DEBUG      = DEBUG_GLOBAL && true;

  // ---- Global error handler ----
  // Luôn lưu lỗi vào localStorage dù DEBUG tắt — cần biết app có đang lỗi không
  function saveGlobalError(type, msg, stack) {
    try {
      const key = 'thaiasia_error_logs';
      const logs = JSON.parse(localStorage.getItem(key) || '[]');
      logs.push({ time: new Date().toISOString(), context: type, message: msg, stack: stack || '' });
      while (logs.length > 100) logs.shift();
      localStorage.setItem(key, JSON.stringify(logs));
    } catch (_) {}
  }
  window.addEventListener('error', function (e) {
    saveGlobalError('GLOBAL_ERROR', e.message + ' ' + e.filename + ':' + e.lineno, e.error && e.error.stack);
    if (DEBUG_GLOBAL) console.error('[GLOBAL ERROR]', e.message, e.filename, e.lineno, e.colno, e.error);
  });
  window.addEventListener('unhandledrejection', function (e) {
    const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    const stack = e.reason && e.reason.stack ? e.reason.stack : '';
    saveGlobalError('UNHANDLED_REJECTION', msg, stack);
    if (DEBUG_GLOBAL) console.error('[UNHANDLED PROMISE REJECTION]', e.reason);
  });

  // ============================================================
  // SHARED IN-MEMORY STATE
  // ============================================================

  // Queue
  let queueInFlight          = false;
  let queueExpectedOrderCode = '';
  let queueObserverDebounce  = null;
  let queueLockHeartbeat     = null;
  const queueLockOwnerToken  = `q_${Math.random().toString(36).slice(2)}_${now()}`;
  try { window.__thaiasiaOrderProcessing = false; } catch (_) {}

  function setQueueInFlight(active) {
    queueInFlight = !!active;
    try { window.__thaiasiaOrderProcessing = queueInFlight; } catch (_) {}
  }

  // Bridge
  let _adminTabRef       = null;
  let _closeWatcherTimer = null;

  // Übergabe
  let ubClickInProgress = false;

  // ============================================================
  // SHARED UTILITIES
  // ============================================================

  function now() { return Date.now(); }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Primary normalizeText — no lowercase, strips &nbsp; (used by Bridge for data extraction)
  function normalizeText(text) {
    return String(text || '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/\u00A0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Lowercase normalizer — used by Queue and Übergabe for button text matching
  function normLower(text) {
    return normalizeText(text).toLowerCase();
  }

  function normalizeComparableText(text) {
    return normLower(text)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function stripUiNoise(text) {
    return normalizeText(
      String(text || '')
        .replace(/[▲▼▴▾⌃⌄˄˅↑↓^]/g, ' ')
        .replace(/[☎📞]/g, ' ')
    );
  }

  function cleanAddress(text) {
    return normalizeText(text).replace(/\s+,/g, ',');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function uniq(arr) {
    return [...new Set(arr.map(normalizeText).filter(Boolean))];
  }

  function stripPriceFromItemText(text) {
    return normalizeText(text)
      .replace(/\bEUR\s*\d+[.,]\d{2}\b/gi, '')
      .replace(/\b\d+[.,]\d{2}\s*(?:EUR|\u20AC)\b/gi, '')
      .replace(/\b(?:EUR|\u20AC)?\s*\d+[.,]\d{2}\s*(?:EUR|\u20AC)?\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // Merged isVisible — most thorough (checks document.contains + computedStyle + rect / layout dimensions)
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (!document.contains(el)) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.pointerEvents === 'none' ||
      Number(style.opacity) === 0
    ) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    return (el.offsetWidth > 0 && el.offsetHeight > 0) || (el.scrollWidth > 0 && el.scrollHeight > 0);
  }

  // Merged isDisabled — most thorough
  function isDisabled(el) {
    if (!el) return true;
    return !!(
      el.disabled ||
      el.getAttribute('disabled') !== null ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('disabled')
    );
  }

  function isFillableField(el) {
    if (!el || !(el instanceof Element)) return false;
    if (!isVisible(el)) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'select') return !el.disabled;
    if (tag !== 'input') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'email', 'tel', 'search', 'number', 'time', ''].includes(type);
  }

  function isSelectableField(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'select') return !el.disabled;
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return isVisible(el) && ['text', 'search', 'hidden', ''].includes(type);
    }
    return false;
  }

  function getVisibleText(el) {
    if (!el || !(el instanceof Element) || !isVisible(el)) return '';
    return normalizeText(stripUiNoise(el.innerText || el.textContent || ''));
  }

  // ---- Module log functions ----
  function log(...a)  { if (BRIDGE_DEBUG) console.log('[ThaiAsia Bridge]',  ...a); }
  function qLog(...a) { if (QUEUE_DEBUG)  console.log('[ThaiAsia Queue]',   ...a); }
  function uLog(...a) { if (UB_DEBUG)     console.log('[Auto Übergabe]',    ...a); }
  function emitDiag(eventType, payload) {
    try {
      const row = {
        v: 1,
        module: 'allinone',
        eventType: String(eventType || ''),
        ts: new Date().toISOString(),
        ...(payload || {})
      };
      if (row.eventType === 'order_activity') {
        try { window.dispatchEvent(new CustomEvent('thaiasia-order-activity', { detail: row })); } catch (_) {}
      }
      console.warn('[ThaiAsiaDiag] ' + JSON.stringify(row));
    } catch (_) {}
  }
  // Lưu log lỗi vào localStorage
  function saveErrorLogToLocalStorage(context, err) {
    try {
      const key = 'thaiasia_error_logs';
      const logs = JSON.parse(localStorage.getItem(key) || '[]');
      logs.push({
        time: new Date().toISOString(),
        context,
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : '',
      });
      // Giới hạn tối đa 100 log gần nhất
      while (logs.length > 100) logs.shift();
      localStorage.setItem(key, JSON.stringify(logs));
    } catch (e) {
      // Nếu lỗi khi lưu log thì chỉ log ra console
      if (DEBUG_GLOBAL) console.error('[ERROR][saveErrorLogToLocalStorage]', e);
    }
  }

  function logError(context, err) {
    // Luôn lưu vào localStorage — cần biết lỗi ngảy dù DEBUG tắt
    saveErrorLogToLocalStorage(context, err);
    if (DEBUG_GLOBAL) {
      console.error(`[ERROR][${context}]`, err && err.stack ? err.stack : err);
    }
  }

  // ============================================================
  // ===== BRIDGE MODULE (Sendtothaiasia v9.6.1) =====
  // ============================================================

  async function getRecentSentOrders() {
    const data = await GM_getValue(SENT_ORDERS_KEY, []);
    const cutoff = now() - DEDUP_WINDOW_MS;
    return Array.isArray(data) ? data.filter((e) => e.ts > cutoff) : [];
  }

  async function markOrderAsSent(orderCode) {
    if (!orderCode) return;
    const recent = await getRecentSentOrders();
    recent.push({ code: normLower(orderCode), ts: now() });
    await GM_setValue(SENT_ORDERS_KEY, recent);
  }

  async function wasOrderRecentlySent(orderCode) {
    if (!orderCode) return false;
    const code = normLower(orderCode);
    const recent = await getRecentSentOrders();
    return recent.some((e) => e.code === code);
  }

  function notify(text, title = 'ThaiAsia Bridge') {
    if (BRIDGE_DEBUG) console.log(`${title}: ${text}`);
  }

  function normalizePaymentMethod(value) {
    const v = normalizeComparableText(value);
    if (!v) return '';
    if (/\bonline\b/.test(v)) return 'Online';
    if (/\bbar\b/.test(v)) return 'Bar';
    return '';
  }

  function sanitizeLegacyPayload(payload) {
    if (!payload) return payload;
    if (!Array.isArray(payload.items)) {
      payload.items = [];
    } else {
      payload.items = payload.items
        .map((it) => ({
          qty:  normalizeText(it?.qty  || '1'),
          code: normalizeText(it?.code || ''),
          name: normalizeText(it?.name || ''),
          note: normalizeText(it?.note || ''),
        }))
        .filter((it) => it.code);
    }
    payload.customerName    = normalizeText(payload.customerName    || '');
    payload.phone           = normalizeText(payload.phone           || '');
    payload.confirmationCode= normalizeText(payload.confirmationCode|| '');
    payload.acceptedAt      = normalizeText(payload.acceptedAt      || '');
    payload.deliveryTime    = normalizeText(payload.deliveryTime    || '');
    payload.paymentMethod   = normalizePaymentMethod(payload.paymentMethod || '');
    payload.subtotal        = normalizeText(payload.subtotal        || '');
    payload.deliveryFee     = normalizeText(payload.deliveryFee     || '');
    payload.total           = normalizeText(payload.total           || '');
    payload.customerNote    = normalizeText(payload.customerNote    || '');
    payload.postItemsNote   = normalizeText(payload.postItemsNote   || '');
    payload.cutlery         = normalizeText(payload.cutlery         || '');
    payload.firma           = normalizeText(payload.firma           || '');
    payload.hotel           = normalizeText(payload.hotel           || '');
    payload.buildingName    = normalizeText(payload.buildingName    || '');
    payload.eingang         = normalizeText(payload.eingang         || '');
    payload.apartment       = normalizeText(payload.apartment       || '');
    payload.floor           = normalizeText(payload.floor           || '');
    payload.firma           = normalizeText(payload.firma           || '');
    payload.hotel           = normalizeText(payload.hotel           || '');
    payload.codeHaus        = normalizeText(payload.codeHaus        || '');
    payload.nameNummer      = normalizeText(payload.nameNummer      || '');
    payload.resolvedCity    = normalizeText(payload.resolvedCity    || '');
    payload.district        = normalizeText(payload.district        || '');
    payload.additionalAddressInfo = normalizeText(payload.additionalAddressInfo || '');
    payload.doorNote        = normalizeText(payload.doorNote        || '');
    payload.deliveryDateNote = normalizeText(payload.deliveryDateNote || '');
    payload.dateNote        = normalizeText(payload.dateNote        || '');
    payload.cardDateNote    = normalizeText(payload.cardDateNote    || '');
    payload.scheduledDateNote = normalizeText(payload.scheduledDateNote || '');
    if (typeof payload.__autoFill   !== 'boolean') payload.__autoFill   = false;
    if (typeof payload.__autoSubmit !== 'boolean') payload.__autoSubmit = false;
    if (!payload.__autoActionAt) payload.__autoActionAt = null;
    return payload;
  }

  function formatItemLine(it) {
    const qty  = normalizeText(it?.qty  || '1');
    let code   = normalizeText(it?.code || '').replace(/\.$/, '');
    // Bỏ tên món sau số thứ tự: "18. Seetang Salat" → "18", "Bowl 10. Lachs Bowl" → "Bowl 10"
    code = code.replace(/(\d+)\.\s+.+$/, '$1');
    const note = stripPriceFromItemText(it?.note || '');
    if (!code) return '';
    return note ? `${qty} x ${code}  :  ${note}` : `${qty} x ${code}`;
  }

  function buildItemsText(payload) {
    return (sanitizeLegacyPayload(payload).items || []).map(formatItemLine).filter(Boolean).join(' + ');
  }

  function buildItemsMultilineText(payload) {
    return (sanitizeLegacyPayload(payload).items || []).map(formatItemLine).filter(Boolean).join('\n');
  }

  function buildPhoneWithConfirmation(payload) {
    const fallbackPhone    = '01751559898';
    const phone            = normalizeText(payload?.phone            || '') || fallbackPhone;
    const confirmationCode = normalizeText(payload?.confirmationCode || '');
    if (phone && confirmationCode) return `${phone},${confirmationCode}#`;
    return phone;
  }

  function buildText(payload) {
    const p = sanitizeLegacyPayload(payload);
    return [
      `Name: ${p.customerName || ''}`,
      `Phone: ${buildPhoneWithConfirmation(p)}`,
      `Address: ${p.address || ''}`,
      `House number/name: ${p.nameNummer || ''}`,
      `Additional address info: ${p.additionalAddressInfo || ''}`,
      `Floor: ${p.floor || ''}`,
      `Order code: ${p.orderCode || ''}`,
      `Confirmation code: ${p.confirmationCode || ''}`,
      `Payment: ${p.paymentMethod || ''}`,
      `Delivery time: ${p.deliveryTime || ''}`,
      `Accepted: ${p.acceptedAt || ''}`,
      `Customer note: ${p.customerNote || ''}`,
      `Subtotal: ${p.subtotal || ''}`,
      `Delivery fee: ${p.deliveryFee || ''}`,
      `Total: ${p.total || ''}`,
      '',
      'Items:',
      buildItemsText(p),
    ].join('\n');
  }

  function buildAdminNote(payload) {
    const p = sanitizeLegacyPayload(payload);
    const blocks = [];
    const isMoneyOnlyNote = text => /^(?:(?:EUR\s*)?\d+[,.]\d{2}\s*(?:EUR|\u20AC)?|\u20AC\s*\d+[,.]\d{2})$/i.test(normalizeText(text).replace(/[\u22EE\u2026]/g, '').trim());

    const isWolt = p.source === 'wolt' || p.__woltIdentity || normalizeComparableText(p.source || '').includes('wolt');

    if (isWolt) {
      // Đúng thứ tự hiển thị Wolt và giữ nguyên tiếng Đức, có gì ghi nấy:
      if (p.buildingName) blocks.push(`Name des Gebäudes : ${p.buildingName}`);
      if (p.firma) blocks.push(`Firmenname : ${p.firma}`);
      if (p.eingang) blocks.push(`Eingang : ${p.eingang}`);
      if (p.floor) blocks.push(`Etage : ${p.floor}`);
      if (p.apartment) blocks.push(`Wohnung : ${p.apartment}`);
      if (p.codeHaus) blocks.push(`Code Haus : ${p.codeHaus}`);
      if (p.nameNummer) blocks.push(`Name / Nummer : ${p.nameNummer}`);
      if (p.doorNote) blocks.push(`Lieferanweisungen : ${p.doorNote}`);
      if (p.additionalAddressInfo && p.additionalAddressInfo !== p.buildingName && p.additionalAddressInfo !== p.apartment) {
        blocks.push(`Zusätzliche Info : ${p.additionalAddressInfo}`);
      }
      if (p.customerNote && !isMoneyOnlyNote(p.customerNote) && p.customerNote !== p.doorNote) {
        blocks.push(`Kundenanmerkung : ${p.customerNote}`);
      }
    } else {
      if (p.cutlery === 'Có') blocks.push('Bitte mit besteck, Cảm ơn Nhé !');
      if (p.floor) blocks.push(`Haus Nr. / Zimmer / Etage : ${p.floor}`);
      if (p.doorNote && p.doorNote !== p.customerNote) blocks.push(p.doorNote);
      if (p.firma) blocks.push(`Firma: ${p.firma}`);
      if (p.hotel) blocks.push(`Hotel: ${p.hotel}`);
      if (p.codeHaus) blocks.push(`Code Haus: ${p.codeHaus}`);
      if (p.nameNummer) blocks.push(`Name/Nr: ${p.nameNummer}`);
      if (p.additionalAddressInfo) blocks.push(`Thông tin địa chỉ bổ sung: ${p.additionalAddressInfo}`);
      if (p.customerNote && !isMoneyOnlyNote(p.customerNote) && p.customerNote !== p.floor && p.customerNote !== p.doorNote) {
        let cleanNote = p.customerNote;
        if (p.floor) {
          const escFloor = p.floor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleanNote = cleanNote.replace(new RegExp(`(?:Floor|Etage|Stock|Stockwerk|Tầng):\\s*${escFloor}`, 'gi'), '').trim();
          cleanNote = cleanNote.replace(new RegExp(escFloor, 'gi'), '').trim();
        }
        if (p.firma) {
          const escFirma = p.firma.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleanNote = cleanNote.replace(new RegExp(`Firma:\\s*${escFirma}`, 'gi'), '').trim();
          cleanNote = cleanNote.replace(new RegExp(escFirma, 'gi'), '').trim();
        }
        cleanNote = cleanNote.replace(/\s{2,}/g, ' ').trim();
        if (cleanNote) blocks.push(cleanNote);
      }
    }

    const itemsText = buildItemsMultilineText(p);
    if (itemsText) blocks.push(itemsText);
    const dateText = p.deliveryDateNote || p.cardDateNote || p.scheduledDateNote || p.dateNote || p.postItemsNote || '';
    if (dateText) blocks.push(dateText);
    if (!blocks.length) return '.';
    return `.\n${blocks.join('\n')}`;
  }

  function sanitizeOrderCodeForKey(orderCode) {
    return normalizeText(orderCode || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function getBridgeOrderStorageKey(orderCode) {
    const safe = sanitizeOrderCodeForKey(orderCode);
    return safe ? `${BRIDGE_STORAGE_KEY}_${safe}` : BRIDGE_STORAGE_KEY;
  }

  function stripInternalPayloadMeta(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const clone = { ...payload };
    delete clone.__storageKey;
    return clone;
  }

  async function readBridgeOrderIndex() {
    const data = await GM_getValue(BRIDGE_ORDER_INDEX_KEY, []);
    return Array.isArray(data) ? data : [];
  }

  async function writeBridgeOrderIndex(index) {
    const cleaned = Array.isArray(index)
      ? index
        .filter((x) => x && typeof x.key === 'string' && x.key)
        .map((x) => ({
          key: String(x.key),
          orderCode: normalizeText(x.orderCode || ''),
          updatedAt: Number(x.updatedAt || 0),
        }))
      : [];
    await GM_setValue(BRIDGE_ORDER_INDEX_KEY, cleaned);
  }

  async function upsertBridgeOrderIndex(storageKey, orderCode) {
    if (!storageKey || storageKey === BRIDGE_STORAGE_KEY) return;
    const index = await readBridgeOrderIndex();
    const next = index.filter((x) => x.key !== storageKey);
    next.push({ key: storageKey, orderCode: normalizeText(orderCode || ''), updatedAt: now() });
    next.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    await writeBridgeOrderIndex(next.slice(0, 50));
  }

  async function removeBridgeOrderIndex(storageKey) {
    if (!storageKey || storageKey === BRIDGE_STORAGE_KEY) return;
    const index = await readBridgeOrderIndex();
    await writeBridgeOrderIndex(index.filter((x) => x.key !== storageKey));
  }

  async function savePayload(payload, options = {}) {
    const orderCode = normalizeText(payload?.orderCode || '');
    const storageKey = orderCode ? getBridgeOrderStorageKey(orderCode) : BRIDGE_STORAGE_KEY;
    
    // Tự động phân tích địa chỉ 3 lớp (Lớp 1: Ghi chú, Lớp 2: Tên đường, Lớp 3: OpenStreetMap Photon)
    try {
      const parsed = parseTakeawayAddress(payload?.address || '');
      const res = await resolveCityWithDistrictAsync(
        parsed.street,
        parsed.houseNumber,
        parsed.zip,
        parsed.city,
        payload
      );
      if (res && res.city) {
        payload.resolvedCity = res.city;
        payload.district = res.district;
      }
    } catch (_) {}

    const finalPayload = {
      ...stripInternalPayloadMeta(payload),
      __autoFill:     !!options.autoFill,
      __autoSubmit:   !!options.autoSubmit,
      __autoActionAt: (options.autoFill || options.autoSubmit) ? now() : null,
    };
    await GM_setValue(storageKey, finalPayload);
    await GM_setValue(BRIDGE_ACTIVE_ORDER_KEY, storageKey);
    await upsertBridgeOrderIndex(storageKey, orderCode);
    return storageKey;
  }

  async function loadPayload(orderCode = '') {
    const directKey = orderCode ? getBridgeOrderStorageKey(orderCode) : '';
    if (directKey) {
      const directPayload = await GM_getValue(directKey, null);
      if (directPayload) return { ...directPayload, __storageKey: directKey };
    }

    // Electron admin windows are bound to the payload that opened them. Do not
    // follow the mutable global active-order pointer when another source saves
    // a different order at the same time.
    if (!directKey && typeof GM_getAdminPayloadBinding === 'function') {
      try {
        const binding = await GM_getAdminPayloadBinding();
        if (binding && binding.bound) {
          const boundKey = normalizeText(binding.storageKey || '');
          if (!boundKey) return null;
          const boundPayload = await GM_getValue(boundKey, null);
          return boundPayload ? { ...boundPayload, __storageKey: boundKey } : null;
        }
      } catch (_) {}
    }

    const activeKey = await GM_getValue(BRIDGE_ACTIVE_ORDER_KEY, '');
    if (activeKey) {
      const activePayload = await GM_getValue(activeKey, null);
      if (activePayload) return { ...activePayload, __storageKey: activeKey };
    }

    const index = await readBridgeOrderIndex();
    for (const entry of index) {
      const candidate = await GM_getValue(entry.key, null);
      if (candidate) {
        await GM_setValue(BRIDGE_ACTIVE_ORDER_KEY, entry.key);
        return { ...candidate, __storageKey: entry.key };
      }
    }

    const legacyPayload = await GM_getValue(BRIDGE_STORAGE_KEY, null);
    if (legacyPayload) return { ...legacyPayload, __storageKey: BRIDGE_STORAGE_KEY };
    return null;
  }

  async function clearPayload(orderCode = '') {
    const keyFromOrder = orderCode ? getBridgeOrderStorageKey(orderCode) : '';
    const loaded = !keyFromOrder ? await loadPayload() : null;
    const storageKey = keyFromOrder || loaded?.__storageKey || BRIDGE_STORAGE_KEY;
    await GM_deleteValue(storageKey);
    await removeBridgeOrderIndex(storageKey);
    const activeKey = await GM_getValue(BRIDGE_ACTIVE_ORDER_KEY, '');
    if (activeKey === storageKey) await GM_deleteValue(BRIDGE_ACTIVE_ORDER_KEY);
    if (storageKey !== BRIDGE_STORAGE_KEY && !orderCode && loaded?.orderCode) {
      await GM_deleteValue(BRIDGE_STORAGE_KEY);
    }
  }

  function openThaiAsia() { window.open(THAIASIA_URL, '_blank'); }

  function openThaiAsiaInBackground(storageKey = '') {
    try {
      if (typeof GM_openInTab === 'function') {
        const tabRef = GM_openInTab(THAIASIA_URL, {
          active: false,
          insert: true,
          setParent: true,
          storageKey
        });
        return tabRef || true;
      }
    } catch (e) { console.warn('GM_openInTab failed:', e); }
    try {
      const newTab = window.open(THAIASIA_URL, '_blank');
      if (newTab) { try { window.focus(); } catch (_) {} return newTab; }
    } catch (e) { console.warn('window.open fallback failed:', e); }
    return null;
  }

  function startCloseWatcher() {
    if (_closeWatcherTimer) clearInterval(_closeWatcherTimer);
    _closeWatcherTimer = setInterval(async () => {
      const signal = await GM_getValue(CLOSE_TAB_SIGNAL_KEY, null);
      if (signal && now() - signal < 60000) {
        await GM_deleteValue(CLOSE_TAB_SIGNAL_KEY);
        log('Close signal received, closing admin tab');
        if (_adminTabRef) {
          try { if (typeof _adminTabRef.close === 'function') _adminTabRef.close(); } catch (_) {}
          _adminTabRef = null;
        }
        clearInterval(_closeWatcherTimer);
        _closeWatcherTimer = null;
      }
    }, 500);
    setTimeout(() => {
      if (_closeWatcherTimer) { clearInterval(_closeWatcherTimer); _closeWatcherTimer = null; }
    }, AUTO_ACTION_TTL_MS);
  }

  function pageLooksLikeAdminOrderCreate() {
    return /\/admin\/orders\/create\b/i.test(location.pathname);
  }

  function makeButton(id, text, top, bg, onClick) {
    if (document.getElementById(id)) return;
    const btn = document.createElement('button');
    btn.id = id;
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    Object.assign(btn.style, {
      position: 'fixed', right: '20px', top: `${top}px`, zIndex: '999999',
      padding: '12px 16px', border: 'none', borderRadius: '10px',
      background: bg, color: '#fff', fontWeight: '700', fontSize: '14px',
      cursor: 'pointer', boxShadow: '0 10px 28px rgba(0,0,0,.18)',
    });
    document.body.appendChild(btn);
  }

  function normalizeDecimalDotString(value) {
    const text = normalizeText(value);
    if (!text) return '';
    if (/^-?\d+([.]\d+)?$/.test(text)) return text;
    if (/^-?\d+([,]\d+)?$/.test(text)) return text.replace(',', '.');
    return text.replace(/,/g, '.');
  }

  function parseMoneyToNumberString(value) {
    let text = normalizeText(value);
    if (!text) return '';
    text = text.replace(/EUR/gi, '').replace(/\s+/g, '').replace(/[^\d,.-]/g, '');
    const hasDot = text.includes('.');
    const hasComma = text.includes(',');
    if (hasDot && hasComma) {
      if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
        text = text.replace(/\./g, '').replace(',', '.');
      } else {
        text = text.replace(/,/g, '');
      }
    } else if (hasComma) {
      text = text.replace(',', '.');
    } else if (hasDot) {
      if (!/^-?\d+\.\d+$/.test(text)) text = text.replace(/\./g, '');
    }
    return normalizeDecimalDotString(text);
  }

  // Dành riêng cho <input type="number"> bị admin làm tròn integer khi dùng events thông thường.
  // Dùng execCommand('insertText') để mô phỏng gõ phím thực — framework không thể coerce.
  function setNumberFieldValue(el, value) {
    if (!el) return false;
    const newValue  = String(value ?? '');
    const oldValue  = String(el.value ?? '');
    try { el.focus(); } catch (_) {}
    try { el.click(); } catch (_) {}
    // Xoá nội dung cũ rồi chèn giá trị mới như user đang gõ thực sự
    try {
      el.select();
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, newValue);
      if (ok && String(el.value) === newValue) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
        return normalizeText(oldValue) !== normalizeText(newValue);
      }
    } catch (_) {}
    // Fallback: native setter nếu execCommand không được hỗ trợ
    const prototype  = Object.getPrototypeOf(el);
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor && descriptor.set) descriptor.set.call(el, newValue);
    else el.value = newValue;
    try { el.setAttribute('value', newValue); } catch (_) {}
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
    return normalizeText(oldValue) !== normalizeText(newValue);
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    const isNumberInput = el.tagName.toLowerCase() === 'input' &&
      (el.getAttribute('type') || '').toLowerCase() === 'number';
    const newValue = String(isNumberInput ? normalizeDecimalDotString(value) : (value ?? ''));
    const oldValue = String(el.value ?? '');
    try { el.focus(); } catch (_) {}
    const prototype   = Object.getPrototypeOf(el);
    const descriptor  = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null;
    if (descriptor && descriptor.set) {
      descriptor.set.call(el, newValue);
    } else {
      el.value = newValue;
    }
    try { el.setAttribute('value', newValue); } catch (_) {}
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur',   { bubbles: true }));
    return normalizeText(oldValue) !== normalizeText(newValue);
  }

  function setSelectValue(selectEl, desiredCandidates) {
    if (!selectEl || !desiredCandidates?.length) return false;
    const oldValue = String(selectEl.value ?? '');
    const normalizedCandidates = desiredCandidates.map(normalizeComparableText);
    const options = [...selectEl.options];
    let matchedOption = null;
    for (const option of options) {
      const optionText  = normalizeComparableText(option.textContent || option.innerText || '');
      const optionValue = normalizeComparableText(option.value || '');
      if (normalizedCandidates.includes(optionText) || normalizedCandidates.includes(optionValue)) {
        matchedOption = option; break;
      }
    }
    if (!matchedOption) {
      for (const option of options) {
        const optionText  = normalizeComparableText(option.textContent || option.innerText || '');
        const optionValue = normalizeComparableText(option.value || '');
        const hit = normalizedCandidates.some(
          (c) => optionText.includes(c) || c.includes(optionText) || optionValue.includes(c) || c.includes(optionValue)
        );
        if (hit) { matchedOption = option; break; }
      }
    }
    if (!matchedOption) { log('No matching option found for select', selectEl, desiredCandidates); return false; }
    for (const opt of options) opt.selected = false;
    matchedOption.selected = true;
    const proto = Object.getPrototypeOf(selectEl);
    const desc  = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && desc.set) { desc.set.call(selectEl, matchedOption.value); } else { selectEl.value = matchedOption.value; }
    const tracker = selectEl._valueTracker;
    if (tracker) tracker.setValue(oldValue);
    selectEl.dispatchEvent(new Event('input',  { bubbles: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
    selectEl.dispatchEvent(new Event('blur',   { bubbles: true }));
    return normalizeText(oldValue) !== normalizeText(matchedOption.value);
  }

  function setChoiceFieldValue(el, desiredCandidates) {
    if (!el || !desiredCandidates?.length) return false;
    if (el.tagName.toLowerCase() === 'select') return setSelectValue(el, desiredCandidates);
    return setNativeValue(el, desiredCandidates[0]);
  }

  function scheduleCustomDropdownSet(labelText, desiredText, delayMs) {
    setTimeout(() => {
      if (isDropdownAlreadySet(labelText, desiredText)) { log(`customDropdown: "${labelText}" already set`); return; }
      log(`customDropdown: trying "${labelText}" = "${desiredText}"`);
      if (trySetViaFormInstance(labelText, desiredText)) { log('customDropdown: SUCCESS via Form.setFieldsValue'); return; }
      if (trySetViaReactFiber(labelText, desiredText))   { log('customDropdown: SUCCESS via React fiber onChange'); return; }
      const clickTarget = findDropdownClickable(labelText);
      if (clickTarget) {
        clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        clickTarget.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
        clickTarget.click();
        setTimeout(() => { clickDropdownOption(desiredText); }, 500);
      }
      let retries = 0;
      const retryTimer = setInterval(() => {
        retries++;
        if (retries > 10) { clearInterval(retryTimer); return; }
        if (isDropdownAlreadySet(labelText, desiredText)) { log(`customDropdown: confirmed set on retry ${retries}`); clearInterval(retryTimer); return; }
        if (trySetViaFormInstance(labelText, desiredText) || trySetViaReactFiber(labelText, desiredText)) {
          log(`customDropdown: SUCCESS on retry ${retries}`); clearInterval(retryTimer);
        }
      }, 500);
    }, delayMs);
  }

  function trySetViaFormInstance(labelText, desiredText) {
    const formEl = document.querySelector('form') || document.querySelector('[class*="ant-form"]');
    if (!formEl) { log('formInstance: no form element'); return false; }
    const fiberKey = Object.keys(formEl).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!fiberKey) { log('formInstance: no fiber on form'); return false; }
    let fiber = formEl[fiberKey];
    for (let i = 0; i < 60 && fiber; i++) {
      const inst = fiber.stateNode;
      if (inst && typeof inst.setFieldsValue === 'function') return callFormSetFields(inst, labelText, desiredText, 'stateNode');
      const props = fiber.memoizedProps || {};
      if (props.form && typeof props.form.setFieldsValue === 'function') return callFormSetFields(props.form, labelText, desiredText, 'props.form');
      let hookState = fiber.memoizedState;
      for (let h = 0; h < 20 && hookState; h++) {
        const mem = hookState.memoizedState;
        if (mem && typeof mem === 'object') {
          if (typeof mem.setFieldsValue === 'function') return callFormSetFields(mem, labelText, desiredText, 'hook.memoizedState');
          if (mem.current && typeof mem.current.setFieldsValue === 'function') return callFormSetFields(mem.current, labelText, desiredText, 'hook.current');
        }
        hookState = hookState.next;
      }
      if (fiber.ref && fiber.ref.current && typeof fiber.ref.current.setFieldsValue === 'function') return callFormSetFields(fiber.ref.current, labelText, desiredText, 'ref.current');
      fiber = fiber.return;
    }
    log('formInstance: no form instance in fiber tree'); return false;
  }

  function callFormSetFields(formInstance, labelText, desiredText, source) {
    try {
      const currentValues = typeof formInstance.getFieldsValue === 'function' ? formInstance.getFieldsValue() : {};
      log(`formInstance(${source}): current form values =`, JSON.stringify(currentValues));
      const possibleFieldNames = ['shippingMethod','shipping_method','shippingmethod','deliveryMethod','delivery_method','deliverymethod','ship_method','shipMethod','method','shipping','delivery','type'];
      let fieldName = null;
      for (const key of Object.keys(currentValues)) {
        const val = (currentValues[key] || '').toString().toLowerCase();
        if (possibleFieldNames.includes(key.toLowerCase()) || val === 'lấy tại quán' || val === 'lay tai quan' || val === 'pickup' || val === '1' || val === '0') {
          fieldName = key; break;
        }
      }
      if (!fieldName) { for (const name of possibleFieldNames) { if (name in currentValues) { fieldName = name; break; } } }
      if (!fieldName) { log('formInstance: could not determine field name'); log('formInstance: available fields =', Object.keys(currentValues).join(', ')); return false; }
      for (const val of [desiredText, 2, '2', 'delivery', 1, '1']) {
        formInstance.setFieldsValue({ [fieldName]: val });
        if (typeof formInstance.getFieldValue === 'function') {
          const newVal = formInstance.getFieldValue(fieldName);
          if (newVal === val) { log(`formInstance: verified value = ${JSON.stringify(newVal)}`); return true; }
        } else { return true; }
      }
      return false;
    } catch (e) { log(`formInstance(${source}): error`, e.message); return false; }
  }

  function trySetViaReactFiber(labelText, desiredText) {
    const normalized = desiredText.trim().toLowerCase();
    const selectEl = findAntSelectElement(labelText);
    if (!selectEl) { log('reactFiber: no select element'); return false; }
    const candidates = [selectEl, ...selectEl.querySelectorAll('*')];
    for (const el of candidates) {
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (!fiberKey) continue;
      let fiber = el[fiberKey];
      for (let i = 0; i < 30 && fiber; i++) {
        const props = fiber.memoizedProps || fiber.pendingProps || {};
        if (typeof props.onChange === 'function') {
          let targetValue = desiredText;
          const options = props.options || [];
          if (Array.isArray(options)) {
            for (const opt of options) {
              if (!opt || typeof opt !== 'object') continue;
              const label = (opt.label || opt.title || opt.children || '').toString().trim().toLowerCase();
              if (label === normalized) { targetValue = opt.value !== undefined ? opt.value : opt.key; break; }
            }
          }
          try { props.onChange(targetValue, { label: desiredText, value: targetValue }); log(`reactFiber: called onChange(${JSON.stringify(targetValue)})`); return true; }
          catch (e) { log('reactFiber: onChange error', e.message); }
        }
        fiber = fiber.return;
      }
    }
    log('reactFiber: no onChange found'); return false;
  }

  function findAntSelectElement(labelText) {
    for (const textNode of getTextNodesWithExactText(document.body, labelText)) {
      const labelEl = textNode.parentElement;
      if (!labelEl || !isVisible(labelEl)) continue;
      let parent = labelEl;
      for (let i = 0; i < 8; i++) {
        parent = parent.parentElement;
        if (!parent || parent === document.body) break;
        const el = parent.querySelector('.ant-select, [class*="ant-select"], [role="combobox"]');
        if (el) return el;
      }
    }
    return null;
  }

  function isDropdownAlreadySet(labelText, desiredText) {
    const normalized = desiredText.trim().toLowerCase();
    for (const textNode of getTextNodesWithExactText(document.body, labelText)) {
      const labelEl = textNode.parentElement;
      if (!labelEl || !isVisible(labelEl)) continue;
      let parent = labelEl;
      for (let i = 0; i < 8; i++) {
        parent = parent.parentElement;
        if (!parent || parent === document.body) break;
        const sel = parent.querySelector('.ant-select-selection-item, [class*="selection-item"], [class*="select-selection"]');
        if (sel) {
          const text = (sel.textContent || sel.innerText || '').trim().toLowerCase();
          if (text === normalized) return true;
        }
      }
    }
    return false;
  }

  function findDropdownClickable(labelText) {
    for (const textNode of getTextNodesWithExactText(document.body, labelText)) {
      const labelEl = textNode.parentElement;
      if (!labelEl || !isVisible(labelEl)) continue;
      let parent = labelEl;
      for (let i = 0; i < 8; i++) {
        parent = parent.parentElement;
        if (!parent || parent === document.body) break;
        const dropdown = parent.querySelector('.ant-select, [class*="ant-select"], [role="combobox"]');
        if (dropdown && isVisible(dropdown)) {
          return dropdown.querySelector('.ant-select-selector, [class*="selector"]') || dropdown;
        }
      }
    }
    return null;
  }

  function clickDropdownOption(desiredText) {
    const normalized = desiredText.trim().toLowerCase();
    const selectors = ['.ant-select-item-option', '.ant-select-item', '[class*="ant-select-item"]', '[role="option"]', '.rc-virtual-list-holder-inner > div'];
    for (const sel of selectors) {
      for (const opt of document.querySelectorAll(sel)) {
        if (!isVisible(opt)) continue;
        const text = (opt.textContent || opt.innerText || '').trim().toLowerCase();
        if (text === normalized) {
          opt.scrollIntoView({ block: 'nearest' });
          opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          opt.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
          opt.click();
          return true;
        }
      }
    }
    return false;
  }

  function parseGermanStreet(rawStreet) {
    const text = normalizeText(rawStreet);
    if (!text) return { street: '', houseNumber: '' };
    const m = text.match(/^(.*?)(\d+\s*[a-zA-Z\-\/]*)$/);
    if (m) return { street: normalizeText(m[1].replace(/[,\-]+$/, '')), houseNumber: normalizeText(m[2]) };
    return { street: text, houseNumber: '' };
  }

  function parseTakeawayAddress(address) {
    const raw = cleanAddress(address);
    const out = { full: raw, zip: '', city: '', streetLine: '', street: '', houseNumber: '' };
    if (!raw) return out;
    let m = raw.match(/^(\d{5})\s+([^,]+),\s*(.+)$/);
    if (m) {
      out.zip = normalizeText(m[1]); out.city = normalizeText(m[2]); out.streetLine = normalizeText(m[3]);
      const s = parseGermanStreet(out.streetLine); out.street = s.street; out.houseNumber = s.houseNumber; return out;
    }
    m = raw.match(/^(.+),\s*(\d{5})\s+(.+)$/);
    if (m) {
      out.streetLine = normalizeText(m[1]); out.zip = normalizeText(m[2]); out.city = normalizeText(m[3]);
      const s = parseGermanStreet(out.streetLine); out.street = s.street; out.houseNumber = s.houseNumber; return out;
    }
    const s = parseGermanStreet(raw); out.street = s.street; out.houseNumber = s.houseNumber; return out;
  }

  const KNOWN_DISTRICTS_REGEX = /(?:Zwebendorf|Reußen|Reussen|Oppin|Untermaschwitz|Obermaschwitz|Maschwitz|Braschwitz|Peißen|Peissen|Niemberg|Queis|Gütz|Guetz|Spickendorf|Lohnsdorf|Plößnitz|Ploessnitz|Sietzsch|Bageritz|Gollma|Hohenthurm|Klepzig|Kockwitz|Rabatz|Schwerz|Dammendorf|Roitzsch|Dautzsch|Büschdorf|Bueschdorf|Kanena|Bruckdorf|Reideburg|Diemitz|Zwintschöna|Zwintschoena|Dieskau|Gröbers|Groebers|Osmünde|Osmuende|Gottenz|Schwoitsch|Benndorf|Beesenstedt|Schkeuditz|Teutschenthal|Salzmünde|Salzmuende|Merseburg|Ammendorf|Silberhöhe|Silberhoehe|Trotha|Kröllwitz|Kroellwitz|Giebichenstein|Nietleben|Lettin|Mötzlich|Moetzlich|Tornau|Seeben)/i;

  const LOCAL_LANDSBERG_STREETS = {
    'am teich': 'Zwebendorf',
    'am unteren teich': 'Maschwitz',
    'am alten teich': 'Braschwitz',
    'zwebendorfer str': 'Reussen',
    'reussener str': 'Zwebendorf',
    'alte hallesche str': 'Peissen',
    'hallerspring': 'Oppin',
    'flugplatzstr': 'Oppin',
    'sandweg': 'Zwebendorf',
  };

  const GEO_DISTRICT_CACHE = new Map();

  function normalizeStreetLookupKey(str) {
    return (str || '')
      .toLowerCase()
      .replace(/straße/g, 'str')
      .replace(/strasse/g, 'str')
      .replace(/[.,\-\/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function resolveCityWithDistrict(street, houseNumber, zip, city, payload) {
    if (payload?.resolvedCity) {
      return { street, houseNumber, zip, city: payload.resolvedCity, district: payload.district || '' };
    }
    let district = '';
    
    // 1. Quét tự động từ ghi chú / apartment / additionalAddressInfo / address / customerNote (Lieferando, UberEats, Wolt)
    const fullText = [
      payload?.note,
      payload?.apartment,
      payload?.additionalAddressInfo,
      payload?.address,
      payload?.customerNote,
      payload?.nameNummer,
      payload?.floor,
      payload?.company,
      payload?.doorCode
    ].filter(Boolean).join(' ');
    
    const match = fullText.match(KNOWN_DISTRICTS_REGEX);
    if (match) {
      district = normalizeText(match[0]);
    }
    
    // 2. Nếu ở 06188 Landsberg mà chưa có tên làng: tự động tra cứu danh mục đường đặc thù
    const cleanStreet = normalizeStreetLookupKey(street);
    const cleanZip = (zip || '').trim();
    const cleanCity = (city || '').toLowerCase().trim();
    if (!district && (cleanZip === '06188' || cleanCity.includes('landsberg'))) {
      for (const [sKey, dName] of Object.entries(LOCAL_LANDSBERG_STREETS)) {
        if (cleanStreet.includes(sKey) || sKey.includes(cleanStreet)) {
          district = dName;
          break;
        }
      }
    }

    // 3. Chuẩn hóa tên thành phố kèm tên làng chuẩn Đức: [City] OT [District]
    let finalCity = city || (cleanZip === '06188' ? 'Landsberg' : 'Halle (Saale)');
    if (district && !finalCity.toLowerCase().includes('ot ') && !finalCity.toLowerCase().includes(district.toLowerCase())) {
      finalCity = finalCity + ' OT ' + district;
    }
    
    return { street, houseNumber, zip, city: finalCity, district };
  }

  async function resolveCityWithDistrictAsync(street, houseNumber, zip, city, payload) {
    const syncRes = resolveCityWithDistrict(street, houseNumber, zip, city, payload);
    if (syncRes.district) return syncRes;

    const cleanStreet = normalizeStreetLookupKey(street);
    const cleanZip = (zip || '').trim();
    const cleanCity = (city || '').toLowerCase().trim();

    if ((cleanZip === '06188' || cleanCity.includes('landsberg')) && cleanStreet) {
      const cacheKey = `${cleanStreet}_${houseNumber || ''}_${cleanZip}`.trim();
      if (GEO_DISTRICT_CACHE.has(cacheKey)) {
        const cachedDistrict = GEO_DISTRICT_CACHE.get(cacheKey);
        if (cachedDistrict) {
          let finalCity = city || 'Landsberg';
          if (!finalCity.toLowerCase().includes('ot ')) finalCity = `${finalCity} OT ${cachedDistrict}`;
          return { street, houseNumber, zip, city: finalCity, district: cachedDistrict };
        }
      }

      try {
        const q = [street, houseNumber, zip, city || 'Landsberg'].filter(Boolean).join(' ');
        const url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(q) + '&lat=51.4828&lon=11.9696&limit=3';
        let jsonText = '';

        if (typeof window !== 'undefined' && typeof window.GM_xmlhttpRequest === 'function') {
          try {
            const resp = await window.GM_xmlhttpRequest({ url, method: 'GET', timeout: 3000 });
            jsonText = resp?.responseText || resp?.data || '';
          } catch (_) {}
        }
        if (!jsonText && typeof fetch === 'function') {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (res.ok) jsonText = await res.text();
          } catch (_) {}
        }

        if (jsonText) {
          const data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
          const feat = data.features?.[0]?.properties;
          const geoDistrict = feat?.district || feat?.locality || feat?.suburb || '';
          if (geoDistrict) {
            const gMatch = geoDistrict.match(KNOWN_DISTRICTS_REGEX);
            const district = gMatch ? normalizeText(gMatch[0]) : normalizeText(geoDistrict);
            GEO_DISTRICT_CACHE.set(cacheKey, district);
            let finalCity = city || 'Landsberg';
            if (!finalCity.toLowerCase().includes('ot ')) finalCity = `${finalCity} OT ${district}`;
            return { street, houseNumber, zip, city: finalCity, district };
          }
        }
      } catch (_) {}
    }

    return syncRes;
  }

  function extractMoneyValue(text) {
    const raw = normalizeText(text);
    if (!raw) return '';
    const match = raw.match(/EUR\s*\d+[.,]\d{2}/i);
    return match ? normalizeText(match[0]) : '';
  }

  function extractMoneyNearLabel(lines, labelRegex) {
    const normalized = lines.map(normalizeText).filter(Boolean);
    for (let i = 0; i < normalized.length; i++) {
      if (!labelRegex.test(normalized[i])) continue;
      const sameLineMoney = extractMoneyValue(normalized[i]);
      if (sameLineMoney) return sameLineMoney;
      for (let offset = 1; offset <= 3; offset++) {
        const money = extractMoneyValue(normalized[i + offset]);
        if (money) return money;
      }
    }
    return '';
  }

  function extractTotalsFromRawText(rawText) {
    const lines = String(rawText || '').replace(/\u00A0/g, ' ').split('\n').map(normalizeText).filter(Boolean);
    return {
      subtotal:    extractMoneyNearLabel(lines, /^Zwischensumme\b/i),
      deliveryFee: extractMoneyNearLabel(lines, /^Liefergebühr\b/i),
      total:       extractMoneyNearLabel(lines, /^Gesamt\b/i),
    };
  }

  function textContainsOrderCode(text, orderCode) {
    const code = normalizeText(orderCode || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (!code) return false;
    const normalized = normalizeText(text || '').toUpperCase();
    return new RegExp(`(?:^|[^A-Z0-9])#?${code}(?=$|[^A-Z0-9])`).test(normalized);
  }

  function findOrderPanel(expectedOrderCode = '') {
    const candidates = [...document.querySelectorAll('aside, section, div')].filter((el) => {
      if (!isVisible(el)) return false;
      const text = normalizeText(stripUiNoise(el.innerText || ''));
      if (text.length < 80) return false;
      const hasOrderSignals = /Bestellung angenommen|Bestätigungscode|Zwischensumme|Liefergebühr|Gesamt/i.test(text);
      const hasPhone = /\+\d[\d\s\-\/]{6,}/.test(text);
      const hasItems = /\d+\s+(Gerichte|Artikel)/i.test(text);
      const panelOrderCodes = [...new Set(
        [...text.matchAll(/#([A-Z0-9]{5,8})\b/gi)].map((match) => normalizeText(match[1]).toUpperCase())
      )];
      const hasUnambiguousIdentity = panelOrderCodes.length === 1;
      const identityMatches = !expectedOrderCode
        || (hasUnambiguousIdentity && panelOrderCodes[0] === normalizeText(expectedOrderCode).toUpperCase());
      return hasOrderSignals && (hasPhone || hasItems) && hasUnambiguousIdentity && identityMatches;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const sA = (ra.left > window.innerWidth * 0.4 ? 2000 : 0) + (ra.width > 350 ? 300 : 0) + (ra.height > 250 ? 300 : 0);
      const sB = (rb.left > window.innerWidth * 0.4 ? 2000 : 0) + (rb.width > 350 ? 300 : 0) + (rb.height > 250 ? 300 : 0);
      return sB - sA;
    });
    return candidates[0];
  }

  function textLinesFrom(el) {
    return uniq(String(el?.innerText || el?.textContent || '').split('\n').map(stripUiNoise).map(normalizeText));
  }

  function findByRegex(lines, regex, groupIndex = 1) {
    for (const line of lines) {
      const match = line.match(regex);
      if (match) return normalizeText(match[groupIndex] || match[0] || '');
    }
    return '';
  }

  function extractDeliveryTime(lines, fullText) {
    const nLines = lines.map(normalizeText).filter(Boolean);
    for (let i = 0; i < nLines.length; i++) {
      const line = nLines[i];
      if (/^\d{1,2}:\d{2}$/.test(line)) {
        const around = [nLines[i+1], nLines[i+2], nLines[i+3]].map(normalizeText).join(' ');
        if (/(Lieferung|Abholung|delivery|pickup)/i.test(around)) return line;
      }
    }
    for (const line of nLines) { if (/^ASAP$/i.test(line)) return 'ASAP'; }
    const fullMatches = [...String(fullText || '').matchAll(/\b(\d{1,2}:\d{2})\b/g)].map(m => normalizeText(m[1])).filter(Boolean);
    if (fullMatches.length) return fullMatches[0];
    if (/\bASAP\b/i.test(String(fullText || ''))) return 'ASAP';
    return '';
  }

  function extractPaymentMethod(lines, panelEl, rawPanelText) {
    const nLines = lines.map(normalizeText).filter(Boolean);
    for (const line of nLines) { const p = normalizePaymentMethod(line); if (p && /^(bar|online)$/i.test(normalizeText(line))) return p; }
    for (const line of nLines.slice(0, 25)) { const p = normalizePaymentMethod(line); if (p) return p; }
    if (panelEl) {
      for (const el of [...panelEl.querySelectorAll('span, div, p, button')].filter(el => isVisible(el))) {
        const text = normalizeText(el.textContent || '');
        if (/^(bar|online)$/i.test(text)) return normalizePaymentMethod(text);
      }
    }
    const raw = String(rawPanelText || '');
    if (/\bonline\b/i.test(raw)) return 'Online';
    if (/\bbar\b/i.test(raw)) return 'Bar';
    return '';
  }

  function isTotalsStartLine(line) { return /^(Zwischensumme|Liefergebühr|Servicegebühr|Gesamt|Bezahlt mit)\b/i.test(line); }
  function isPaymentBadgeLine(line) { return /^(Bar|Online)$/i.test(line); }
  function isQtyOnlyLine(line) { return /^\d+$/.test(line); }
  function isCodeTitleLine(line) { return /^([^.\n]+)\.\s*/i.test(normalizeText(line)); }
  function isInlineItemLine(line) { return /^\d+\s+([^.\n]+)\.\s*/i.test(normalizeText(line)); }

  function parseInlineItemLine(line) {
    const m = normalizeText(line).match(/^(\d+)\s+([^.\n]+)\.\s*(.*)$/i);
    if (!m) return null;
    return { qty: normalizeText(m[1]), code: normalizeText(m[2]), name: normalizeText(m[3] || '') };
  }

  function parseSeparatedItemLine(qtyLine, codeTitleLine) {
    const qty = normalizeText(qtyLine);
    const m = normalizeText(codeTitleLine).match(/^([^.\n]+)\.\s*(.*)$/i);
    if (!qty || !m) return null;
    return { qty, code: normalizeText(m[1]), name: normalizeText(m[2] || '') };
  }

  function sliceItemSectionLines(rawText) {
    const lines = String(rawText || '').replace(/\u00A0/g, ' ').split('\n').map(stripUiNoise).map(normalizeText).filter(Boolean);
    const startIndex = lines.findIndex(line => /^\d+\s+(Gerichte|Artikel)$/i.test(line));
    if (startIndex === -1) return [];
    let endIndex = lines.findIndex((line, idx) => idx > startIndex && /^Zwischensumme\b/i.test(line));
    if (endIndex === -1) endIndex = lines.length;
    return lines.slice(startIndex + 1, endIndex);
  }

  function extractCustomerNote(rawText) {
    const lines = String(rawText || '').replace(/\u00A0/g, ' ').split('\n').map(stripUiNoise).map(normalizeText).filter(Boolean);
    if (!lines.length) return '';
    const itemsIdx = lines.findIndex(line => /^\d+\s+(Gerichte|Artikel)$/i.test(line));
    if (itemsIdx === -1) return '';
    const markers = [
      lines.findIndex(line => /Bestätigungscode:\s*[0-9]+/i.test(line)),
      lines.findIndex(line => /\+\d[\d\s\-\/]{6,}/.test(line)),
      lines.findIndex(line => /Bestellung angenommen um/i.test(line)),
    ].filter(idx => idx !== -1);
    const startIdx = markers.length ? Math.max(...markers) : -1;
    const noteLines = [];
    for (let i = startIdx + 1; i < itemsIdx; i++) {
      const line = lines[i];
      if (!line) continue;
      if (/^Bestätigungscode:/i.test(line)) continue;
      if (/\+\d[\d\s\-\/]{6,}/.test(line)) continue;
      if (/^#?[A-Z0-9]{5,}$/i.test(line)) continue;
      if (/^(Bar|Online)$/i.test(line)) continue;
      if (/^ASAP$/i.test(line)) continue;
      if (/^\d{1,2}:\d{2}$/.test(line)) continue;
      if (/^(Lieferung|Abholung|delivery|pickup)$/i.test(line)) continue;
      if (/^Firma:/i.test(line)) continue;
      if (/^Hotel:/i.test(line)) continue;
      if (/^Code Haus:/i.test(line)) continue;
      if (/^Name\/Nr:/i.test(line)) continue;
      if (/^(Floor|Etage|Stock|Stockwerk|Tầng):/i.test(line)) continue;
      if (/^(Zimmer|Wohnung|Apartment|Eingang|Building|Gebäude):/i.test(line)) continue;
      if (/^\d{5}\s+[^,]+,\s*.+$/i.test(line)) continue;
      if (/^(Guest|Gast)$/i.test(line)) continue;
      if (/^\d+\s+(Gerichte|Artikel)$/i.test(line)) continue;
      if (/^Zwischensumme\b/i.test(line)) continue;
      if (/^Liefergebühr\b/i.test(line)) continue;
      if (/^Gesamt\b/i.test(line)) continue;
      if (/^EUR\s*\d+[.,]\d{2}$/i.test(line)) continue;
      noteLines.push(line);
    }
    return normalizeText(uniq(noteLines).join(' '));
  }

  function isLikelyCustomerName(line) {
    const text = stripUiNoise(line);
    if (!text) return false;
    if (text.length > 80) return false;
    const isSingleLetterName = /^\p{L}$/u.test(text);
    if (text.length < 2 && !isSingleLetterName) return false;
    const normalized = normalizeComparableText(text);
    const blockedExact = new Set(['live orders','ihre bestellungen','lieferando','home','drucken','uberegabe','ubergabe','zubereiten','fertig','online','bar','asap','guest','gast','deutsch','abmeldung']);
    if (blockedExact.has(normalized)) return false;
    if (/\+\d[\d\s\-\/]{6,}/.test(text)) return false;
    if (/Bestätigungscode:\s*\d+/i.test(text)) return false;
    if (/^\+?\d/.test(text)) return false;
    if (/#/.test(text)) return false;
    if (/\bEUR\b/i.test(text)) return false;
    if (/^\d{1,2}:\d{2}$/.test(text)) return false;
    if (/^(Bar|Online)$/i.test(text)) return false;
    if (/^(Guest|Gast)$/i.test(text)) return false;
    if (/^(Firma|Hotel|Code Haus|Name\/Nr):/i.test(text)) return false;
    if (/^(Lieferung|Abholung|delivery|pickup|ASAP)$/i.test(text)) return false;
    if (/^(Bestellung angenommen|Bestätigungscode|Zwischensumme|Liefergebühr|Servicegebühr|Gesamt|Gerichte|Artikel)\b/i.test(text)) return false;
    if (/^\d+\s+(Gerichte|Artikel)$/i.test(text)) return false;
    if (/^\d{5}\s+[^,]+,\s*.+$/i.test(text)) return false;
    if (/^[\d\s\-+()\/.,]+$/.test(text)) return false;
    if (/^[A-Z0-9]{5,}$/i.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean);
    // Corporate Lieferando accounts can expose a contact/display name with a
    // company prefix (for example "Schaeffler Vehicle Lifetime So Amrei
    // Lages"). Five words was too strict and discarded an otherwise valid name.
    // Other guards above still reject addresses, Firma labels, codes and totals.
    if (words.length < 1 || words.length > 10) return false;
    if (words.filter(w => /\p{L}/u.test(w)).length < 1) return false;
    if (normalized.includes('bestellung') || normalized.includes('liefergebuhr') || normalized.includes('zwischensumme') || normalized.includes('bestatigungscode')) return false;
    return true;
  }

  function isPhoneOrConfirmationLine(text) {
    const t = normalizeText(text);
    return /\+\d[\d\s\-\/]{6,}/.test(t) || /Bestätigungscode:\s*[0-9]+/i.test(t);
  }

  function normalizeLooseNameCandidate(value) {
    const cleaned = normalizeText(value).replace(/[,:;.|-]+$/g, '');
    if (!cleaned) return '';
    if (/\+\d[\d\s\-\/]{6,}/.test(cleaned)) return '';
    if (/Bestätigungscode:\s*\d+/i.test(cleaned)) return '';
    if (/^\+?\d/.test(cleaned)) return '';
    if (!/\p{L}/u.test(cleaned)) return '';
    if (cleaned.length > 40) return '';
    return cleaned;
  }

  function extractNameFromMixedLine(line) {
    const raw = normalizeText(stripUiNoise(line));
    if (!raw) return '';
    let m = raw.match(/^(.+?)\s+\+\d[\d\s\-\/]{6,}(?:\s+Bestätigungscode:\s*\d+)?$/i);
    if (m) { const c = normalizeText(m[1]); if (isLikelyCustomerName(c)) return c; }
    m = raw.match(/^(.+?)\s+Bestätigungscode:\s*\d+$/i);
    if (m) { const c = normalizeText(m[1]); if (isLikelyCustomerName(c)) return c; }
    const phoneMatch = raw.match(/\+\d[\d\s\-\/]{6,}/);
    if (phoneMatch && phoneMatch.index > 0) {
      const c = normalizeText(raw.slice(0, phoneMatch.index));
      if (isLikelyCustomerName(c)) return c;
      const lc = normalizeLooseNameCandidate(c);
      if (lc) return lc;
    }
    const confirmMatch = raw.match(/\bBestätigungscode:\s*\d+/i);
    if (confirmMatch && confirmMatch.index > 0) {
      const c = normalizeText(raw.slice(0, confirmMatch.index));
      if (isLikelyCustomerName(c)) return c;
      const lc = normalizeLooseNameCandidate(c);
      if (lc) return lc;
    }
    return '';
  }

  function extractCustomerNameFallback(rawText) {
    const lines = String(rawText || '').replace(/\u00A0/g, ' ').split('\n').map(stripUiNoise).map(normalizeText).filter(Boolean);
    for (const line of lines) {
      const phonePos = line.search(/\+\d[\d\s\-\/]{6,}/);
      if (phonePos <= 0) continue;
      const beforePhone = normalizeLooseNameCandidate(line.slice(0, phonePos));
      if (beforePhone) return beforePhone;
    }
    return '';
  }

  function getOwnTextLines(el) {
    if (!el || !(el instanceof Element)) return [];
    return String(el.innerText || el.textContent || '').split('\n').map(stripUiNoise).map(normalizeText).filter(Boolean);
  }

  function extractCustomerNameFromStructuredBlocks(panelEl) {
    if (!panelEl) return '';
    for (const block of [...panelEl.querySelectorAll('div, section, article, aside, li')].filter(el => isVisible(el))) {
      const lines = getOwnTextLines(block);
      if (!lines.length) continue;
      for (let i = 0; i < lines.length; i++) {
        const inlineName = extractNameFromMixedLine(lines[i]);
        if (inlineName) return inlineName;
        if (isPhoneOrConfirmationLine(lines[i])) {
          for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
            if (isLikelyCustomerName(lines[j])) return lines[j];
          }
        }
      }
    }
    return '';
  }

  function extractCustomerNameFromRawText(rawText) {
    const lines = String(rawText || '').replace(/\u00A0/g, ' ').split('\n').map(stripUiNoise).map(normalizeText).filter(Boolean);
    if (!lines.length) return '';
    for (const line of lines) { const n = extractNameFromMixedLine(line); if (n) return n; }
    const phoneIdx = lines.findIndex(l => /\+\d[\d\s\-\/]{6,}/.test(l));
    if (phoneIdx > 0) { for (let i = phoneIdx - 1; i >= Math.max(0, phoneIdx - 5); i--) { if (isLikelyCustomerName(lines[i])) return lines[i]; } }
    const confirmIdx = lines.findIndex(l => /Bestätigungscode:\s*[0-9]+/i.test(l));
    if (confirmIdx > 0) { for (let i = confirmIdx - 1; i >= Math.max(0, confirmIdx - 5); i--) { if (isLikelyCustomerName(lines[i])) return lines[i]; } }
    const acceptedIdx = lines.findIndex(l => /Bestellung angenommen um/i.test(l));
    if (acceptedIdx > 0) { for (let i = acceptedIdx - 1; i >= Math.max(0, acceptedIdx - 5); i--) { if (isLikelyCustomerName(lines[i])) return lines[i]; } }
    const itemsIdx = lines.findIndex(l => /^\d+\s+(Gerichte|Artikel)$/i.test(l));
    if (itemsIdx > 0) {
      for (let i = 0; i < itemsIdx; i++) {
        if (isLikelyCustomerName(lines[i]) && i + 1 < lines.length && /\+\d[\d\s\-\/]{6,}/.test(lines[i + 1])) return lines[i];
      }
    }
    return '';
  }

  function extractCustomerNameFromDom(panelEl) {
    if (!panelEl) return '';
    const candidates = [...panelEl.querySelectorAll('div, span, p, h1, h2, h3, h4, h5, strong')].filter(el => isVisible(el));
    for (const el of candidates) { const t = getVisibleText(el); if (!t) continue; const n = extractNameFromMixedLine(t); if (n) return n; }
    for (const el of candidates) {
      const text = getVisibleText(el);
      if (!isPhoneOrConfirmationLine(text)) continue;
      const rect = el.getBoundingClientRect();
      const nameCandidates = candidates
        .map(node => ({ el: node, text: getVisibleText(node), rect: node.getBoundingClientRect() }))
        .filter(x => x.text && isLikelyCustomerName(x.text))
        .filter(x => x.rect.bottom <= rect.top + 10)
        .filter(x => Math.abs(x.rect.left - rect.left) < 140)
        .sort((a, b) => {
          const sA = rect.top - a.rect.bottom + Math.abs(rect.left - a.rect.left);
          const sB = rect.top - b.rect.bottom + Math.abs(rect.left - b.rect.left);
          return sA - sB;
        });
      if (nameCandidates.length) return nameCandidates[0].text;
    }
    return '';
  }

  function extractItemsFromText(rawText) {
    const block = sliceItemSectionLines(rawText);
    if (!block.length) { log('Items block not found'); return []; }
    const items = [];
    let i = 0;
    while (i < block.length) {
      const line = normalizeText(block[i]);
      if (!line || isPaymentBadgeLine(line)) { i++; continue; }
      if (isTotalsStartLine(line)) break;
      let parsed = null, consume = 1;
      if (isInlineItemLine(line)) {
        parsed = parseInlineItemLine(line);
      } else if (isQtyOnlyLine(line) && i + 1 < block.length && isCodeTitleLine(block[i + 1])) {
        parsed = parseSeparatedItemLine(line, block[i + 1]); consume = 2;
      }
      if (!parsed) { i++; continue; }
      const noteLines = []; i += consume;
      while (i < block.length) {
        const next = normalizeText(block[i]);
        if (!next) { i++; continue; }
        if (isPaymentBadgeLine(next) || isTotalsStartLine(next)) break;
        if (isInlineItemLine(next)) break;
        if (isQtyOnlyLine(next) && i + 1 < block.length && isCodeTitleLine(block[i + 1])) break;
        noteLines.push(next); i++;
      }
      items.push({ qty: parsed.qty, code: parsed.code, name: parsed.name, note: stripPriceFromItemText(noteLines.join(' ')) });
    }
    const deduped = [];
    for (const item of items) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.qty === item.qty && prev.code === item.code && prev.note === item.note) continue;
      deduped.push(item);
    }
    log('Parsed items:', deduped);
    return deduped;
  }

  function extractOrderFromTakeaway(expectedOrderCode = '') {
    try {
    const panel = findOrderPanel(expectedOrderCode);
    if (!panel) {
      throw new Error(expectedOrderCode
        ? `Panel chi tiết chưa hiển thị đúng đơn #${expectedOrderCode}. Đã dừng để tránh dùng dữ liệu đơn cũ.`
        : 'Không tìm thấy panel chi tiết đơn. Hãy mở đúng đơn trước khi lấy dữ liệu.');
    }
    const lines = textLinesFrom(panel);
    const rawPanelText = String(panel?.innerText || panel?.textContent || '');
    const fullText = normalizeText(stripUiNoise(rawPanelText));
    let orderCode       = findByRegex(lines, /#([A-Z0-9]{5,})\b/i, 1);
    let phone           = findByRegex(lines, /(\+\d[\d\s\-\/]{6,})/, 1);
    let confirmationCode= findByRegex(lines, /Bestätigungscode:\s*([0-9]+)/i, 1);
    let acceptedAt      = findByRegex(lines, /Bestellung angenommen um\s*(.+)$/i, 1);
    let deliveryTime    = extractDeliveryTime(lines, rawPanelText);
    let paymentMethod   = extractPaymentMethod(lines, panel, rawPanelText);
    let customerNote    = extractCustomerNote(rawPanelText);
    let customerName    = extractCustomerNameFromRawText(rawPanelText);
    if (!customerName) customerName = extractCustomerNameFromStructuredBlocks(panel);
    if (!customerName) customerName = extractCustomerNameFromDom(panel);
    if (!customerName) customerName = extractCustomerNameFallback(rawPanelText);
    if (!orderCode) { const m = fullText.match(/#([A-Z0-9]{5,})\b/i); if (m) orderCode = normalizeText(m[1]); }
    if (!phone) { const m = fullText.match(/(\+\d[\d\s\-\/]{6,})/); if (m) phone = normalizeText(m[1]); }
    if (!confirmationCode) { const m = fullText.match(/Bestätigungscode:\s*([0-9]+)/i); if (m) confirmationCode = normalizeText(m[1]); }
    let floor = '';
    const floorLine = lines.find(x => /^Floor:\s*/i.test(x) || /^Etage:\s*/i.test(x));
    if (floorLine) floor = normalizeText(floorLine.replace(/^Floor:\s*/i, '').replace(/^Etage:\s*/i, ''));
    let firma = '';
    const firmaLine = lines.find(x => /^Firma:\s*/i.test(x));
    if (firmaLine) firma = normalizeText(firmaLine.replace(/^Firma:\s*/i, ''));
    let hotel = '';
    const hotelLine = lines.find(x => /^Hotel:\s*/i.test(x));
    if (hotelLine) hotel = normalizeText(hotelLine.replace(/^Hotel:\s*/i, ''));
    let codeHaus = '';
    const codeHausLine = lines.find(x => /^Code Haus:\s*/i.test(x));
    if (codeHausLine) codeHaus = normalizeText(codeHausLine.replace(/^Code Haus:\s*/i, ''));
    let nameNummer = '';
    const nameNummerLine = lines.find(x => /^Name\/Nr:\s*/i.test(x));
    if (nameNummerLine) nameNummer = normalizeText(nameNummerLine.replace(/^Name\/Nr:\s*/i, ''));
    let address = '';
    const addressLine = lines.find(x => /\d{5}\s+[^,]+,\s*.+\d+/i.test(x));
    if (addressLine) address = cleanAddress(addressLine);
    const items = extractItemsFromText(rawPanelText);
    let subtotal    = findByRegex(lines, /Zwischensumme\s*(EUR\s*\d+[.,]\d{2})/i, 1);
    let deliveryFee = findByRegex(lines, /Liefergebühr\s*(EUR\s*\d+[.,]\d{2})/i,  1);
    let total       = findByRegex(lines, /Gesamt\s*(EUR\s*\d+[.,]\d{2})/i,         1);
    const totalsFromRaw = extractTotalsFromRawText(rawPanelText);
    if (!subtotal)    subtotal    = totalsFromRaw.subtotal;
    if (!deliveryFee) deliveryFee = totalsFromRaw.deliveryFee;
    if (!total)       total       = totalsFromRaw.total;
    const payload = sanitizeLegacyPayload({
      source: 'live-orders.takeaway.com', capturedAt: new Date().toISOString(),
      orderCode: normalizeText(orderCode), customerName: normalizeText(customerName),
      phone: normalizeText(phone), address: normalizeText(address),
      floor: normalizeText(floor), firma: normalizeText(firma), hotel: normalizeText(hotel), codeHaus: normalizeText(codeHaus), nameNummer: normalizeText(nameNummer),
      confirmationCode: normalizeText(confirmationCode),
      paymentMethod: normalizePaymentMethod(paymentMethod),
      deliveryTime: normalizeText(deliveryTime), acceptedAt: normalizeText(acceptedAt),
      customerNote: normalizeText(customerNote),
      subtotal: normalizeText(subtotal), deliveryFee: normalizeText(deliveryFee), total: normalizeText(total),
      items,
    });
    if (expectedOrderCode && normLower(payload.orderCode) !== normLower(expectedOrderCode)) {
      throw new Error(`Mã panel #${payload.orderCode || 'trống'} không khớp đơn đang chờ #${expectedOrderCode}. Đã dừng trước khi mở Admin.`);
    }
    log('Extracted payload:', payload);
    if (!payload.customerName && !payload.address && !payload.phone) {
      throw new Error('Không đọc được dữ liệu đơn. Hãy mở panel chi tiết đơn trước.');
    }
    return payload;
    } catch (err) {
      logError('extractOrderFromTakeaway', err);
      throw err;
    }
  }

  function getTextNodesWithExactText(root, labelText) {
    const wanted = normalizeText(labelText).toLowerCase();
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalizeText(node.textContent || '').toLowerCase();
        return !text ? NodeFilter.FILTER_REJECT : (text === wanted ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT);
      }
    });
    const result = [];
    let node;
    while ((node = walker.nextNode())) result.push(node);
    return result;
  }

  function nextElementInDocumentOrder(startEl) {
    if (!startEl) return null;
    let node = startEl;
    while (node) {
      if (node.firstElementChild) return node.firstElementChild;
      while (node) { if (node.nextElementSibling) return node.nextElementSibling; node = node.parentElement; }
    }
    return null;
  }

  function findFirstMatchingAfterElement(anchorEl, matcher, maxSteps = 120) {
    let el = anchorEl, steps = 0;
    while (el && steps < maxSteps) {
      el = nextElementInDocumentOrder(el); steps++;
      if (!el) break;
      if (matcher(el)) return el;
      if (el.querySelectorAll) {
        const descendants = [...el.querySelectorAll('input, textarea, select')].filter(matcher);
        if (descendants.length) return descendants[0];
      }
    }
    return null;
  }

  function findFieldByLabelText(labelText, kind = 'fillable') {
    const textNodes = getTextNodesWithExactText(document.body, labelText);
    let matcher;
    if (kind === 'choice')   matcher = (el) => isSelectableField(el);
    else if (kind === 'textarea') matcher = (el) => el instanceof Element && el.tagName.toLowerCase() === 'textarea' && isFillableField(el);
    else matcher = (el) => isFillableField(el);
    for (const textNode of textNodes) {
      const parentEl = textNode.parentElement;
      if (!parentEl || !isVisible(parentEl)) continue;
      const directMatch = findFirstMatchingAfterElement(parentEl, matcher, 80);
      if (directMatch) return directMatch;
    }
    return null;
  }

  function findFieldByLabelTextAfterElement(labelText, afterEl, kind = 'fillable') {
    if (!afterEl) return findFieldByLabelText(labelText, kind);
    const textNodes = getTextNodesWithExactText(document.body, labelText);
    let matcher;
    if (kind === 'choice')   matcher = (el) => isSelectableField(el);
    else if (kind === 'textarea') matcher = (el) => el instanceof Element && el.tagName.toLowerCase() === 'textarea' && isFillableField(el);
    else matcher = (el) => isFillableField(el);
    for (const textNode of textNodes) {
      const parentEl = textNode.parentElement;
      if (!parentEl || !isVisible(parentEl)) continue;
      const position = afterEl.compareDocumentPosition(parentEl);
      if (!(position & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const directMatch = findFirstMatchingAfterElement(parentEl, matcher, 80);
      if (directMatch) return directMatch;
    }
    return null;
  }

  function buildAdminCustomerName(payload) {
    const firstName = normalizeText(payload?.customerName || '');
    const source = normalizeComparableText(payload?.source || '');
    let lastName = '';
    if (source.includes('ubereats')) lastName = '(Uber Eats)';
    else if (source.includes('takeaway') || source.includes('lieferando')) lastName = '(Lieferando)';
    else if (source.includes('wolt')) lastName = '(Wolt)';
    return { firstName, lastName };
  }

  async function fillThaiAsiaAdminOrder(payload) {
    const parsedAddress = parseTakeawayAddress(payload.address || '');
    let resolvedAddress = resolveCityWithDistrict(
      parsedAddress.street,
      parsedAddress.houseNumber,
      parsedAddress.zip,
      parsedAddress.city,
      payload
    );
    if (!resolvedAddress.district && !payload.resolvedCity && (parsedAddress.zip === '06188' || (parsedAddress.city || '').toLowerCase().includes('landsberg'))) {
      try {
        const asyncRes = await resolveCityWithDistrictAsync(
          parsedAddress.street,
          parsedAddress.houseNumber,
          parsedAddress.zip,
          parsedAddress.city,
          payload
        );
        if (asyncRes && asyncRes.district) {
          resolvedAddress = asyncRes;
        }
      } catch (_) {}
    }
    const total = normalizeDecimalDotString(parseMoneyToNumberString(payload.total || ''));
    const note = buildAdminNote(payload);
    const phoneWithConfirmation = buildPhoneWithConfirmation(payload);
    const adminName = buildAdminCustomerName(payload);
    const rawDeliveryTime = normalizeText(payload.deliveryTime || '');
    const isAsapDelivery = /^ASAP$/i.test(rawDeliveryTime);
    const preferredTime = isAsapDelivery ? 'schnell wie möglich' : rawDeliveryTime || normalizeText(payload.acceptedAt || '');
    const shippingFeeValue = normalizePaymentMethod(payload.paymentMethod) === 'Bar' ? total : '0';
    const noteField = findFieldByLabelText('Note', 'textarea') || findFieldByLabelText('Note');
    const shippingFeeField =
      findFieldByLabelText('Shipping fee') ||
      findFieldByLabelTextAfterElement('Total', noteField);
    const totalField = findFieldByLabelText('Total');
    const fields = {
      firstName: findFieldByLabelText('First name'),
      lastName:  findFieldByLabelText('Last name'),
      email:     findFieldByLabelText('Email'),
      phone:     findFieldByLabelText('Phone'),
      total:     totalField && totalField !== shippingFeeField ? totalField : null,
      shippingMethod: findFieldByLabelText('Shipping method', 'choice'),
      status:    findFieldByLabelText('Status', 'choice'),
      paymentMethod: findFieldByLabelText('Payment method', 'choice') || findFieldByLabelText('Payment', 'choice'),
      note:      noteField,
      address:   findFieldByLabelText('Address'),
      houseNumber: findFieldByLabelText('Số nhà') || findFieldByLabelText('số nhà') || findFieldByLabelText('House number') || findFieldByLabelText('Hausnummer'),
      city:      findFieldByLabelText('City'),
      time:      findFieldByLabelText('Time'),
      additionalTime: findFieldByLabelText('Additional time'),
      code:      findFieldByLabelText('Code'),
      postcode:  findFieldByLabelText('Postcode'),
      shippingFee: shippingFeeField,
    };
    let changedCount = 0;
    if (fields.firstName && adminName.firstName)  if (setNativeValue(fields.firstName, adminName.firstName)) changedCount++;
    if (fields.lastName  && adminName.lastName)   if (setNativeValue(fields.lastName,  adminName.lastName))  changedCount++;
    if (fields.email)                             if (setNativeValue(fields.email, DEFAULT_EMAIL)) changedCount++;
    if (fields.phone && phoneWithConfirmation)    if (setNativeValue(fields.phone, phoneWithConfirmation)) changedCount++;
    if (fields.total && total)                    if (setNativeValue(fields.total, total)) changedCount++;
    if (fields.note && note)                      if (setNativeValue(fields.note, note)) changedCount++;
    if (fields.address && parsedAddress.street)   if (setNativeValue(fields.address, parsedAddress.street)) changedCount++;
    if (fields.houseNumber && parsedAddress.houseNumber) if (setNativeValue(fields.houseNumber, parsedAddress.houseNumber)) changedCount++;
    const finalCity = payload.resolvedCity || resolvedAddress.city;
    if (fields.city && finalCity) if (setNativeValue(fields.city, finalCity)) changedCount++;
    if (fields.time && preferredTime)             if (setNativeValue(fields.time, preferredTime)) changedCount++;
    if (fields.additionalTime)                    if (setNativeValue(fields.additionalTime, '')) changedCount++;
    if (fields.code && payload.orderCode)         if (setNativeValue(fields.code, payload.orderCode)) changedCount++;
    if (fields.postcode && parsedAddress.zip)     if (setNativeValue(fields.postcode, parsedAddress.zip)) changedCount++;
    if (fields.shippingFee)                       if (setNumberFieldValue(fields.shippingFee, normalizeDecimalDotString(shippingFeeValue))) changedCount++;
    const matchedCount = Object.values(fields).filter(Boolean).length;
    log('Fill result', { changedCount, matchedCount });
    return { changedCount, matchedCount };
  }

  function shouldAutoAct(payload) {
    if (!payload) return false;
    if (!payload.__autoFill && !payload.__autoSubmit) return false;
    const ts = Number(payload.__autoActionAt || 0);
    if (!ts) return false;
    return now() - ts < AUTO_ACTION_TTL_MS;
  }

  async function markAutoActionsDone(orderCode = '') {
    const payload = sanitizeLegacyPayload(await loadPayload(orderCode));
    if (!payload) return;
    payload.__autoFill = false; payload.__autoSubmit = false; payload.__autoActionAt = null;
    const storageKey = payload.__storageKey || getBridgeOrderStorageKey(payload.orderCode || '');
    await GM_setValue(storageKey, stripInternalPayloadMeta(payload));
  }

  function findSubmitButton() {
    for (const el of [...document.querySelectorAll('button, input[type="submit"], .btn, a')].filter(el => isVisible(el))) {
      const text = normalizeComparableText(el.textContent || el.value || el.innerText || '');
      if (!text) continue;
      if (text === 'submit' || text.includes('submit') || text === 'save' || text.includes('save')) return el;
    }
    return null;
  }

  // Bridge's own clickElement (simple, no label param)
  function bridgeClick(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {}
    try { el.focus(); } catch (_) {}
    if (typeof el.click === 'function') { try { el.click(); return true; } catch (_) {} }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }

  function emitAdminSubmitEvent(action, payload = {}) {
    const details = {
      ...payload,
      page: 'adminWin',
      action,
      orderCode: normalizeText(payload.orderCode || '')
    };
    emitDiag('order_activity', details);
    try {
      if (typeof GM_adminSubmitEvent === 'function') GM_adminSubmitEvent(action, details);
    } catch (_) {}
  }

  function visibleAdminText(selector) {
    const rows = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const text = normalizeText(el.innerText || el.textContent || el.value || '');
      if (text) rows.push(text);
      if (rows.length >= 3) break;
    }
    return rows;
  }

  function inspectAdminSubmitOutcome(submitBtn, startedUrl) {
    if (!pageLooksLikeAdminOrderCreate() || location.href !== startedUrl) {
      return { status: 'confirmed', confirmation: 'navigation', url: location.href };
    }

    const successTexts = visibleAdminText([
      '.alert-success', '.toast-success', '.notification-success',
      '.swal2-success', '[data-status="success"]', '[role="status"]'
    ].join(','));
    const successText = successTexts.find((text) =>
      /success|successful|successfully|erfolgreich|gespeichert|erstellt|created|saved/i.test(text)
    );
    if (successText) {
      return { status: 'confirmed', confirmation: 'success_message', message: successText.slice(0, 240) };
    }

    const form = submitBtn && typeof submitBtn.closest === 'function' ? submitBtn.closest('form') : null;
    if (form && typeof form.checkValidity === 'function' && !form.checkValidity()) {
      const invalidFields = Array.from(form.querySelectorAll(':invalid')).slice(0, 5).map((el) =>
        normalizeText(el.name || el.id || el.getAttribute('aria-label') || el.type || 'unknown')
      );
      return { status: 'validation_failed', invalidFields };
    }

    const errorTexts = visibleAdminText([
      '.invalid-feedback', '.validation-error', '.alert-danger', '.alert-error',
      '[aria-invalid="true"] + *', '.is-invalid + *'
    ].join(','));
    if (errorTexts.length) {
      return { status: 'validation_failed', errors: errorTexts.map((x) => x.slice(0, 240)) };
    }
    return { status: 'pending' };
  }

  async function waitForAdminSubmitOutcome(submitBtn, startedUrl) {
    const deadline = now() + ADMIN_SUBMIT_CONFIRM_TIMEOUT_MS;
    while (now() < deadline) {
      const outcome = inspectAdminSubmitOutcome(submitBtn, startedUrl);
      if (outcome.status !== 'pending') return outcome;
      await sleep(ADMIN_SUBMIT_POLL_MS);
    }
    return { status: 'unconfirmed_timeout', url: location.href };
  }

  function showCurrentAdminWindow() {
    try {
      if (typeof GM_showCurrentAdminWindow === 'function') GM_showCurrentAdminWindow();
    } catch (_) {}
  }

  function closeCurrentAdminWindow() {
    try {
      if (typeof GM_closeCurrentAdminWindow === 'function') {
        GM_closeCurrentAdminWindow();
        return;
      }
    } catch (_) {}
    try { window.close(); } catch (_) {}
  }

  function createInfoPanel(payload) {
    const p = sanitizeLegacyPayload(payload);
    let panel = document.getElementById('thaiasia-order-panel');
    if (panel) panel.remove();
    const itemsHtml = (p.items || []).map((it, i) => `<div style="margin:4px 0;">${i + 1}. ${escapeHtml(formatItemLine(it))}</div>`).join('');
    panel = document.createElement('div');
    panel.id = 'thaiasia-order-panel';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div style="font-weight:700;font-size:16px;">Saved Takeaway Order</div>
        <button id="thaiasia-order-panel-close" style="border:none;background:#eee;border-radius:6px;padding:4px 8px;cursor:pointer;color:#222;font-weight:700;">×</button>
      </div>
      <div style="font-size:13px;line-height:1.55;">
        <div><b>Name:</b> ${escapeHtml(p.customerName || '')}</div>
        <div><b>Phone:</b> ${escapeHtml(buildPhoneWithConfirmation(p) || '')}</div>
        <div><b>Address:</b> ${escapeHtml(p.address || '')}</div>
        <div><b>House number/name:</b> ${escapeHtml(p.nameNummer || '')}</div>
        <div><b>Additional address:</b> ${escapeHtml(p.additionalAddressInfo || '')}</div>
        <div><b>Floor:</b> ${escapeHtml(p.floor || '')}</div>
        <div><b>Order code:</b> ${escapeHtml(p.orderCode || '')}</div>
        <div><b>Confirmation:</b> ${escapeHtml(p.confirmationCode || '')}</div>
        <div><b>Payment:</b> ${escapeHtml(p.paymentMethod || '')}</div>
        <div><b>Delivery time:</b> ${escapeHtml(p.deliveryTime || '')}</div>
        <div><b>Accepted:</b> ${escapeHtml(p.acceptedAt || '')}</div>
        <div><b>Customer note:</b> ${escapeHtml(p.customerNote || '')}</div>
        <div><b>Subtotal:</b> ${escapeHtml(p.subtotal || '')}</div>
        <div><b>Delivery fee:</b> ${escapeHtml(p.deliveryFee || '')}</div>
        <div><b>Total:</b> ${escapeHtml(p.total || '')}</div>
      </div>
      <div style="margin-top:10px;">
        <div style="font-weight:700;margin-bottom:6px;">Items</div>
        <div style="max-height:140px;overflow:auto;border:1px solid #eee;padding:8px;border-radius:8px;background:#fafafa;font-size:12px;white-space:pre-line;">
          ${itemsHtml || '<div>Không có dữ liệu món</div>'}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button id="thaiasia-fill-from-panel"  style="border:none;background:#f26524;color:#fff;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;">Fill saved order</button>
        <button id="thaiasia-copy-from-panel"  style="border:none;background:#444;color:#fff;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;">Copy</button>
        <button id="thaiasia-clear-from-panel" style="border:none;background:#777;color:#fff;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;">Clear</button>
      </div>`;
    Object.assign(panel.style, {
      position: 'fixed', right: '20px', top: '70px', width: '360px', maxHeight: '82vh',
      overflow: 'auto', zIndex: '999999', background: '#fff', color: '#222',
      border: '1px solid #ddd', borderRadius: '14px', padding: '16px',
      boxShadow: '0 14px 36px rgba(0,0,0,.22)',
    });
    document.body.appendChild(panel);
    document.getElementById('thaiasia-order-panel-close')?.addEventListener('click', () => {
      sessionStorage.setItem('thaiasia_order_panel_dismissed', '1');
      panel.remove();
    });
    document.getElementById('thaiasia-fill-from-panel')?.addEventListener('click', async () => {
      const lp = sanitizeLegacyPayload(await loadPayload());
      if (!lp) { alert('Chưa có dữ liệu order đã lưu.'); return; }
      if (!pageLooksLikeAdminOrderCreate()) {
        try {
          window.location.replace(THAIASIA_URL);
        } catch (_) {
          window.location.href = THAIASIA_URL;
        }
        return;
      }
      const result = await fillThaiAsiaAdminOrder(lp);
      if (result.matchedCount === 0) { alert('Không tìm được field phù hợp để điền.'); return; }
      notify(`Đã map ${result.matchedCount} field, thay đổi ${result.changedCount} trường`);
    });
    document.getElementById('thaiasia-copy-from-panel')?.addEventListener('click', async () => {
      const lp = sanitizeLegacyPayload(await loadPayload());
      if (!lp) { alert('Chưa có dữ liệu order đã lưu.'); return; }
      GM_setClipboard(buildText(lp)); notify('Đã copy dữ liệu đơn');
    });
    document.getElementById('thaiasia-clear-from-panel')?.addEventListener('click', async () => {
      sessionStorage.setItem('thaiasia_order_panel_dismissed', '1');
      await clearPayload(); panel.remove(); notify('Đã xoá dữ liệu order đã lưu');
    });
  }

  const TAKEAWAY_CONTROLS_ID = 'takeaway-controls-dock';

  function getTakeawayControlsDock() {
    let dock = document.getElementById(TAKEAWAY_CONTROLS_ID);
    if (dock) return dock;
    dock = document.createElement('div');
    dock.id = TAKEAWAY_CONTROLS_ID;
    dock.title = 'Bấm giữ chuột vào khoảng trắng để kéo di chuyển panel';
    Object.assign(dock.style, {
      position: 'fixed',
      right: '18px',
      top: '90px',
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
    const parent = document.body || document.documentElement;
    if (parent) parent.appendChild(dock);

    // Kéo thả panel tự do trên màn hình giống Uber và Wolt
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

  function installTakeawayBridge() {
    const BTN_ID = 'thaiasia-send-order-btn';
    if (document.getElementById(BTN_ID)) return;

    const dock = getTakeawayControlsDock();
    if (!dock) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'Lấy đơn Lieferando';
    Object.assign(btn.style, {
      padding: '9px 16px',
      border: 'none',
      borderRadius: '9px',
      background: '#f26524',
      color: '#fff',
      fontWeight: '700',
      fontSize: '13px',
      cursor: 'pointer',
      boxShadow: '0 6px 20px rgba(0,0,0,.2)',
      fontFamily: 'system-ui,-apple-system,Arial,sans-serif',
      pointerEvents: 'auto',
      whiteSpace: 'nowrap',
    });

    btn.addEventListener('click', async () => {
      try {
        const isAuto = queueInFlight === true;
        const expectedOrderCode = isAuto ? queueExpectedOrderCode : '';
        const payload = extractOrderFromTakeaway(expectedOrderCode);
        if (STRICT_ORDER_CODE_REQUIRED && !payload.orderCode) {
          if (isAuto) writeSendResultSignal('error', '');
          throw new Error('Không lấy được mã đơn (orderCode), dừng gửi để tránh Accept nhầm đơn.');
        }

        // 1. Luồng TỰ ĐỘNG (Auto Queue): giữ nguyên chống trùng và auto submit ngầm
        if (isAuto) {
          if (!expectedOrderCode || normLower(payload.orderCode) !== normLower(expectedOrderCode)) {
            writeSendResultSignal('identity_mismatch', payload.orderCode || '');
            throw new Error(`Định danh đơn không khớp: đang chờ #${expectedOrderCode || 'trống'}, panel là #${payload.orderCode || 'trống'}.`);
          }
          if (payload.orderCode && (await wasOrderRecentlySent(payload.orderCode))) {
            log('Auto Queue: Order already sent recently, skipping:', payload.orderCode);
            notify(`Đơn ${payload.orderCode} đã gửi rồi, bỏ qua.`);
            writeSendResultSignal('skipped', payload.orderCode);
            return;
          }
          const storageKey = await savePayload(payload, { autoFill: true, autoSubmit: true });
          try { GM_setClipboard(buildText(payload)); } catch (_) {}
          log('Auto Queue: Final payload before save:', payload);
          notify(`Đã lấy đơn ${payload.orderCode || ''} - ${payload.customerName || 'unknown'} - ${payload.items?.length || 0} món`);
          const tabRef = openThaiAsiaInBackground(storageKey);
          if (!tabRef) {
            await clearPayload(payload.orderCode);
            writeSendResultSignal('error', payload.orderCode);
            throw new Error(`Không mở được Admin đã khóa với đơn #${payload.orderCode}. Đã dừng trước khi nhận đơn.`);
          }
          _adminTabRef = tabRef;
          startCloseWatcher();
          await markOrderAsSent(payload.orderCode);
          writeSendResultSignal('ok', payload.orderCode);
          return;
        }

        // 2. Luồng THỦ CÔNG (Click panel / Phím tắt Alt+Shift+S):
        // Ép gửi lại không chặn trùng, tự điền form Admin, DỪNG Ở SUBMIT (không ấn submit), Admin chạy nổi
        const storageKey = await savePayload(payload, { autoFill: true, autoSubmit: false });
        if (payload.orderCode) await markOrderAsSent(payload.orderCode);
        try { GM_setClipboard(buildText(payload)); } catch (_) {}
        log('Manual Click: Final payload before save (preview mode, no auto-submit):', payload);
        notify(`Đã lấy đơn ${payload.orderCode || ''} - Mở Admin nổi (chờ Submit)`);

        try {
          if (typeof GM_openInTab === 'function') {
            GM_openInTab(THAIASIA_URL, { active: true, show: true, storageKey });
          } else {
            openThaiAsia();
          }
        } catch (_) {
          openThaiAsia();
        }
      } catch (error) {
        logError('installTakeawayBridge.click', error);
        if (queueInFlight) writeSendResultSignal('error', '');
        console.error('[ThaiAsia] Send error:', error.message || error);
      }
    });

    dock.appendChild(btn);

    if (!window.__thaiasiaTakeawayKeydownBound) {
      window.__thaiasiaTakeawayKeydownBound = true;
      document.addEventListener('keydown', (e) => {
        if (e.altKey && e.shiftKey && e.key.toLowerCase() === 's') {
          e.preventDefault();
          document.getElementById(BTN_ID)?.click();
        }
      });
    }
  }

  setInterval(() => {
    if (location.hostname.includes('live-orders.takeaway.com')) {
      if (!document.getElementById('thaiasia-send-order-btn')) {
        installTakeawayBridge();
      }
    }
  }, 3000);

  async function autoFillAndSubmitIfRequested() {
    if (!pageLooksLikeAdminOrderCreate()) return;
    const payload = sanitizeLegacyPayload(await loadPayload());
    if (!payload || !shouldAutoAct(payload)) return;
    if (sessionStorage.getItem(AUTO_SUBMIT_DONE_KEY) === '1') return;
    const orderCode = normalizeText(payload.orderCode || '');
    emitAdminSubmitEvent('admin_payload_loaded', {
      orderCode,
      autoFill: !!payload.__autoFill,
      autoSubmit: !!payload.__autoSubmit,
      payloadAgeMs: Math.max(0, now() - Number(payload.__autoActionAt || now()))
    });
    let fillDone = false, fillDoneAt = 0, fillResult = null, submitDone = false, attempts = 0;
    const maxAttempts = 30, FILL_TO_SUBMIT_DELAY_MS = 1000;
    const timer = setInterval(async () => {
      attempts++;
      const lp = sanitizeLegacyPayload(await loadPayload());
      if (!lp || !shouldAutoAct(lp)) { clearInterval(timer); return; }
      if (!fillDone && lp.__autoFill) {
        const result = await fillThaiAsiaAdminOrder(lp);
        if (result.matchedCount > 0) {
          fillResult = result;
          fillDone = true; fillDoneAt = now();
          emitAdminSubmitEvent('admin_fill_succeeded', {
            orderCode,
            matchedCount: result.matchedCount,
            changedCount: result.changedCount
          });
          log('Auto fill success:', result);
          notify(`Tự động fill ${result.changedCount}/${result.matchedCount} trường`);
        }
      }
      if (fillDone && !lp.__autoSubmit) {
        clearInterval(timer);
        log('Preview mode: fill completed, showing admin window immediately');
        showCurrentAdminWindow();
        return;
      }
      if (fillDone && lp.__autoSubmit && !submitDone) {
        if (now() - fillDoneAt < FILL_TO_SUBMIT_DELAY_MS) return;
        if (sessionStorage.getItem(AUTO_SUBMIT_LOCK_KEY) === '1') { clearInterval(timer); return; }
        const submitBtn = findSubmitButton();
        if (submitBtn) {
          sessionStorage.setItem(AUTO_SUBMIT_LOCK_KEY, '1');
          log('Auto clicking submit button:', submitBtn);
          const submitStartedAt = now();
          const submitStartedUrl = location.href;
          emitAdminSubmitEvent('admin_submit_started', {
            orderCode,
            matchedCount: fillResult ? fillResult.matchedCount : 0,
            changedCount: fillResult ? fillResult.changedCount : 0,
            url: submitStartedUrl
          });
          submitDone = bridgeClick(submitBtn);
          if (submitDone) {
            sessionStorage.setItem(AUTO_SUBMIT_DONE_KEY, '1');
            notify('Đã tự động bấm Submit');
            clearInterval(timer);
            const outcome = await waitForAdminSubmitOutcome(submitBtn, submitStartedUrl);
            const durationMs = Math.max(0, now() - submitStartedAt);
            if (outcome.status === 'confirmed') {
              emitAdminSubmitEvent('admin_submit_confirmed', {
                orderCode,
                durationMs,
                confirmation: outcome.confirmation || '',
                url: outcome.url || location.href,
                message: outcome.message || ''
              });
              await markAutoActionsDone(orderCode);
              setTimeout(() => closeCurrentAdminWindow(), 800);
            } else {
              const action = outcome.status === 'validation_failed'
                ? 'admin_submit_validation_failed'
                : 'admin_submit_unconfirmed';
              emitAdminSubmitEvent(action, {
                orderCode,
                durationMs,
                url: outcome.url || location.href,
                invalidFields: outcome.invalidFields || [],
                errors: outcome.errors || []
              });
              await markAutoActionsDone(orderCode);
              showCurrentAdminWindow();
            }
            return;
          }
          emitAdminSubmitEvent('admin_submit_click_failed', { orderCode, url: location.href });
          sessionStorage.removeItem(AUTO_SUBMIT_LOCK_KEY);
        }
      }
      if (attempts >= maxAttempts) {
        log('Auto fill/submit timeout');
        emitAdminSubmitEvent('admin_fill_submit_timeout', {
          orderCode,
          attempts,
          fillDone,
          url: location.href
        });
        showCurrentAdminWindow();
        if (fillDone) {
          const p2 = sanitizeLegacyPayload(await loadPayload());
          if (p2) {
            p2.__autoFill = false;
            p2.__autoSubmit = false;
            p2.__autoActionAt = null;
            const storageKey = p2.__storageKey || getBridgeOrderStorageKey(p2.orderCode || '');
            await GM_setValue(storageKey, stripInternalPayloadMeta(p2));
          }
        }
        clearInterval(timer);
      }
    }, 500);
  }

  async function installThaiAsiaAdmin() {
    const payload = sanitizeLegacyPayload(await loadPayload());
    if (payload && !sessionStorage.getItem('thaiasia_order_panel_dismissed')) {
      createInfoPanel(payload);
    }
    const observer = new MutationObserver(async () => {
      if (sessionStorage.getItem('thaiasia_order_panel_dismissed')) return;
      const lp = sanitizeLegacyPayload(await loadPayload());
      if (!lp) return;
      if (!document.getElementById('thaiasia-order-panel')) createInfoPanel(lp);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    autoFillAndSubmitIfRequested();
  }

  // ============================================================
  // ===== QUEUE MODULE (autoklicksendundaccept v3.3.0) =====
  // ============================================================

  function getLastCycleAt() {
    try { return Number(sessionStorage.getItem(LAST_CYCLE_KEY) || '0'); } catch (_) { return 0; }
  }
  function setLastCycleAt(ts) {
    try { sessionStorage.setItem(LAST_CYCLE_KEY, String(ts)); } catch (_) {}
  }

  function setMirroredJsonValue(primaryKey, mirrorKey, value) {
    const raw = JSON.stringify(value);
    try { sessionStorage.setItem(primaryKey, raw); } catch (_) {}
    try { localStorage.setItem(mirrorKey, raw); } catch (_) {}
  }

  function getMirroredJsonValue(primaryKey, mirrorKey) {
    const parse = (raw) => {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (_) { return null; }
    };
    let primaryRaw = null;
    try { primaryRaw = sessionStorage.getItem(primaryKey); } catch (_) {}
    const primary = parse(primaryRaw);
    if (primary && typeof primary === 'object') return primary;

    let mirrorRaw = null;
    try { mirrorRaw = localStorage.getItem(mirrorKey); } catch (_) {}
    const mirror = parse(mirrorRaw);
    if (mirror && typeof mirror === 'object') {
      try { sessionStorage.setItem(primaryKey, JSON.stringify(mirror)); } catch (_) {}
      return mirror;
    }

    return null;
  }

  function clearMirroredJsonValue(primaryKey, mirrorKey) {
    try { sessionStorage.removeItem(primaryKey); } catch (_) {}
    try { localStorage.removeItem(mirrorKey); } catch (_) {}
  }

  function writeSendResultSignal(status, orderCode) {
    setMirroredJsonValue(SEND_RESULT_KEY, SEND_RESULT_MIRROR_KEY, {
      status,
      orderCode: orderCode || '',
      ts: now()
    });
  }

  function setProcessingLock(active) {
    try {
      if (active) {
        const existingTs = Number(sessionStorage.getItem(PROCESSING_LOCK_KEY) || '0');
        const existingOwner = String(sessionStorage.getItem(PROCESSING_LOCK_OWNER_KEY) || '');
        const lockIsFresh = existingTs > 0 && (now() - existingTs) < QUEUE_CFG.PROCESSING_LOCK_MAX_AGE_MS;
        if (lockIsFresh && existingOwner && existingOwner !== queueLockOwnerToken) {
          return false;
        }
        sessionStorage.setItem(PROCESSING_LOCK_OWNER_KEY, queueLockOwnerToken);
        sessionStorage.setItem(PROCESSING_LOCK_TAB_KEY, location.href);
        sessionStorage.setItem(PROCESSING_LOCK_KEY, String(now()));
        if (sessionStorage.getItem(PROCESSING_LOCK_OWNER_KEY) !== queueLockOwnerToken) {
          return false;
        }
        if (!queueLockHeartbeat) {
          queueLockHeartbeat = setInterval(() => {
            try {
              if (sessionStorage.getItem(PROCESSING_LOCK_OWNER_KEY) !== queueLockOwnerToken) {
                if (queueLockHeartbeat) { clearInterval(queueLockHeartbeat); queueLockHeartbeat = null; }
                return;
              }
              sessionStorage.setItem(PROCESSING_LOCK_KEY, String(now()));
            } catch (_) {}
          }, QUEUE_CFG.LOCK_HEARTBEAT_INTERVAL_MS);
        }
        return true;
      } else {
        const owner = String(sessionStorage.getItem(PROCESSING_LOCK_OWNER_KEY) || '');
        if (owner && owner !== queueLockOwnerToken) {
          return false;
        }
        sessionStorage.removeItem(PROCESSING_LOCK_KEY);
        sessionStorage.removeItem(PROCESSING_LOCK_OWNER_KEY);
        sessionStorage.removeItem(PROCESSING_LOCK_TAB_KEY);
        if (queueLockHeartbeat) { clearInterval(queueLockHeartbeat); queueLockHeartbeat = null; }
        return true;
      }
    } catch (_) {}
    return false;
  }

  function readSendResult() {
    const parsed = getMirroredJsonValue(SEND_RESULT_KEY, SEND_RESULT_MIRROR_KEY);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.ts && now() - parsed.ts > QUEUE_CFG.SEND_SIGNAL_MAX_AGE_MS) {
      clearSendResult();
      return null;
    }
    return parsed;
  }

  function clearSendResult() {
    clearMirroredJsonValue(SEND_RESULT_KEY, SEND_RESULT_MIRROR_KEY);
  }

  function withHiddenTimeout(baseMs) {
    return document.hidden ? Math.round(baseMs * QUEUE_CFG.HIDDEN_TIMEOUT_MULTIPLIER) : baseMs;
  }

  function getClickableElements() {
    return Array.from(document.querySelectorAll(['button','a','div[role="button"]','span[role="button"]','input[type="button"]','input[type="submit"]'].join(',')));
  }

  function getElementsByExactText(targetText) {
    const target = normLower(targetText);
    return getClickableElements().filter((el) => {
      const text = normLower(el.innerText || el.textContent || el.value || '');
      return text === target && isVisible(el) && !isDisabled(el);
    });
  }

  function findGlobalSendButton() {
    const directBtn = document.getElementById('thaiasia-send-order-btn');
    if (directBtn && isVisible(directBtn) && !isDisabled(directBtn)) return directBtn;
    return getElementsByExactText(QUEUE_CFG.SEND_TEXT)[0]
      || getElementsByExactText('Lấy đơn Lieferando')[0]
      || getElementsByExactText('Send to ThaiAsia')[0]
      || getElementsByExactText('Lấy đơn')[0]
      || null;
  }

  function getAcceptButtons() {
    return getElementsByExactText(QUEUE_CFG.ACCEPT_TEXT);
  }

  function getFirstAcceptButton() {
    return getAcceptButtons()[0] || null;
  }

  function getOrderCodeForAcceptButton(btn) {
    if (!btn) return '';
    let parent = btn.parentElement;
    let depth = 0;
    while (parent && depth < 20) {
      const text = normalizeText(parent.innerText || parent.textContent || '');
      const hashMatch = text.match(/#([A-Z0-9]{5,8})\b/i);
      if (hashMatch) return normalizeText(hashMatch[1]).toUpperCase();
      const bareMatches = text.toUpperCase().match(/\b(?=[A-Z0-9]{5,8}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{5,8}\b/g) || [];
      if (bareMatches.length === 1) return normalizeText(bareMatches[0]).toUpperCase();
      parent = parent.parentElement;
      depth += 1;
    }
    return '';
  }

  function getOrderContainerForAcceptButton(btn, orderCode) {
    if (!btn || !orderCode) return null;
    let parent = btn.parentElement;
    let depth = 0;
    while (parent && depth < 20) {
      if (textContainsOrderCode(parent.innerText || parent.textContent || '', orderCode)) return parent;
      parent = parent.parentElement;
      depth += 1;
    }
    return null;
  }

  function findAcceptButtonForOrder(orderCode) {
    if (!orderCode) {
      const acceptBtns = getAcceptButtons();
      if (acceptBtns.length === 1) return acceptBtns[0];
      qLog(`Missing orderCode and found ${acceptBtns.length} ACCEPT buttons. Abort for safety.`);
      return null;
    }
    const code = normLower(orderCode);
    const codeUpper = code.toUpperCase();
    const acceptBtns = getAcceptButtons();
    for (const btn of acceptBtns) {
      let parent = btn.parentElement, depth = 0;
      while (parent && depth < 20) {
        const parentText = normLower(parent.innerText || parent.textContent || '');
        if (textContainsOrderCode(parentText, codeUpper)) {
          qLog(`Found ACCEPT button matching order #${code}`); return btn;
        }
        parent = parent.parentElement; depth++;
      }
    }
    qLog(`Could not match ACCEPT to order #${code}. ${acceptBtns.length} button(s) exist. NOT falling back (identity safety).`);
    return null;
  }

  async function ensureOrderPanelMatches(orderCode, acceptBtn) {
    if (!orderCode || !acceptBtn) return null;
    let panel = findOrderPanel(orderCode);
    if (!panel) {
      const container = getOrderContainerForAcceptButton(acceptBtn, orderCode);
      if (container) {
        const codeTargets = [...container.querySelectorAll('button,a,[role="button"],div,span')]
          .filter((el) => el !== acceptBtn && isVisible(el) && textContainsOrderCode(el.innerText || el.textContent || '', orderCode))
          .sort((a, b) => normalizeText(a.innerText || a.textContent || '').length - normalizeText(b.innerText || b.textContent || '').length);
        const target = codeTargets[0] || container;
        queueClick(target, `mở chi tiết đơn #${orderCode}`);
      }
    }

    let lastPanelText = '';
    let stableReads = 0;
    panel = await waitFor(() => {
      const currentPanel = findOrderPanel(orderCode);
      if (!currentPanel) {
        lastPanelText = '';
        stableReads = 0;
        return null;
      }
      const currentText = normalizeText(currentPanel.innerText || currentPanel.textContent || '');
      if (!currentText || currentText !== lastPanelText) {
        lastPanelText = currentText;
        stableReads = 1;
        return null;
      }
      stableReads += 1;
      return stableReads >= 3 ? currentPanel : null;
    }, withHiddenTimeout(QUEUE_CFG.WAIT_ORDER_PANEL_TIMEOUT_MS));
    return panel || null;
  }

  // Queue's clickElement (with label param for logging)
  function queueClick(el, label) {
    if (!el || !document.contains(el) || !isVisible(el) || isDisabled(el)) {
      qLog(`Cannot click "${label}" because element is not clickable.`); return false;
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    try {
      const rect = el.getBoundingClientRect();
      const clientX = rect.width > 0 ? rect.left + rect.width / 2 : 100;
      const clientY = rect.height > 0 ? rect.top  + rect.height / 2 : 100;
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX, clientY }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, clientX, clientY }));
      el.click();
      qLog(`Clicked "${label}"`); return true;
    } catch (err) { qLog(`Click failed for "${label}":`, err); return false; }
  }

  function readQueueState() {
    const parsed = getMirroredJsonValue(QUEUE_STATE_KEY, QUEUE_STATE_MIRROR_KEY);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.expiresAt || parsed.expiresAt < now()) {
      clearQueueState();
      return null;
    }
    return parsed;
  }

  function writeQueueState(partial) {
    const prev = readQueueState() || {};
    const next = { ...prev, ...partial, updatedAt: now(), expiresAt: now() + QUEUE_CFG.STORAGE_TTL_MS };
    try {
      setMirroredJsonValue(QUEUE_STATE_KEY, QUEUE_STATE_MIRROR_KEY, next);
    } catch (err) {
      qLog('Failed to write queue state:', err);
    }
  }

  function clearQueueState() {
    clearMirroredJsonValue(QUEUE_STATE_KEY, QUEUE_STATE_MIRROR_KEY);
  }

  async function waitFor(fn, timeoutMs, intervalMs = QUEUE_CFG.POLL_INTERVAL_MS) {
    // Chrome throttles timers to ≥1000 ms in background tabs — use at least 1000 ms
    // interval when hidden so we don't spin-wait on throttled sleeps and waste the budget.
    const effectiveInterval = document.hidden ? Math.max(intervalMs, 1000) : intervalMs;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      try { const result = fn(); if (result) return result; } catch (_) {}
      await sleep(effectiveInterval);
    }
    return null;
  }

  async function waitForAcceptCountChange(previousCount, timeoutMs) {
    return waitFor(() => {
      const currentCount = getAcceptButtons().length;
      return currentCount !== previousCount ? currentCount : null;
    }, timeoutMs);
  }

  async function resumeIfNeeded() {
    const state = readQueueState();
    if (!state) return false;
    const acceptCount = getAcceptButtons().length;
    if (state.stage === 'send_clicked') {
      qLog('Resume mode: previous page probably reloaded after SEND.');
      emitDiag('order_activity', {
        page: 'liveOrderWin',
        action: 'resume_after_send_clicked',
        orderCode: state.orderCode || ''
      });
      const sendResult = readSendResult();
      if (!sendResult) {
        const maxResumeRetries = document.hidden ? 8 : 2;
        const retryCount = state.resumeRetryCount || 0;
        if (retryCount < maxResumeRetries) {
          qLog(`Resume: No SEND signal. Retry ${retryCount + 1}/${maxResumeRetries}, keeping state.`);
          writeQueueState({ ...state, resumeRetryCount: retryCount + 1 });
          setProcessingLock(false); return true;
        }
        qLog('Resume: No SEND signal after retries. Aborting.');
        clearQueueState(); setProcessingLock(false); return true;
      }
      if (sendResult.status !== 'ok' && sendResult.status !== 'skipped') {
        qLog(`Resume aborted: SEND was ${sendResult.status} for order ${sendResult.orderCode}`);
        clearSendResult(); clearQueueState(); setProcessingLock(false); return true;
      }
      if (acceptCount <= 0) {
        qLog('Resume: SEND was ok but no ACCEPT buttons found.');
        clearSendResult(); clearQueueState(); setProcessingLock(false); return false;
      }
      const orderCode = sendResult.orderCode || state.orderCode || '';
      const acceptBtn = findAcceptButtonForOrder(orderCode);
      if (!acceptBtn) {
        qLog(`Resume: Cannot find ACCEPT button for order #${orderCode}. Aborting.`);
        clearSendResult(); clearQueueState(); setProcessingLock(false); return true;
      }
      const beforeCount = acceptCount;
      const clicked = queueClick(acceptBtn, QUEUE_CFG.ACCEPT_TEXT);
      if (!clicked) { setProcessingLock(false); return true; }
      emitDiag('order_activity', {
        page: 'liveOrderWin',
        action: 'resume_accept_clicked',
        orderCode
      });
      writeQueueState({ stage: 'accept_clicked', beforeAcceptCount: beforeCount, orderCode });
      await waitForAcceptCountChange(beforeCount, withHiddenTimeout(QUEUE_CFG.WAIT_ACCEPT_CHANGE_TIMEOUT_MS));
      await sleep(withHiddenTimeout(QUEUE_CFG.AFTER_ACCEPT_SETTLE_MS));
      clearSendResult(); clearQueueState(); setProcessingLock(false);
      return true;
    }
    if (state.stage === 'accept_clicked') {
      qLog('Resume mode: ACCEPT was already clicked, short settle...');
      await sleep(700); clearQueueState(); setProcessingLock(false); return true;
    }
    if (state.stage === 'done') { clearQueueState(); setProcessingLock(false); return false; }
    return false;
  }

  async function waitForSendResult(timeoutMs) {
    return waitFor(() => readSendResult(), timeoutMs);
  }

  async function processOneOrder() {
    const cycleStartedAt = now();
    let sendResultAt = 0;
    let acceptClickedAt = 0;
    const acceptButtons    = getAcceptButtons();
    const acceptCountBefore = acceptButtons.length;
    if (acceptCountBefore <= 0) { clearQueueState(); return false; }
    const targetAcceptButton = acceptButtons[0];
    const expectedOrderCode = getOrderCodeForAcceptButton(targetAcceptButton);
    emitDiag('order_activity', {
      page: 'liveOrderWin',
      action: 'cycle_start',
      acceptCountBefore,
      orderCode: expectedOrderCode,
      expectedOrderCode
    });
    if (!expectedOrderCode) {
      qLog('Cannot read the order code belonging to the ACCEPT button. Abort before SEND.');
      emitDiag('order_activity', {
        page: 'liveOrderWin',
        action: 'cycle_blocked_missing_order_identity',
        acceptCountBefore
      });
      return false;
    }
    queueExpectedOrderCode = expectedOrderCode;
    const matchingPanel = await ensureOrderPanelMatches(expectedOrderCode, targetAcceptButton);
    if (!matchingPanel) {
      qLog(`Panel did not switch to #${expectedOrderCode}. Abort before SEND.`);
      emitDiag('order_activity', {
        page: 'liveOrderWin',
        action: 'cycle_blocked_panel_identity_mismatch',
        orderCode: expectedOrderCode,
        expectedOrderCode,
        acceptCountBefore
      });
      return false;
    }
    const sendBtn = findGlobalSendButton();
    if (!sendBtn) {
      qLog(`Cannot find global "${QUEUE_CFG.SEND_TEXT}" button.`);
      emitDiag('order_activity', {
        page: 'liveOrderWin',
        action: 'cycle_blocked_missing_send_button',
        acceptCountBefore
      });
      return false;
    }
    qLog(`Detected ${acceptCountBefore} ACCEPT button(s). Start one cycle.`);
    clearSendResult();
    if (!setProcessingLock(true)) {
      qLog('Could not acquire processing lock (another tab is processing).');
      return false;
    }
    const sendClicked = queueClick(sendBtn, QUEUE_CFG.SEND_TEXT);
    if (!sendClicked) { setProcessingLock(false); return false; }
    writeQueueState({ stage: 'send_clicked', beforeAcceptCount: acceptCountBefore, cycleStartedAt: now(), orderCode: expectedOrderCode });
    const sendResult = await waitForSendResult(withHiddenTimeout(QUEUE_CFG.WAIT_SEND_SIGNAL_TIMEOUT_MS));
    if (!sendResult) {
      qLog('No SEND result signal within timeout. Aborting cycle.');
      emitDiag('order_activity', {
        page: 'liveOrderWin',
        action: 'send_timeout_no_signal',
        acceptCountBefore
      });
      clearQueueState(); setProcessingLock(false); return false;
    }
    emitDiag('order_activity', {
      page: 'liveOrderWin',
      action: 'send_result',
      status: sendResult.status || '',
      orderCode: sendResult.orderCode || '',
      acceptCountBefore,
      sinceCycleStartMs: Math.max(0, now() - cycleStartedAt)
    });
    sendResultAt = now();
    if (sendResult.status === 'skipped') {
      // 'skipped' = dedup: cùng orderCode vừa được gửi trong 5 phút qua.
      // Trong fresh cycle (không phải resume), điều này hầu như chắc chắn là
      // UI đang hiển thị sai đơn hàng (detail panel vẫn còn data của đơn cũ
      // đã xử lý xong). KHÔNG click Annehmen — nếu click sẽ accept nhầm đơn
      // khác qua "1-button fallback" của findAcceptButtonForOrder.
      // Abort + ngủ 3s để UI cập nhật sang đơn tiếp theo, rồi retry.
      qLog(`SEND skipped (dedup) for order #${sendResult.orderCode} — UI likely showing wrong order. Aborting, will retry in 3s.`);
      clearSendResult(); clearQueueState(); setProcessingLock(false);
      await sleep(3000); // để UI settle về đơn đang chờ xử lý
      return false;
    }
    if (sendResult.status !== 'ok') {
      qLog(`SEND was ${sendResult.status} for order ${sendResult.orderCode}. Skipping ACCEPT.`);
      clearSendResult(); clearQueueState(); setProcessingLock(false); return false;
    }
    const sentOrderCode = sendResult.orderCode || '';
    if (normLower(sentOrderCode) !== normLower(expectedOrderCode)) {
      qLog(`SEND returned #${sentOrderCode}, expected #${expectedOrderCode}. Abort before ACCEPT.`);
      emitDiag('order_activity', {
        page: 'liveOrderWin',
        action: 'send_identity_mismatch',
        expectedOrderCode,
        orderCode: sentOrderCode,
        acceptCountBefore
      });
      clearSendResult(); clearQueueState(); setProcessingLock(false); return false;
    }
    qLog(`SEND ok for order #${sentOrderCode}. Proceeding to ACCEPT.`);
    emitDiag('order_activity', {
      page: 'liveOrderWin',
      action: 'accept_attempt',
      orderCode: sentOrderCode,
      acceptCountBefore,
      sinceSendResultMs: sendResultAt > 0 ? Math.max(0, now() - sendResultAt) : null
    });
    writeQueueState({ stage: 'send_clicked', beforeAcceptCount: acceptCountBefore, orderCode: sentOrderCode, cycleStartedAt: now() });
    const acceptBtn = findAcceptButtonForOrder(sentOrderCode);
    if (!acceptBtn) {
      qLog('No ACCEPT button found for the sent order. Stop this cycle.');
      clearSendResult(); clearQueueState(); setProcessingLock(false); return false;
    }
    const acceptClicked = queueClick(acceptBtn, QUEUE_CFG.ACCEPT_TEXT);
    if (!acceptClicked) { setProcessingLock(false); return false; }
    emitDiag('order_activity', {
      page: 'liveOrderWin',
      action: 'accept_clicked',
      orderCode: sentOrderCode,
      acceptCountBefore,
      sinceSendResultMs: sendResultAt > 0 ? Math.max(0, now() - sendResultAt) : null
    });
    acceptClickedAt = now();
    writeQueueState({ stage: 'accept_clicked', beforeAcceptCount: acceptCountBefore, orderCode: sentOrderCode });
    const changedCount = await waitForAcceptCountChange(acceptCountBefore, withHiddenTimeout(QUEUE_CFG.WAIT_ACCEPT_CHANGE_TIMEOUT_MS));
    if (changedCount !== null) {
      qLog(`ACCEPT count changed: ${acceptCountBefore} -> ${changedCount}`);
    } else {
      qLog('ACCEPT count did not change within timeout; continuing with settle wait.');
    }
    await sleep(withHiddenTimeout(QUEUE_CFG.AFTER_ACCEPT_SETTLE_MS));
    writeQueueState({ stage: 'done', lastDoneAt: now() });
    const remaining = getAcceptButtons().length;
    qLog(`Cycle finished. Remaining ACCEPT buttons: ${remaining}`);
    emitDiag('order_activity', {
      page: 'liveOrderWin',
      action: 'cycle_done',
      orderCode: sentOrderCode,
      acceptCountBefore,
      remainingAcceptCount: remaining,
      durationMs: Math.max(0, now() - cycleStartedAt),
      sendPhaseMs: sendResultAt > 0 ? Math.max(0, sendResultAt - cycleStartedAt) : null,
      acceptPhaseMs: (acceptClickedAt > 0 && sendResultAt > 0) ? Math.max(0, acceptClickedAt - sendResultAt) : null,
      settlePhaseMs: acceptClickedAt > 0 ? Math.max(0, now() - acceptClickedAt) : null
    });
    clearSendResult(); clearQueueState(); setProcessingLock(false);
    return true;
  }

  async function processQueue() {
    // No document.hidden guard — script must run reliably even in background tabs.
    if (queueInFlight) return;
    const lastCycle = getLastCycleAt();
    if (lastCycle > 0 && now() - lastCycle < QUEUE_CFG.MIN_CYCLE_GAP_MS) {
      qLog(`Cooldown active: ${Math.round((QUEUE_CFG.MIN_CYCLE_GAP_MS - (now() - lastCycle)) / 1000)}s remaining`);
      return;
    }
    const pendingState = readQueueState();
    const hasResumableState = pendingState
      && (pendingState.stage === 'send_clicked' || pendingState.stage === 'accept_clicked');
    const acceptCountBeforeStart = getAcceptButtons().length;
    if (!hasResumableState && acceptCountBeforeStart <= 0) {
      if (pendingState && pendingState.stage === 'done') clearQueueState();
      return;
    }
    setQueueInFlight(true);
    try {
      const resumed = await resumeIfNeeded();
      if (resumed) { setLastCycleAt(now()); return; }
      const acceptCount = getAcceptButtons().length;
      if (acceptCount <= 0) { clearQueueState(); return; }
      const cycleWorked = await processOneOrder();
      if (cycleWorked) setLastCycleAt(now());
    } catch (err) {
      qLog('processQueue error:', err);
      logError('processQueue', err);
      // KHÔNG dùng alert() ở đây — code này tự chạy 24/7, alert() sẽ freeze renderer
    } finally {
      queueExpectedOrderCode = '';
      setQueueInFlight(false);
    }
  }

  function scheduleQueue() {
    // No document.hidden guard — allow scheduling from background tab observers.
    if (queueObserverDebounce) clearTimeout(queueObserverDebounce);
    queueObserverDebounce = setTimeout(() => { processQueue(); }, QUEUE_CFG.OBSERVER_DEBOUNCE_MS);
  }

  function installQueue() {
    qLog('Queue module started on:', location.href);
    const observer = new MutationObserver(() => { scheduleQueue(); });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('visibilitychange', () => {
      // Always re-trigger on visibility change (both show and hide transitions).
      processQueue();
    });

    // ── Web Worker keep-alive ────────────────────────────────────────────────
    // Chrome throttles setTimeout/setInterval in background tabs to ≥1 Hz.
    // Web Workers are NOT throttled — use one to drive queue scans reliably
    // even when the tab is in the background.
    try {
      const workerSrc = 'setInterval(function(){ self.postMessage("tick"); }, ' + QUEUE_CFG.SCAN_INTERVAL_MS + ');';
      const workerBlob = new Blob([workerSrc], { type: 'application/javascript' });
      const workerUrl  = URL.createObjectURL(workerBlob);
      const keepAliveWorker = new Worker(workerUrl);
      URL.revokeObjectURL(workerUrl); // giải phóng blob URL ngay sau khi Worker khởi tạo
      let workerFallbackStarted = false;
      keepAliveWorker.onmessage = function () { processQueue(); };
      keepAliveWorker.onerror   = function (e) {
        qLog('keepAliveWorker error:', e);
        if (!workerFallbackStarted) {
          workerFallbackStarted = true;
          setInterval(() => { processQueue(); }, QUEUE_CFG.SCAN_INTERVAL_MS);
          qLog('Fallback setInterval activated after keepAliveWorker crash');
        }
      };
      qLog('Web Worker keep-alive started (background-safe scanning)');
    } catch (e) {
      // Fallback: plain setInterval (will be throttled in background)
      qLog('Web Worker unavailable, falling back to setInterval:', e);
      setInterval(() => { processQueue(); }, QUEUE_CFG.SCAN_INTERVAL_MS);
    }

    // ── Stale-page / dead-WebSocket detector v2 (cross-tab aware) ───────────
    // v1 bug: tick đồng hồ ("15 min"→"14 min") liên tục reset timer
    // → WebSocket chết nhưng detector không bao giờ kích hoạt reload.
    // v2: chỉ đếm mutation ĐÁNG KỂ + cross-tab check với Autofertig.
    // Nếu Autofertig vẫn nhận live data (DOM fresh) mà trang này đơ → reload ngay.
    const QUEUE_STALE_RELOAD_MS  = 2.5 * 60 * 1000;  // 2 phút 30 giây không mutation đáng kể → reload
    const QUEUE_MAX_AGE_MS       = 30 * 60 * 1000; // reload định kỳ sau 30 phút
    const AUTOFERTIG_ALIVE_KEY   = 'thaiasia_autofertig_dom_alive';
    const ALLINONE_ALIVE_KEY     = 'thaiasia_allinone_dom_alive';
    const CROSS_TAB_LAG_MS       = 100 * 1000;     // Autofertig mới hơn 1 phút 40 giây → AllInOne stale
    const DOM_STALE_RELOAD_ENABLED = false;        // DOM yên lặng không còn là bằng chứng trang chết
    const STALE_DEBUG_LOG_KEY    = 'thaiasia_stale_debug_logs';
    const STALE_DEBUG_MAX_LOGS   = 300;
    let _qLastSigMutAt  = Date.now();
    const _qPageStartAt = Date.now();
    let _qLastDiagSnapshotAt = 0;
    function qAppendStaleDebugLog(reason, details, emitConsole = false) {
      try {
        const ts = new Date().toISOString();
        const row = { ts, module: 'allinone', reason, ...(details || {}) };
        const logs = JSON.parse(localStorage.getItem(STALE_DEBUG_LOG_KEY) || '[]');
        logs.push(row);
        while (logs.length > STALE_DEBUG_MAX_LOGS) logs.shift();
        localStorage.setItem(STALE_DEBUG_LOG_KEY, JSON.stringify(logs));
        if (emitConsole) console.warn('[ThaiAsia allinone stale]', reason, ts, details || {});
        if (String(reason || '').startsWith('RELOAD_')) {
          emitDiag('reload', {
            page: 'liveOrderWin',
            reason: String(reason || ''),
            details: details || {}
          });
        }
      } catch (_) {}
    }
    function qIsSignificantMutation(m) {
      if (m.type !== 'childList') return false;
      if (m.addedNodes.length + m.removedNodes.length >= 5) return true;
      for (const node of [...m.addedNodes, ...m.removedNodes]) {
        if ((node.textContent || '').trim().length > 40) return true;
      }
      return false;
    }
    const qStaleObs = new MutationObserver((mutations) => {
      if (mutations.some(qIsSignificantMutation)) {
        _qLastSigMutAt = Date.now();
        try { localStorage.setItem(ALLINONE_ALIVE_KEY, String(_qLastSigMutAt)); } catch (_) {}
      }
    });
    qStaleObs.observe(document.body, { childList: true, subtree: true });
    setInterval(() => {
      if (queueInFlight) return; // đang xử lý đơn → không reload
      const checkAt = Date.now();
      const staleAgeMs = checkAt - _qLastSigMutAt;
      const pageAgeMs  = checkAt - _qPageStartAt;
      if (checkAt - _qLastDiagSnapshotAt >= 60 * 1000) {
        _qLastDiagSnapshotAt = checkAt;
        qAppendStaleDebugLog('HEALTH_SNAPSHOT', {
          checkAt,
          staleAgeMs,
          pageAgeMs,
          staleThresholdMs: QUEUE_STALE_RELOAD_MS,
          maxAgeThresholdMs: QUEUE_MAX_AGE_MS,
          crossTabLagMs: CROSS_TAB_LAG_MS,
          queueInFlight
        });
      }
      // Cross-tab: Autofertig DOM mới hơn CROSS_TAB_LAG_MS so với AllInOne → AllInOne stale
      try {
        const afAlive = Number(localStorage.getItem(AUTOFERTIG_ALIVE_KEY) || '0');
        if (DOM_STALE_RELOAD_ENABLED && afAlive > 0 && (afAlive - _qLastSigMutAt) > CROSS_TAB_LAG_MS) {
          qAppendStaleDebugLog('RELOAD_CROSS_TAB', {
            checkAt,
            afAlive,
            allinoneAlive: _qLastSigMutAt,
            crossDeltaMs: afAlive - _qLastSigMutAt,
            crossTabLagMs: CROSS_TAB_LAG_MS
          }, true);
          qLog('⚠️ Cross-tab: Autofertig DOM ' + Math.round((afAlive - _qLastSigMutAt) / 1000) + 's mới hơn AllInOne → AllInOne stale → reload');
          location.reload(); return;
        }
      } catch (_) {}
      const stale  = staleAgeMs > QUEUE_STALE_RELOAD_MS;
      const tooOld = pageAgeMs  > QUEUE_MAX_AGE_MS;
      if (DOM_STALE_RELOAD_ENABLED && (stale || tooOld)) {
        qAppendStaleDebugLog('RELOAD_STALE_OR_AGE', {
          checkAt,
          stale,
          tooOld,
          staleAgeMs,
          pageAgeMs,
          staleThresholdMs: QUEUE_STALE_RELOAD_MS,
          maxAgeThresholdMs: QUEUE_MAX_AGE_MS
        }, true);
        qLog('⚠️ Stale connection hoặc trang quá cũ → reload để khôi phục WebSocket');
        location.reload();
      }
    }, 20 * 1000); // kiểm tra mỗi 20 giây
    qLog('Evidence-based health monitor active; DOM-stale reload disabled');

    processQueue();
  }

  // ============================================================
  // ===== ÜBERGABE MODULE (Klickübergabe v1.1.0) =====
  // ============================================================

  function getUbergabeLastClickedAt() {
    try { return Number(sessionStorage.getItem(UBERGABE_LAST_CLICK_KEY) || '0'); } catch (_) { return 0; }
  }
  function setUbergabeLastClickedAt(ts) {
    try { sessionStorage.setItem(UBERGABE_LAST_CLICK_KEY, String(ts)); } catch (_) {}
  }

  function isAutoSendProcessing() {
    try {
      const lockTs = Number(sessionStorage.getItem(PROCESSING_LOCK_KEY) || '0');
      if (lockTs > 0 && (now() - lockTs) < UB_PROCESSING_LOCK_MAX_AGE) return true;
      const state = readQueueState();
      if (state) {
        const stage     = (state.stage     || '').toString();
        const expiresAt = Number(state.expiresAt || 0);
        const updatedAt = Number(state.updatedAt || 0);
        if ((stage === 'send_clicked' || stage === 'accept_clicked') &&
            ((expiresAt > now()) || (updatedAt > 0 && now() - updatedAt < UB_PROCESSING_LOCK_MAX_AGE))) return true;
      }
      const raw = sessionStorage.getItem(SEND_RESULT_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.ts && (now() - parsed.ts) < UB_SEND_SIGNAL_MAX_AGE) return true;
        } catch (_) {}
      }
      return false;
    } catch (_) { return false; }
  }

  function getAllUbergabeCandidates() {
    return Array.from(document.querySelectorAll(['button','[role="button"]','a','div','span'].join(','))).filter((el) => {
      const text = normLower(el.innerText || el.textContent);
      return (
        text === 'übergabe' || text.includes('übergabe') ||
        text === 'zubereiten' || text.includes('zubereiten') ||
        text === 'okay' || text.includes('okay')
      );
    });
  }

  function findBottomUbergabeButton() {
    const candidates = getAllUbergabeCandidates().filter(isVisible).filter((el) => !isDisabled(el));
    if (!candidates.length) return null;
    const scored = candidates.map((el) => {
      const rect  = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      let score = 0;
      score += rect.top;
      score += rect.left * 0.3;
      if (el.tagName.toLowerCase() === 'button') score += 200;
      const bg = style.backgroundColor || '';
      if (bg.includes('255, 128') || bg.includes('255, 145') || bg.includes('255, 153') || bg.includes('orange')) score += 150;
      if (rect.top < window.innerHeight * 0.55) score -= 500;
      score += rect.width * 0.2 + rect.height * 0.5;
      return { el, score };
    }).sort((a, b) => b.score - a.score);
    uLog('Übergabe candidates:', scored);
    return scored[0]?.el || null;
  }

  function safeUbergabeClick(el) {
    if (!el) return false;
    if (ubClickInProgress) return false;
    const n = now();
    if (n - getUbergabeLastClickedAt() < UB_CLICK_COOLDOWN_MS) return false;
    const text = normLower(el.innerText || el.textContent);
    const rect = el.getBoundingClientRect();
    uLog('Clicking Übergabe:', text, rect);
    ubClickInProgress = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    setTimeout(() => {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true }));
      el.click();
      setUbergabeLastClickedAt(now());
      setTimeout(() => { ubClickInProgress = false; }, 1000);
    }, 150);
    return true;
  }

  function tryUbergabeClick() {
    if (isAutoSendProcessing()) { uLog('Auto Queue is processing, skipping Übergabe click'); return; }
    const btn = findBottomUbergabeButton();
    if (!btn) return;
    safeUbergabeClick(btn);
  }

  function installUbergabe() {
    uLog('Übergabe module started');
    // Use a Web Worker keep-alive for Übergabe too so the 2 s interval is not
    // throttled when the tab is in the background.
    try {
      const ubWorkerSrc = 'setInterval(function(){ self.postMessage("ub"); }, 2000);';
      const ubBlob = new Blob([ubWorkerSrc], { type: 'application/javascript' });
      const ubWorkerUrl = URL.createObjectURL(ubBlob);
      const ubWorker = new Worker(ubWorkerUrl);
      URL.revokeObjectURL(ubWorkerUrl); // giải phóng blob URL ngay sau khi Worker khởi tạo
      let ubFallbackStarted = false;
      ubWorker.onmessage = function () { tryUbergabeClick(); };
      ubWorker.onerror   = function (e) {
        uLog('ubWorker error:', e);
        if (!ubFallbackStarted) {
          ubFallbackStarted = true;
          setInterval(tryUbergabeClick, 2000);
          uLog('Fallback setInterval activated after ubWorker crash');
        }
      };
    } catch (e) {
      uLog('Übergabe Web Worker unavailable, falling back to setInterval:', e);
      setInterval(tryUbergabeClick, 2000);
    }
    let ubDebounce = null;
    const observer = new MutationObserver(() => {
      if (ubDebounce) clearTimeout(ubDebounce);
      ubDebounce = setTimeout(() => { tryUbergabeClick(); }, 800);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ============================================================
  // ===== BOOTSTRAP =====
  // ============================================================

  function bootstrap() {
    const host = location.hostname;
    if (host.includes('live-orders.takeaway.com')) {
      // Install all three takeaway-side modules
      installTakeawayBridge();
      installQueue();
      installUbergabe();
      log('All modules started on takeaway.com');
    } else if (host.includes('api.thaiasiasushibar.de') || host.includes('www.api.thaiasiasushibar.de')) {
      // Install admin-side bridge only
      installThaiAsiaAdmin();
      log('Admin bridge module started on thaiasiasushibar.de');
    }
  }

  bootstrap();
})();
