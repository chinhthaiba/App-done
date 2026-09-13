'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const adminBridgeSource = fs.readFileSync(path.join(root, 'ThaiAsia-AllInOneapp.js'), 'utf8');
const livePreloadSource = fs.readFileSync(path.join(root, 'preload-liveorder.js'), 'utf8');
const uberPreloadSource = fs.readFileSync(path.join(root, 'preload-ubereats.js'), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract ${startMarker}`);
  return source.slice(start, end);
}

const coordinatorSource = between(
  mainSource,
  "const BRIDGE_ACTIVE_ORDER_KEY = 'thaiasia_takeaway_order_bridge_active_v9';",
  'function emitAdminWindowDiag'
);
const context = { Map, Date, Math, sharedStore: new Map() };
vm.createContext(context);
vm.runInContext(
  `${coordinatorSource}\nthis.normalizeAdminOpenRequest = normalizeAdminOpenRequest; this.resolveAdminOrderBinding = resolveAdminOrderBinding;`,
  context
);

const prefix = 'thaiasia_takeaway_order_bridge_v9_';
const uberKey = `${prefix}BAB43`;
const takeawayKey = `${prefix}6VDJVT`;
context.sharedStore.set(uberKey, { orderCode: 'BAB43' });
context.sharedStore.set(takeawayKey, { orderCode: '6VDJVT' });
context.sharedStore.set('thaiasia_takeaway_order_bridge_active_v9', takeawayKey);

const uberRequest = context.normalizeAdminOpenRequest({
  url: 'https://www.api.thaiasiasushibar.de/admin/orders/create',
  requestId: 'uber-request',
  storageKey: uberKey
}, 10);
const takeawayRequest = context.normalizeAdminOpenRequest({
  url: 'https://www.api.thaiasiasushibar.de/admin/orders/create',
  requestId: 'takeaway-request',
  storageKey: takeawayKey
}, 11);

assert.notStrictEqual(uberRequest.requestId, takeawayRequest.requestId);
assert.strictEqual(context.resolveAdminOrderBinding(uberRequest.requestedStorageKey), uberKey);
assert.strictEqual(context.resolveAdminOrderBinding(takeawayRequest.requestedStorageKey), takeawayKey);
assert.strictEqual(context.resolveAdminOrderBinding(''), takeawayKey, 'Legacy request may use the active key snapshot');

assert(mainSource.includes('adminWindows.set(requestId, adminWin)'));
assert(mainSource.includes("ipcMain.handle('admin-payload-binding-get'"));
assert(!mainSource.includes("emitAdminWindowDiag('admin_window_replaced'"));
assert(!mainSource.includes('adminWindows.get(url)'));
assert(adminBridgeSource.includes("typeof GM_getAdminPayloadBinding === 'function'"));
assert(livePreloadSource.includes("storageKey: String(opts.storageKey || '')"));
assert(uberPreloadSource.includes("storageKey: String(opts.storageKey || '')"));

console.log('admin window isolation tests: OK');
