'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const bridgeSource = fs.readFileSync(path.join(root, 'ThaiAsia-AllInOneapp.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract ${startMarker}`);
  return source.slice(start, end);
}

function testRendererOutcomeInspection() {
  const source = between(
    bridgeSource,
    'function inspectAdminSubmitOutcome',
    'async function waitForAdminSubmitOutcome'
  );
  const state = {
    onCreatePage: true,
    href: 'https://www.api.thaiasiasushibar.de/admin/orders/create',
    successTexts: [],
    errorTexts: []
  };
  const context = {
    location: {
      get href() { return state.href; }
    },
    pageLooksLikeAdminOrderCreate() { return state.onCreatePage; },
    visibleAdminText(selector) {
      return selector.includes('alert-success') ? state.successTexts : state.errorTexts;
    },
    normalizeText(value) { return String(value || '').trim(); }
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  state.onCreatePage = false;
  assert.strictEqual(
    context.inspectAdminSubmitOutcome(null, 'https://www.api.thaiasiasushibar.de/admin/orders/create').status,
    'confirmed',
    'Navigation away from create must confirm submit'
  );

  state.onCreatePage = true;
  state.successTexts = ['Order erfolgreich gespeichert'];
  assert.strictEqual(
    context.inspectAdminSubmitOutcome(null, state.href).confirmation,
    'success_message',
    'A visible success message must confirm submit'
  );

  state.successTexts = [];
  const invalidField = {
    name: 'customer_phone', id: '', type: 'text', getAttribute() { return ''; }
  };
  const invalidForm = {
    checkValidity() { return false; },
    querySelectorAll(selector) { return selector === ':invalid' ? [invalidField] : []; }
  };
  const submitBtn = { closest() { return invalidForm; } };
  const invalid = context.inspectAdminSubmitOutcome(submitBtn, state.href);
  assert.strictEqual(invalid.status, 'validation_failed');
  assert.deepStrictEqual(Array.from(invalid.invalidFields), ['customer_phone']);

  const validForm = {
    checkValidity() { return true; },
    querySelectorAll() { return []; }
  };
  assert.strictEqual(
    context.inspectAdminSubmitOutcome({ closest() { return validForm; } }, state.href).status,
    'pending',
    'A click without success evidence must remain pending'
  );
}

function testMainUrlClassification() {
  const source = between(
    mainSource,
    'function isAdminCreateUrl',
    'function markAdminPayloadAutoActionsDone'
  );
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.strictEqual(
    context.isAdminCreateUrl('https://www.api.thaiasiasushibar.de/admin/orders/create'),
    true
  );
  assert.strictEqual(
    context.isAdminOrderSuccessUrl('https://www.api.thaiasiasushibar.de/admin/orders'),
    true
  );
  assert.strictEqual(
    context.isAdminOrderSuccessUrl('https://www.api.thaiasiasushibar.de/admin/orders/123'),
    true
  );
  assert.strictEqual(
    context.isAdminOrderSuccessUrl('https://www.api.thaiasiasushibar.de/login'),
    false,
    'Login redirects must never be treated as successful order creation'
  );
}

function testSafetyWiring() {
  assert(bridgeSource.includes("emitAdminSubmitEvent('admin_submit_started'"));
  assert(bridgeSource.includes("emitAdminSubmitEvent('admin_submit_confirmed'"));
  assert(bridgeSource.includes("'admin_submit_validation_failed'"));
  assert(bridgeSource.includes("'admin_submit_unconfirmed'"));
  assert(bridgeSource.includes('waitForAdminSubmitOutcome(submitBtn, submitStartedUrl)'));
  assert(!bridgeSource.includes('await GM_setValue(CLOSE_TAB_SIGNAL_KEY, now());\n              try { window.close(); }'));
  assert(mainSource.includes("ipcMain.on('close-current-admin-window'"));
  assert(mainSource.includes("emitAdminWindowDiag('admin_close_blocked_unconfirmed'"));
}

testRendererOutcomeInspection();
testMainUrlClassification();
testSafetyWiring();

console.log('admin submit guard tests: OK');
