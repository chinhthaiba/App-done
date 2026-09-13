const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Test auto-shutdown evaluation logic
function createEvaluator(initialConfig = {}) {
  let config = {
    enabled: false,
    countdownSeconds: 60,
    minHour: 19,
    minMinute: 47,
    ...initialConfig
  };
  let lastShutdownTriggeredDate = '';

  function readConfig() {
    return { ...config };
  }

  function writeConfig(cfg) {
    config = { ...config, ...cfg };
  }

  function evaluate(options = {}) {
    const cfg = readConfig();
    if (options.force !== true && !cfg.enabled) {
      return { eligible: false, reason: 'disabled_by_config' };
    }

    const isManual = options.source === 'manual-direct' || options.source === 'manual' || options.source === 'manual-reload' || options.triggerReason === 'manual';
    if (options.force !== true && isManual) {
      return { eligible: false, reason: 'manual_report_keep_running' };
    }

    if (options.force !== true && options.triggerReason === 'deadline' && options.doneFull !== true) {
      return { eligible: false, reason: 'deadline_not_done_full_keep_running' };
    }

    if (options.force !== true && options.doneFull !== true) {
      return { eligible: false, reason: 'not_done_full_keep_running' };
    }

    const now = options.now || new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const minMinutes = cfg.minHour * 60 + cfg.minMinute;
    const isNightTime = options.force === true || currentMinutes >= minMinutes || now.getHours() < 4;
    if (!isNightTime) {
      return { eligible: false, reason: `daytime_guard_blocked_${now.getHours()}h${now.getMinutes()}` };
    }

    const todayStr = options.reportDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (options.force !== true && lastShutdownTriggeredDate === todayStr) {
      return { eligible: false, reason: 'already_triggered_today' };
    }

    return { eligible: true, config: cfg, todayStr };
  }

  function markTriggered(todayStr) {
    lastShutdownTriggeredDate = todayStr;
  }

  return { readConfig, writeConfig, evaluate, markTriggered };
}

// 1. Test disabled by default
const evaluator = createEvaluator({ enabled: false });
const res1 = evaluator.evaluate({ now: new Date(2026, 8, 1, 21, 0, 0), doneFull: true });
assert.strictEqual(res1.eligible, false);
assert.strictEqual(res1.reason, 'disabled_by_config');

// 1b. Test deadline 23h55 without doneFull -> MUST NOT shut down
evaluator.writeConfig({ enabled: true });
const res1b = evaluator.evaluate({ now: new Date(2026, 8, 1, 23, 55, 0), reportDate: '2026-09-01', triggerReason: 'deadline', doneFull: false });
assert.strictEqual(res1b.eligible, false);
assert.strictEqual(res1b.reason, 'deadline_not_done_full_keep_running');

// 1c. Test deadline 23h55 WITH doneFull -> SHUTDOWN ALLOWED
const res1c = evaluator.evaluate({ now: new Date(2026, 8, 1, 23, 55, 0), reportDate: '2026-09-01', triggerReason: 'deadline', doneFull: true, source: 'auto' });
assert.strictEqual(res1c.eligible, true);

// 1d. Test auto report before deadline WITH doneFull (e.g. 20:00) -> SHUTDOWN ALLOWED
const res1d = evaluator.evaluate({ now: new Date(2026, 8, 1, 20, 0, 0), reportDate: '2026-09-01', triggerReason: 'done_full', doneFull: true, source: 'auto' });
assert.strictEqual(res1d.eligible, true);

// 1e. Test MANUAL report at 19:50 even with doneFull -> MUST NOT shut down
const res1e = evaluator.evaluate({ now: new Date(2026, 8, 1, 19, 50, 0), reportDate: '2026-09-01', source: 'manual-direct', triggerReason: 'manual', doneFull: true });
assert.strictEqual(res1e.eligible, false);
assert.strictEqual(res1e.reason, 'manual_report_keep_running');

// 2. Test daytime guard (e.g. 14:30)
evaluator.writeConfig({ enabled: true });
const res2 = evaluator.evaluate({ now: new Date(2026, 8, 1, 14, 30, 0), source: 'auto', doneFull: true });
assert.strictEqual(res2.eligible, false);
assert(res2.reason.startsWith('daytime_guard_blocked'));

// 3. Test evening allowed (e.g. 20:45)
const res3 = evaluator.evaluate({ now: new Date(2026, 8, 1, 20, 45, 0), reportDate: '2026-09-01', source: 'auto', doneFull: true });
assert.strictEqual(res3.eligible, true);
assert.strictEqual(res3.todayStr, '2026-09-01');

// 4. Test idempotency (cannot trigger twice on the same day)
evaluator.markTriggered('2026-09-01');
const res4 = evaluator.evaluate({ now: new Date(2026, 8, 1, 20, 55, 0), reportDate: '2026-09-01', source: 'auto', doneFull: true });
assert.strictEqual(res4.eligible, false);
assert.strictEqual(res4.reason, 'already_triggered_today');

// 5. Test next day allowed (e.g. 2026-09-02 at 21:00)
const res5 = evaluator.evaluate({ now: new Date(2026, 8, 2, 21, 0, 0), reportDate: '2026-09-02', source: 'auto', doneFull: true });
assert.strictEqual(res5.eligible, true);
assert.strictEqual(res5.todayStr, '2026-09-02');

// 6. Verify preload-tienship.js syntax
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload-tienship.js'), 'utf8');
assert(preloadSource.includes('window.ThaiAsiaHost'), 'preload-tienship must define ThaiAsiaHost');
assert(preloadSource.includes('tienship-report-sent'), 'preload-tienship must send tienship-report-sent');

