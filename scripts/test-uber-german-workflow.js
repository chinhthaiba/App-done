'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'UberEats-Bridge.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const reportScript = fs.readFileSync(path.join(root, 'scripts', 'generate-root-report.js'), 'utf8');

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract section starting at ${startMarker}`);
  return text.slice(start, end);
}

const startDeliveryFinder = between(
  bridge,
  '  function findBatDauGiaoHangBtn()',
  '  function findCloseOrderModalBtn'
);
assert(startDeliveryFinder.includes("findByText('lieferung beginnen'"), 'German label "Lieferung beginnen" must be clickable');
assert(startDeliveryFinder.includes("findByText('auslieferung beginnen'"), 'German delivery-label fallback must remain supported');

const germanLabelUses = bridge.match(/lieferung beginnen/g) || [];
assert(germanLabelUses.length >= 5, 'German label must also be excluded from item/address parsing');

const onlineRecovery = between(
  bridge,
  '  // Phục hồi sau khi máy sleep/wake-up hoặc mất mạng.',
  '\n})();'
);
assert(onlineRecovery.includes("window.addEventListener('offline'"), 'Online recovery must require a real offline event first');
assert(onlineRecovery.includes('ONLINE_RECOVERY_STABLE_MS = 10 * 1000'), 'Network must be stable before Uber reloads');
assert(onlineRecovery.includes('ONLINE_RECOVERY_SHORT_COOLDOWN_MS = 10 * 60 * 1000'), 'Short network flaps must be rate-limited');
assert(onlineRecovery.includes('hasOpenOrder = !!findOrderModal()'), 'An open Uber order must block recovery reload');
assert(onlineRecovery.includes("sessionStorage.setItem(ONLINE_RECOVERY_LAST_RELOAD_KEY"), 'Reload cooldown must survive a page reload');

function createOnlineRecoveryHarness() {
  let now = 1000;
  let nextTimerId = 1;
  let openOrder = false;
  let reloadCount = 0;
  const timers = [];
  const handlers = new Map();
  const storage = new Map();
  const navigator = { onLine: true };
  const window = {
    __thaiasiaOrderProcessing: false,
    location: { reload() { reloadCount += 1; } },
    addEventListener(name, listener) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(listener);
    }
  };
  const context = {
    Date: { now: () => now },
    navigator,
    window,
    sessionStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    setTimeout(fn, delay) {
      const timer = { id: nextTimerId++, at: now + Number(delay || 0), fn, cancelled: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const timer = timers.find(row => row.id === id);
      if (timer) timer.cancelled = true;
    },
    findOrderModal: () => openOrder ? {} : null,
    _state: 'idle',
    _orderQueue: [],
    dbg() {},
    emitDiag() {}
  };
  vm.createContext(context);
  vm.runInContext(onlineRecovery, context);

  const runDueTimers = () => {
    let ran = true;
    while (ran) {
      ran = false;
      const due = timers
        .filter(timer => !timer.cancelled && timer.at <= now)
        .sort((a, b) => a.at - b.at)[0];
      if (due) {
        due.cancelled = true;
        due.fn();
        ran = true;
      }
    }
  };
  return {
    fire(name) { for (const listener of handlers.get(name) || []) listener(); },
    setOnline(value) { navigator.onLine = value; },
    setOpenOrder(value) { openOrder = value; },
    advance(ms) { now += ms; runDueTimers(); },
    reloadCount: () => reloadCount
  };
}

const recovery = createOnlineRecoveryHarness();
recovery.fire('online');
recovery.advance(20000);
assert.strictEqual(recovery.reloadCount(), 0, 'A standalone online event must never reload Uber');

recovery.setOnline(false);
recovery.fire('offline');
recovery.advance(2000);
recovery.setOnline(true);
recovery.fire('online');
recovery.advance(10000);
assert.strictEqual(recovery.reloadCount(), 1, 'The first confirmed network recovery should reload Uber safely');

recovery.setOnline(false);
recovery.fire('offline');
recovery.advance(2000);
recovery.setOnline(true);
recovery.fire('online');
recovery.advance(10000);
assert.strictEqual(recovery.reloadCount(), 1, 'Repeated short network flaps must respect cooldown');

recovery.setOnline(false);
recovery.fire('offline');
recovery.advance(15000);
recovery.setOnline(true);
recovery.fire('online');
recovery.setOpenOrder(true);
recovery.advance(10000);
assert.strictEqual(recovery.reloadCount(), 1, 'An open order must postpone even long-outage recovery');
recovery.setOpenOrder(false);
recovery.advance(3000);
assert.strictEqual(recovery.reloadCount(), 2, 'A long outage must recover as soon as the open order is safe');

const captureFlow = between(bridge, '  async function captureOrder(', '  // ── Tìm thẻ đơn mới');
assert(captureFlow.includes("action: 'uber_post_accept_failed'"), 'Post-accept failures must be logged');
assert(captureFlow.includes("action: workflowCompleted ? 'uber_capture_done' : 'uber_capture_incomplete'"), 'Incomplete Uber workflows must not emit capture_done');
assert(captureFlow.includes("completionStage = 'start_delivery_clicked'"), 'Final Uber step must be tracked explicitly');

const uberWindow = between(main, "  const UBEREATS_PARTITION = 'persist:ubereats';", '  try { uberEatsWin.setTitle');
assert(uberWindow.includes('backgroundThrottling: false'), 'Uber background timers must not be throttled');

for (const source of [main, reportScript]) {
  const statusLogic = between(source, "    const hasAdminConfirmed", "    if (isUber) {");
  assert(statusLogic.includes("e.action === 'uber_start_delivery_clicked'"), 'Uber report success must require the final delivery click');
  assert(statusLogic.includes("e.action === 'uber_scheduled_marked_admin_sent'"), 'Scheduled Uber orders need their own completion signal');
  assert(statusLogic.includes('isUber && hasAdminConfirmed && hasUberCompleted'), 'Uber success must require both Admin and Uber completion');
  assert(statusLogic.includes('ADMIN ĐÃ TẠO - UBER CHƯA HOÀN TẤT'), 'Report must explain partial Uber completion');
  assert(source.includes("case 'uber_capture_incomplete':"), 'Human report must show incomplete Uber workflows');
  assert(source.includes('đơn Uber Eats chưa hoàn tất bước cuối'), 'System summary must not claim that an incomplete Uber order is stable');
  assert(source.includes('Mạng vừa kết nối lại; Uber tải lại an toàn'), 'Online recovery reload must be explained in plain Vietnamese');
}

// ── Tests for German Payment and Cash Total Parsing (Image 1 vs Image 2) ──
const readPaymentCode = between(bridge, '  function readPayment(modal) {', '  /** Đọc delivery time');
const readOrderNoteCode = between(bridge, '  function readOrderNote(modal) {', '  /** Đọc yêu cầu dao nĩa');
const helpersCode = between(bridge, '  const nt  = t =>', '  function isVisible(');

const evalContext = {
  document: { innerText: '' },
  dbg() {},
  nt: t => String(t || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(),
  nct: t => String(t || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đ]/g, 'd')
};
vm.createContext(evalContext);
vm.runInContext(helpersCode, evalContext);
vm.runInContext(readPaymentCode, evalContext);
vm.runInContext(readOrderNoteCode, evalContext);

// Case 1: German cash order with separate label / amount lines (Image 3)
const germanCashSeparate = {
  innerText: [
    'Priwitzer, A. • F96AC',
    '4 Artikel 🍴 Nein Neuer Kunde',
    'Nimm bei dieser Bestellung Bargeld entgegen',
    '1 × 111. Sake Avocado Maki 5,90 €',
    '1 × 136. Kappa inside out 9,30 €',
    '2 × 143. Big Baked Chicken Roll 23,40 €',
    'Zwischensumme',
    'Liefergebühr',
    'Marketplace-Gebühr (Gebühren von Uber)',
    'Fälliger Bargeldbetrag',
    '38,60 €',
    '3,00 €',
    '3,09 €',
    '44,69 €'
  ].join('\n')
};
const p1 = evalContext.readPayment(germanCashSeparate);
assert.strictEqual(p1.paymentMethod, 'Bar', 'German order with Fälliger Bargeldbetrag must be Bar');
assert.strictEqual(p1.total, '44.69', 'Total must be 44.69, NOT 3.09 Marketplace-Gebühr');
assert.strictEqual(p1.subtotal, '38.60', 'Subtotal must be 38.60');
assert.strictEqual(p1.deliveryFee, '3.00', 'Delivery fee must be 3.00');

// Case 2: German cash order with inline lines
const germanCashInline = {
  innerText: [
    'Zwischensumme 38,60 €',
    'Liefergebühr 3,00 €',
    'Marketplace-Gebühr (Gebühren von Uber) 3,09 €',
    'Fälliger Bargeldbetrag 44,69 €'
  ].join('\n')
};
const p2 = evalContext.readPayment(germanCashInline);
assert.strictEqual(p2.paymentMethod, 'Bar', 'Inline German cash order must be Bar');
assert.strictEqual(p2.total, '44.69', 'Inline total must be 44.69');

// Case 3: Vietnamese cash order with separate lines (Image 4)
const vietCashSeparate = {
  innerText: [
    'Tổng',
    'Phí giao hàng',
    'Phí bán hàng (phí của Uber)',
    'Tiền mặt phải trả',
    '38,60 €',
    '3,00 €',
    '3,09 €',
    '44,69 €'
  ].join('\n')
};
const p3 = evalContext.readPayment(vietCashSeparate);
assert.strictEqual(p3.paymentMethod, 'Bar', 'Vietnamese cash order must be Bar');
assert.strictEqual(p3.total, '44.69', 'Vietnamese total must be 44.69');

// Case 4: German online order
const germanOnline = {
  innerText: [
    'Zwischensumme 25,50 €',
    'Liefergebühr 2,50 €',
    'Marketplace-Gebühr (Gebühren von Uber) 1,80 €',
    'Bereits bezahlt 28,00 €'
  ].join('\n')
};
const p4 = evalContext.readPayment(germanOnline);
assert.strictEqual(p4.paymentMethod, 'Online', 'German online order must be Online');
assert.strictEqual(p4.total, '28.00', 'German online total must be 28.00');

// Case 5: Verify "Nimm bei dieser Bestellung Bargeld entgegen" is skipped from order note
const noteTestModal = {
  innerText: [
    'Priwitzer, A. • F96AC',
    '4 Artikel 🍴 Nein Neuer Kunde',
    'Nimm bei dieser Bestellung Bargeld entgegen',
    '1 × 111. Sake Avocado Maki 5,90 €'
  ].join('\n')
};
const note = evalContext.readOrderNote(noteTestModal);
assert.strictEqual(note, '', 'Cash banner "Nimm bei dieser..." must NOT be included in order note');

// ── Tests for Modal Close Button Discovery (Multilingual & SVG icons) ──
const closeBtnCode = between(bridge, '  function findCloseOrderModalBtn(', '  /** Đóng modal đơn hàng an toàn');
const closeContext = {
  nt: evalContext.nt,
  nct: evalContext.nct,
  isVisible: () => true,
  findOrderModal: () => null,
  document: {
    querySelectorAll: () => []
  }
};
vm.createContext(closeContext);
vm.runInContext(closeBtnCode, closeContext);

function createMockElement(attrs = {}, textContent = '', children = []) {
  return {
    getAttribute(name) { return attrs[name] || null; },
    textContent,
    querySelectorAll(selector) {
      if (selector === 'svg') return children.filter(c => c._tag === 'svg');
      if (selector.includes('button')) return children.filter(c => c._tag === 'button');
      return [];
    },
    getBoundingClientRect() { return { width: 40, height: 40, top: 10, left: 10 }; },
    _tag: attrs._tag || 'button'
  };
}

// 1. German aria-label: "Dialog schließen"
const btnGermanDialog = createMockElement({ 'aria-label': 'Dialog schließen' });
const modalGerman = { querySelectorAll: () => [btnGermanDialog] };
assert.strictEqual(closeContext.findCloseOrderModalBtn(modalGerman), btnGermanDialog, 'German Dialog schließen button must be found');

// 2. German aria-label: "Schließen"
const btnGerman = createMockElement({ 'aria-label': 'Schließen' });
const modalGerman2 = { querySelectorAll: () => [btnGerman] };
assert.strictEqual(closeContext.findCloseOrderModalBtn(modalGerman2), btnGerman, 'German Schließen button must be found');

// 3. Vietnamese aria-label: "Đóng"
const btnViet = createMockElement({ 'aria-label': 'Đóng' });
const modalViet = { querySelectorAll: () => [btnViet] };
assert.strictEqual(closeContext.findCloseOrderModalBtn(modalViet), btnViet, 'Vietnamese Đóng button must be found');

// 4. English aria-label: "Close modal"
const btnEng = createMockElement({ 'aria-label': 'Close modal' });
const modalEng = { querySelectorAll: () => [btnEng] };
assert.strictEqual(closeContext.findCloseOrderModalBtn(modalEng), btnEng, 'English Close modal button must be found');

// 5. SVG icon without text: <svg data-name="Cross">
const svgCross = { _tag: 'svg', getAttribute(name) { return name === 'data-name' ? 'Cross' : null; } };
const btnSvg = createMockElement({}, '', [svgCross]);
const modalSvg = { querySelectorAll: () => [btnSvg] };
assert.strictEqual(closeContext.findCloseOrderModalBtn(modalSvg), btnSvg, 'SVG Cross icon button must be found');

// 6. Direct unicode symbol: ✕
const btnUnicodeCross = createMockElement({}, '✕');
const modalUnicode = { querySelectorAll: () => [btnUnicodeCross] };
assert.strictEqual(closeContext.findCloseOrderModalBtn(modalUnicode), btnUnicodeCross, 'Unicode ✕ button must be found');

// 7. data-testid attribute: "modal-close-button"
const btnTestId = createMockElement({ 'data-testid': 'modal-close-button' });
const modalTestId = { querySelectorAll: () => [btnTestId] };
assert.strictEqual(closeContext.findCloseOrderModalBtn(modalTestId), btnTestId, 'data-testid modal-close-button must be found');

console.log('uber german workflow tests: OK');

