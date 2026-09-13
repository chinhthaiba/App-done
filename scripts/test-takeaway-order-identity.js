'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ThaiAsia-AllInOneapp.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const reportScript = fs.readFileSync(path.join(root, 'scripts', 'generate-root-report.js'), 'utf8');

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract ${startMarker}`);
  return text.slice(start, end);
}

assert(source.includes('const DEDUP_WINDOW_MS       = 24 * 60 * 60 * 1000;'), 'Automatic duplicate protection must cover a full day');
assert(!source.includes('Using it as fallback.'), 'A single ACCEPT button must never bypass order-code matching');
assert(source.includes('NOT falling back (identity safety)'), 'Strict ACCEPT identity guard must remain enabled');
assert(source.includes("action: 'cycle_blocked_panel_identity_mismatch'"), 'Panel identity failures must be reported');
assert(source.includes("action: 'send_identity_mismatch'"), 'Payload identity failures must stop before ACCEPT');
assert(source.includes('const hasUnambiguousIdentity = panelOrderCodes.length === 1;'), 'A mixed old/new page must not be accepted as an order panel');
assert(source.includes('return stableReads >= 3 ? currentPanel : null;'), 'Order details must remain stable across repeated reads before SEND');

const processOneOrder = between(source, '  async function processOneOrder()', '  async function processQueue()');
const panelGuardAt = processOneOrder.indexOf('await ensureOrderPanelMatches(expectedOrderCode, targetAcceptButton)');
const sendButtonAt = processOneOrder.indexOf('const sendBtn = findGlobalSendButton()');
assert(panelGuardAt >= 0 && sendButtonAt > panelGuardAt, 'The correct detail panel must be proven before SEND/Admin opens');
assert(processOneOrder.includes('normLower(sentOrderCode) !== normLower(expectedOrderCode)'), 'SEND result must match the pending order before ACCEPT');
const autoSendFlow = between(source, '        if (isAuto) {', '        // 2. Luồng THỦ CÔNG');
assert(autoSendFlow.indexOf('const tabRef = openThaiAsiaInBackground(storageKey)') < autoSendFlow.lastIndexOf("writeSendResultSignal('ok', payload.orderCode)"), 'Queue may proceed only after the bound Admin window was requested successfully');

const context = {};
vm.createContext(context);
const normalizeText = between(source, '  function normalizeText(text)', '  function normalizeComparableText');
const containsCode = between(source, '  function textContainsOrderCode(', '  function findOrderPanel(');
const acceptCode = between(source, '  function getOrderCodeForAcceptButton(', '  function getOrderContainerForAcceptButton(');
vm.runInContext(`${normalizeText}\n${containsCode}\n${acceptCode}\nthis.textContainsOrderCode=textContainsOrderCode;this.getOrderCodeForAcceptButton=getOrderCodeForAcceptButton;`, context);

assert.strictEqual(context.textContainsOrderCode('Neue Bestellung #MDF3XF Annehmen', 'MDF3XF'), true);
assert.strictEqual(context.textContainsOrderCode('Alte Bestellung #7JQGCH', 'MDF3XF'), false);
const fakeButton = {
  parentElement: {
    innerText: 'MDF3XF\nLieferung\nAnnehmen',
    textContent: '',
    parentElement: null
  }
};
assert.strictEqual(context.getOrderCodeForAcceptButton(fakeButton), 'MDF3XF');

const oldPanel = {
  innerText: '#7JQGCH Bestellung angenommen Bestätigungscode: 1234 3 Gerichte Zwischensumme EUR 20,00 +491751234567',
  getBoundingClientRect: () => ({ left: 600, width: 400, height: 500 })
};
const mixedPageContainer = {
  innerText: '#MDF3XF Annehmen #7JQGCH Bestellung angenommen Bestätigungscode: 1234 3 Gerichte Zwischensumme EUR 20,00 +491751234567',
  getBoundingClientRect: () => ({ left: 0, width: 1000, height: 800 })
};
const currentPanel = {
  innerText: '#MDF3XF Bestellung angenommen Bestätigungscode: 5678 2 Gerichte Zwischensumme EUR 18,00 +491759876543',
  getBoundingClientRect: () => ({ left: 600, width: 400, height: 500 })
};
context.stripUiNoise = value => String(value || '');
context.isVisible = () => true;
context.window = { innerWidth: 1000 };
context.document = { querySelectorAll: () => [oldPanel, mixedPageContainer] };
const findPanel = between(source, '  function findOrderPanel(', '  function textLinesFrom(');
vm.runInContext(`${findPanel}\nthis.findOrderPanel=findOrderPanel;`, context);
assert.strictEqual(context.findOrderPanel('MDF3XF'), null, 'A root container mixing the new code with old details must be rejected');
context.document.querySelectorAll = () => [oldPanel, mixedPageContainer, currentPanel];
assert.strictEqual(context.findOrderPanel('MDF3XF'), currentPanel, 'Only the unambiguous panel for the pending code may be captured');

for (const reportSource of [main, reportScript]) {
  assert(reportSource.includes('ĐƠN BỊ TẠO LẶP TRÊN ADMIN'), 'Report must flag duplicate Admin creation');
  assert(reportSource.includes('ĐÃ ĐIỀN FORM - CHƯA XÁC NHẬN TẠO ĐƠN'), 'A filled form without confirmed Submit must not count as success');
  assert(reportSource.includes('mã đơn bị tạo lặp trên Admin'), 'System warning must list duplicated order codes');
  assert(reportSource.includes("(isSuccess ? 'Đã xử lý' : 'Chưa hoàn tất')"), 'Incomplete orders must not be labelled as processed');
}

console.log('takeaway order identity tests: OK');