// 7. Verify tienship.js calls ThaiAsiaHost.onReportSent
const tienshipSource = fs.readFileSync(path.join(__dirname, '..', 'tienship.js'), 'utf8');
assert(tienshipSource.includes('window.ThaiAsiaHost.onReportSent'), 'tienship.js must call onReportSent');

// 8. Verify main.js contains auto shutdown configuration & IPC
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
assert(mainSource.includes('AUTO_SHUTDOWN_CONFIG_PATH'), 'main.js must define AUTO_SHUTDOWN_CONFIG_PATH');
assert(mainSource.includes('evaluateAutoShutdownEligibility'), 'main.js must define evaluateAutoShutdownEligibility');
assert(mainSource.includes('cancelWindowsShutdown'), 'main.js must define cancelWindowsShutdown');
assert(mainSource.includes('tienship-report-sent'), 'main.js must handle tienship-report-sent');
assert(mainSource.includes('Tắt máy (Auto Shutdown)'), 'main.js must include Auto Shutdown in menu');
assert(mainSource.includes('_autofertigHoldsShutdownKey'), 'main.js must track _autofertigHoldsShutdownKey');
assert(mainSource.includes('queryAutofertigRemainingOrderCount'), 'main.js must define queryAutofertigRemainingOrderCount');

// 9. Verify Autofertig.js exports status helper and emits status events
const autofertigSource = fs.readFileSync(path.join(__dirname, '..', 'Autofertig.js'), 'utf8');
assert(autofertigSource.includes('window.__getAutofertigStatus'), 'Autofertig.js must export __getAutofertigStatus');
assert(autofertigSource.includes('window.__thaiasiaAutofertigRemainingCount'), 'Autofertig.js must export __thaiasiaAutofertigRemainingCount');
assert(autofertigSource.includes('autofertig_orders_status'), 'Autofertig.js must emit autofertig_orders_status');

// 10. Test key handover simulation
function createHandoverCoordinator(evaluatorInstance) {
  let autofertigRemainingOrders = 0;
  let autofertigHoldsShutdownKey = false;
  let pendingShutdownOptions = null;
  let shutdownExecutedWith = null;

  function setAutofertigOrders(count) {
    autofertigRemainingOrders = count;
  }

  function handleTienshipReport(options) {
    const check = evaluatorInstance.evaluate(options);
    if (!check.eligible) return { handled: false, reason: check.reason };

    if (autofertigRemainingOrders > 0) {
      autofertigHoldsShutdownKey = true;
      pendingShutdownOptions = { ...options, ...check };
      return { handled: true, status: 'key_handed_over', remainingOrders: autofertigRemainingOrders };
    }

    shutdownExecutedWith = { ...options, ...check, triggeredBy: 'tienship' };
    return { handled: true, status: 'shutdown_immediate' };
  }

  function handleAutofertigOrderUpdate(remainingCount, isProcessing) {
    autofertigRemainingOrders = remainingCount;
    if (autofertigHoldsShutdownKey && autofertigRemainingOrders === 0 && !isProcessing) {
      autofertigHoldsShutdownKey = false;
      const saved = pendingShutdownOptions || {};
      pendingShutdownOptions = null;
      shutdownExecutedWith = { ...saved, force: true, triggeredBy: 'autofertig_drain' };
      return { triggered: true, status: 'shutdown_by_autofertig' };
    }
    return { triggered: false, status: 'waiting' };
  }

  return {
    setAutofertigOrders,
    handleTienshipReport,
    handleAutofertigOrderUpdate,
    holdsKey: () => autofertigHoldsShutdownKey,
    getExecuted: () => shutdownExecutedWith
  };
}

// 10a. Tienship with 0 Autofertig orders -> Immediate shutdown
const coord1 = createHandoverCoordinator(evaluator);
coord1.setAutofertigOrders(0);
const r10a = coord1.handleTienshipReport({ now: new Date(2026, 8, 3, 20, 0, 0), reportDate: '2026-09-03', source: 'auto', doneFull: true });
assert.strictEqual(r10a.status, 'shutdown_immediate');
assert.strictEqual(coord1.holdsKey(), false);
assert.strictEqual(coord1.getExecuted().triggeredBy, 'tienship');

// 10b. Tienship with 2 Autofertig orders -> Handover key
const coord2 = createHandoverCoordinator(evaluator);
coord2.setAutofertigOrders(2);
const r10b = coord2.handleTienshipReport({ now: new Date(2026, 8, 4, 20, 0, 0), reportDate: '2026-09-04', source: 'auto', doneFull: true });
assert.strictEqual(r10b.status, 'key_handed_over');
assert.strictEqual(coord2.holdsKey(), true);
assert.strictEqual(coord2.getExecuted(), null);

// 10c. Autofertig finishes 1 order (1 remaining) -> Still holding key, no shutdown
const r10c = coord2.handleAutofertigOrderUpdate(1, false);
assert.strictEqual(r10c.triggered, false);
assert.strictEqual(coord2.holdsKey(), true);
assert.strictEqual(coord2.getExecuted(), null);

// 10d. Autofertig finishes final order (0 remaining) -> Trigger shutdown by autofertig
const r10d = coord2.handleAutofertigOrderUpdate(0, false);
assert.strictEqual(r10d.triggered, true);
assert.strictEqual(coord2.holdsKey(), false);
assert.strictEqual(coord2.getExecuted().triggeredBy, 'autofertig_drain');

console.log('auto shutdown tests: OK');
process.exit(0);
