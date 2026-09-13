const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const bridgeSource = fs.readFileSync(path.join(root, 'Wolt-Bridge.js'), 'utf8');

assert(bridgeSource.includes("action: 'manual_click_result'"), 'Tracker must record post-click evidence');
assert(bridgeSource.includes('POST_CLICK_DELAYS_MS = [300, 1200, 3000]'), 'Tracker must sample multiple post-click states');
assert(bridgeSource.includes('semanticSignature'), 'Tracker must compare semantic state without relying on coordinates');
assert(bridgeSource.includes('taskStatusChanged'), 'Tracker must compare Wolt API task status');
assert(bridgeSource.includes('interveningManualClicks'), 'Tracker must disclose overlapping manual actions');
assert(bridgeSource.includes('previousSyntheticState'), 'Internal Flutter semantics activation must not be reported as a manual click');

// Mock a DOM environment for testing the tracker
class MockElement {
  constructor(tagName, attrs = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.innerText = text;
    this.textContent = text;
    this.classList = {
      _classes: (attrs.class || '').split(' ').filter(Boolean),
      length: (attrs.class || '').split(' ').filter(Boolean).length,
      [Symbol.iterator]() { return this._classes[Symbol.iterator](); }
    };
    this.id = attrs.id || '';
    this.parentElement = null;
    this.ownerDocument = null;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this._listeners = {};
  }

