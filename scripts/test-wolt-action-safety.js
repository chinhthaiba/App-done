'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'Wolt-Bridge.js'), 'utf8');
const buildSource = fs.readFileSync(path.join(root, 'scripts', 'rebuild-dist-win7.js'), 'utf8');
const releaseFiles = require(path.join(root, 'updater', 'release-files.js'));
const bridge = require(path.join(root, 'Wolt-Bridge.js'));

assert(source.includes("if (name === 'accept') return /^(?:Bestellung annehmen"));
assert(source.includes("if (name === 'confirm') return /^(?:Bestätigen|Confirm"));
assert(source.includes("return /^(?:Bereit|Ready|Als bereit markieren|Mark as ready)$/i;"));
assert(source.includes('isExplicitButtonRecord(row)'));
assert(source.includes('isCompactFlutterSemanticRecord(row)'));
assert(!source.includes('const directCards = records.filter'));
assert(!source.includes("const innerButtons = element.querySelectorAll"));
assert(!source.includes('setInterval(autoClickAnyReadyButtons, 2000)'));
assert(source.includes("const DELIVERY_TIME_PREFERENCE = Object.freeze(['20', '25', '30'"));
assert(source.includes('function findDeliveryTimeOption(records)'));
assert(source.includes('function resolveDeliveryConfirmation(orderNumber, timeoutMs)'));
assert(source.includes("log('wolt_confirmation_probe'"));
assert(source.includes("log('wolt_delivery_time_selected'"));
assert(source.includes("log('wolt_confirmation_unresolved'"));
assert(source.includes("log('wolt_click_attempt'"));
assert(source.includes("log('wolt_click_dispatched'"));
assert(source.includes("log('wolt_accept_unconfirmed'"));
assert(source.includes('prior && isResumableWoltState(prior.state)'));
assert(source.includes("log('wolt_order_reconciled'"));
assert(source.includes('reconcilePersistedTask(task)'));
assert(source.includes("log('wolt_persisted_state_resume_queued'"));
assert(source.includes("opts.trigger === 'persisted_resume'"));
assert(source.includes('selectEmbeddedActionRecord('));
assert(source.includes('embeddedCardAction: actionName'));
assert(source.includes("name !== 'accept' && name !== 'ready'"));
assert(!source.includes('(task.preparationTargetTime && dateTimeText(task.preparationTargetTime))'));
assert(source.includes('const reconcileTimers = new Map()'));
assert(source.includes("now - Number(lastProcessAt.get(identity) || 0) < 5000"));
assert(buildSource.includes("require('../updater/release-files')"));
assert(releaseFiles.includes('preload-wolt.js'));
assert(releaseFiles.includes('Wolt-Bridge.js'));

const embeddedLabel = '#088Eigene LieferungErste Bestellung4 km2Bestellung annehmen';
assert.strictEqual(bridge.labelContainsOrderMarker(embeddedLabel, '088'), true);
assert.strictEqual(bridge.labelContainsOrderMarker(embeddedLabel, '88'), true);
assert.strictEqual(bridge.labelContainsOrderMarker(embeddedLabel, '089'), false);
assert.strictEqual(bridge.labelContainsOrderMarker('#0881 Bestellung annehmen', '088'), false);
assert.strictEqual(bridge.isEmbeddedAcceptLabel(embeddedLabel, '088'), true);
assert.strictEqual(bridge.isEmbeddedAcceptLabel('#089 Bestellung annehmen', '088'), false);
assert.strictEqual(bridge.isEmbeddedAcceptLabel('#088 Bestellung annehmen Weitere Aktion', '088'), false);
assert.strictEqual(bridge.isEmbeddedActionLabel('#088Bestellung annehmen', '088', 'accept'), true);
assert.strictEqual(bridge.isEmbeddedActionLabel('#088Bereit', '088', 'ready'), true);
assert.strictEqual(bridge.isEmbeddedActionLabel('#089Bereit', '088', 'ready'), false);
assert.strictEqual(bridge.isEmbeddedActionLabel('#088Bereit (0)', '088', 'ready'), false);
const flutterTextOnlyElement = {
  tagName: 'FLT-SEMANTICS',
  getAttribute: () => null
};
assert.strictEqual(bridge.isCompactFlutterSemanticRecord({
  element: flutterTextOnlyElement,
  label: 'Bereit'
}), true, 'The manually verified text-only FLT-SEMANTICS action must be clickable');
assert.strictEqual(bridge.shouldUseSemanticElementClick({
  element: flutterTextOnlyElement,
  label: 'Bestellung annehmen'
}), false, 'Critical Wolt actions like "Bestellung annehmen" must use native click, not semantic element click');
assert.strictEqual(bridge.shouldUseSemanticElementClick({
  element: flutterTextOnlyElement,
  label: 'Custom Action'
}), true, 'An exact non-critical Flutter action must use element.click()');
assert.strictEqual(bridge.shouldUseSemanticElementClick({
  element: flutterTextOnlyElement,
  label: '#088 Bestellung annehmen',
  embeddedCardAction: 'accept'
}), false, 'A whole-card fallback must not be treated as an exact semantic action');
assert.strictEqual(bridge.extractOrderNumberMarker('#089Eigene Lieferung'), '089', 'Numeric Wolt code must stop before concatenated Flutter text');
assert.strictEqual(bridge.extractOrderNumberMarker('#SIM-001'), 'SIM-001', 'Alphanumeric Wolt test code must remain supported');
assert.strictEqual(bridge.extractOrderNumberMarker('Bestellung ohne Nummer'), '');
assert(source.includes("lastActionStatus: 'dispatched_native'"), 'Native input must be described as dispatched, not confirmed successful');
assert(source.includes('left + width * 0.6'), 'Flutter click point must be relative to the matched semantic bounds');
assert(source.includes("method: 'semantic_element_click'"), 'Exact Flutter actions must use the live-tested semantic element click');
assert(source.includes("lastActionStatus: 'dispatched_semantic_element'"), 'Semantic click dispatch must not be mislabeled as confirmed success');
assert(source.includes('const readyRetryAfter = new Map()'), 'Failed Bereit attempts must be rate limited');
assert(source.includes("'mark_ready_native_fallback', { forceNative: true }"), 'Bereit must retry once with trusted input after an ignored semantic click');
assert(source.includes("log('wolt_ready_confirmation'"), 'Bereit success must require API or semantic confirmation');
assert(source.includes('/^(?:Geliefert|Delivered)$/i'), 'The next Wolt action must count as proof that Bereit succeeded');
assert(source.includes("log('wolt_native_click_failed'"), 'Native click IPC failures must remain visible in diagnostics');
assert.strictEqual(bridge.isCompactFlutterSemanticRecord({
  element: flutterTextOnlyElement,
  label: '#088 ' + 'order card '.repeat(20) + 'Bereit'
}), false, 'A whole Flutter order card must not be treated as an exact action node');
assert.deepStrictEqual(
  bridge.embeddedAcceptClickPoint({ left: 4, top: 140, width: 358, height: 250 }),
  { x: 158, y: 368 }
);