  appendChild(child) {
    if (child) {
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }

  querySelector(selector) {
    if (selector === '[data-wolt-status]') {
      return new MockElement('span');
    }
    if (selector === '[data-wolt-manual]') {
      return new MockElement('button');
    }
    return null;
  }

  getAttribute(name) {
    return this.attrs[name] || null;
  }

  setAttribute(name, val) {
    this.attrs[name] = val;
  }

  getBoundingClientRect() {
    return {
      left: Number(this.attrs.left || 100),
      top: Number(this.attrs.top || 200),
      width: Number(this.attrs.width || 80),
      height: Number(this.attrs.height || 40),
      right: Number(this.attrs.left || 100) + Number(this.attrs.width || 80),
      bottom: Number(this.attrs.top || 200) + Number(this.attrs.height || 40)
    };
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (selector.includes('button') && (curr.tagName === 'BUTTON' || curr.getAttribute('role') === 'button')) {
        return curr;
      }
      if (selector.includes('[role="dialog"]') && curr.getAttribute('role') === 'dialog') {
        return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  addEventListener(type, fn, opts) {
    this._listeners[type] = this._listeners[type] || [];
    this._listeners[type].push(fn);
  }

  dispatchEvent(event) {
    const list = this._listeners[event.type] || [];
    for (const fn of list) fn(event);
    return true;
  }
}

class MockDocument {
  constructor() {
    this.documentElement = new MockElement('html');
    this.head = new MockElement('head');
    this.body = new MockElement('body');
    this.head.parentElement = this.documentElement;
    this.body.parentElement = this.documentElement;
    this._listeners = { capture: {}, bubble: {} };
  }

  createElement(tag) {
    const el = new MockElement(tag);
    el.ownerDocument = this;
    return el;
  }

  addEventListener(type, fn, useCapture = false) {
    const phase = useCapture ? 'capture' : 'bubble';
    this._listeners[phase][type] = this._listeners[phase][type] || [];
    this._listeners[phase][type].push(fn);
  }

  dispatchEvent(event) {
    // Capture phase
    const capList = this._listeners.capture[event.type] || [];
    for (const fn of capList) fn(event);
    return true;
  }

  querySelectorAll() { return []; }
  querySelector() { return null; }
  getElementById() { return null; }
  appendChild(child) { return child; }
}

const mockStorage = {};
const mockLocalStorage = {
  getItem(key) { return mockStorage[key] || null; },
  setItem(key, val) { mockStorage[key] = String(val); }
};

const mockDoc = new MockDocument();
const mockWindow = {
  document: mockDoc,
  localStorage: mockLocalStorage,
  innerWidth: 1280,
  innerHeight: 800,
  scrollX: 0,
  scrollY: 0,
  location: { href: 'https://merchant.wolt.com' },
  addEventListener() {},
  dispatchEvent() {}
};

// Run bridge in VM
const ctx = {
  window: mockWindow,
  document: mockDoc,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  Math,
  Array,
  Object,
  String,
  Number,
  Set,
  Map,
  Promise
};
vm.createContext(ctx);

let exportedApi = null;
const scriptCode = `
  const factory = ${bridgeSource};
  this.api = factory(window);
`;
vm.runInContext(bridgeSource, ctx);
const bridge = mockWindow.ThaiAsiaWoltBridge;
console.log('Bridge loaded and started successfully');

// 1. Simulate a manual click on a button "Bestellung annehmen" inside order card #99881
const card = new MockElement('div', { class: 'order-card', left: 50, top: 150, width: 300, height: 200 }, 'Order #99881\nBestellung annehmen');
const button = new MockElement('button', { class: 'accept-btn', left: 120, top: 280, width: 140, height: 45 }, 'Bestellung annehmen');
button.parentElement = card;
card.parentElement = mockDoc.body;

const clickEvent = {
  type: 'click',
  target: button,
  clientX: 150,
  clientY: 300,
  pageX: 150,
  pageY: 300,
  button: 0
};

// Dispatch click to document (tracker uses capture phase)
mockDoc.dispatchEvent(clickEvent);

// Verify localStorage saved the action
const storedRaw = mockLocalStorage.getItem('thaiasia_wolt_manual_actions');
assert(storedRaw, 'thaiasia_wolt_manual_actions must be present in localStorage');
const actions = JSON.parse(storedRaw);
assert.strictEqual(actions.length, 1, 'Exactly 1 manual action should be logged');

const entry = actions[0];
console.log('Logged Manual Action:', entry);

assert.strictEqual(entry.eventType, 'wolt_manual_action');
assert.strictEqual(entry.action, 'manual_click');
assert.strictEqual(entry.actionKind, 'accept_order');
assert.strictEqual(entry.pointer.clientX, 150);
assert.strictEqual(entry.pointer.clientY, 300);
assert.strictEqual(entry.target.tagName, 'button');
assert.strictEqual(entry.target.text, 'Bestellung annehmen');
assert.strictEqual(entry.context.nearestOrderNumber, '99881', 'Nearest order number should be parsed from parent card');
assert(entry.before && Array.isArray(entry.before.semanticActions), 'Pre-click semantic evidence must be recorded');

setTimeout(() => {
  const postClickActions = JSON.parse(mockLocalStorage.getItem('thaiasia_wolt_manual_actions'));
  const result = postClickActions.find(item => item.action === 'manual_click_result' && item.manualActionId === entry.manualActionId);
  assert(result, 'Post-click evidence must be emitted for the same manual action');
  assert.strictEqual(result.after.length, 3, 'All post-click semantic snapshots must be retained');
  assert.strictEqual(result.after[0].delayMs, 300);
  assert.strictEqual(result.after[2].delayMs, 3000);
  assert(result.outcomeEvidence && typeof result.outcomeEvidence.targetStillVisible === 'boolean');

  // 2. Test maximum cap of 50 items
  for (let i = 0; i < 60; i++) {
    mockDoc.dispatchEvent({
      type: 'click',
      target: button,
      clientX: 100 + i,
      clientY: 200,
      pageX: 100 + i,
      pageY: 200,
      button: 0
    });
  }

  const cappedActions = JSON.parse(mockLocalStorage.getItem('thaiasia_wolt_manual_actions'));
  assert.strictEqual(cappedActions.length, 50, 'Stored actions must be capped at 50');

  console.log('wolt manual tracker tests: OK');
  process.exit(0);
}, 3200);