const embeddedRoot = {
  element: {},
  label: 'Menu #088 Bestellung annehmen',
  role: '',
  disabled: false,
  rect: { left: 0, top: 0, width: 1024, height: 700 }
};
const embeddedCard = {
  element: {},
  label: '#088Eigene Lieferung 5 Artikel Bestellung annehmen',
  role: '',
  disabled: false,
  rect: { left: 5, top: 140, width: 358, height: 250 }
};
const selectedAccept = bridge.selectEmbeddedActionRecord(
  [embeddedRoot, embeddedCard], '088', 'accept', 1024, 768
);
assert(selectedAccept, 'The Flutter card must be usable even without role=button');
assert.strictEqual(selectedAccept.label, embeddedCard.label);
assert.strictEqual(selectedAccept.embeddedCardAction, 'accept');

const selectedReady = bridge.selectEmbeddedActionRecord([{
  element: {},
  label: '#088Eigene Lieferung 5 Artikel Bereit',
  role: '',
  disabled: false,
  rect: { left: 430, top: 358, width: 304, height: 30 }
}], '088', 'ready', 1024, 768);
assert(selectedReady, 'A Flutter action-row rectangle must also be accepted');
assert.strictEqual(selectedReady.embeddedCardAction, 'ready');
assert.strictEqual(bridge.selectEmbeddedActionRecord([
  { ...embeddedCard, label: '#089 Bereit' }
], '088', 'ready', 1024, 768), null, 'A different order card must never be selected');

assert.strictEqual(bridge.isPreorderTask({
  createdAt: '2026-08-29T09:00:00.000Z',
  preparationTargetTime: '2026-08-29T09:30:00.000Z'
}), false, 'A normal preparation target must not turn a live order into a preorder');
assert.strictEqual(bridge.isPreorderTask({
  createdAt: '2026-08-29T09:00:00.000Z',
  preparationTargetTime: '2026-08-29T10:01:00.000Z'
}), true, 'A target more than 60 minutes away is a preorder');
assert.strictEqual(bridge.isPreorderTask({ isPreorder: true }), true);
assert.strictEqual(bridge.isPreorderTask({
  isPreorder: false,
  createdAt: '2026-08-29T09:00:00.000Z',
  preparationTargetTime: '2026-08-29T11:00:00.000Z'
}), false, 'An explicit live-order flag must override time inference');
assert.strictEqual(bridge.isPreorderTask({ status: 'confirmed_preorder' }), true);
assert.strictEqual(bridge.isResumableWoltState('admin_confirmed'), true);
assert.strictEqual(bridge.isResumableWoltState('accepted'), true);
assert.strictEqual(bridge.isResumableWoltState('ready'), false);
assert.strictEqual(bridge.isResumableWoltState(''), false);

const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
assert(mainSource.includes('requestedX * zoomFactor'), 'Wolt native input must convert DOM coordinates using the live page zoom');
assert(mainSource.includes("'[WoltNativeClick] dispatched:'"), 'Native input conversion must be logged for live verification');
const reportSource = fs.readFileSync(path.join(root, 'scripts', 'generate-root-report.js'), 'utf8');
for (const report of [mainSource, reportSource]) {
  assert(report.includes('ADMIN ĐÃ TẠO - WOLT CHƯA NHẬN ĐƠN'));
  assert(report.includes('WOLT ĐÃ NHẬN - CHƯA BẤM BEREIT'));
  assert(report.includes("e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled'"));
  assert(report.includes("e.meta.state === 'ready' || (e.meta.state === 'accepted' && e.meta.isPreorder === true)"));
  assert(report.includes('Đơn đã được nhận và bấm Bereit thành công'));
  assert(report.includes("case 'wolt_accept_unconfirmed':"));
  assert(report.includes('đơn đã tạo trên Admin nhưng Wolt chưa xác nhận nhận đơn'));
  assert(report.includes('đơn Wolt đã nhận nhưng chưa hoàn tất nút Bereit'));
}

console.log('wolt action safety tests: OK');
