'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeMachineName,
  buildMachineTargets,
  assessHeartbeatDeletionSafety,
  assertLocalTarget,
  cleanupLocalMachineFiles,
  parseArgs
} = require('./remove-live-machine');

assert.strictEqual(normalizeMachineName('Nhung-Beo'), 'Nhung-Beo');
assert.throws(() => normalizeMachineName('../Nhung-Beo'));
assert.throws(() => normalizeMachineName(''));

const targets = buildMachineTargets('Nhung-Beo');
assert.deepStrictEqual(targets.remote, [
  'reports/ThaiAsia-24h-report-Nhung-Beo.txt',
  'reports/ThaiAsia-24h-report-bundle-Nhung-Beo.txt',
  'commands/ack-Nhung-Beo.json',
  'status/heartbeat-Nhung-Beo.json'
]);

const now = Date.parse('2026-08-27T18:00:00.000Z');
assert.strictEqual(assessHeartbeatDeletionSafety({
  state: 'online',
  lastSeenAt: new Date(now - 30_000).toISOString(),
  offlineAfterMs: 420_000
}, now).safe, false);
assert.strictEqual(assessHeartbeatDeletionSafety({
  state: 'online',
  lastSeenAt: new Date(now - 8 * 60_000).toISOString(),
  offlineAfterMs: 420_000
}, now).safe, true);
assert.strictEqual(assessHeartbeatDeletionSafety({
  state: 'offline',
  lastSeenAt: new Date(now - 10_000).toISOString()
}, now).safe, true);
assert.strictEqual(assessHeartbeatDeletionSafety({
  state: 'online',
  lastSeenAt: new Date(now - 30_000).toISOString(),
  offlineAfterMs: 'invalid'
}, now).safe, false);

const parsed = parseArgs(['Nhung-Beo', '--yes', '--dry-run', '--repo=x247hl/thaiasia-releases']);
assert.strictEqual(parsed.machine, 'Nhung-Beo');
assert.strictEqual(parsed.yes, true);
assert.strictEqual(parsed.dryRun, true);
assert.strictEqual(parseArgs(['--dry-run'], { THAIASIA_REMOVE_MACHINE: 'May-Test' }).machine, 'May-Test');

const batchSource = fs.readFileSync(path.join(__dirname, '..', 'sync-live-reports.bat'), 'utf8');
assert(batchSource.includes('scripts\\remove-live-machine.js'));
assert(batchSource.includes('THAIASIA_REMOVE_MACHINE'));

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thaiasia-remove-machine-'));
try {
  fs.mkdirSync(path.join(tempRoot, 'status'), { recursive: true });
  const localFiles = [
    path.join(tempRoot, 'ThaiAsia-24h-report-Nhung-Beo.txt'),
    path.join(tempRoot, 'ThaiAsia-24h-report-bundle-Nhung-Beo.txt'),
    path.join(tempRoot, 'status', 'heartbeat-Nhung-Beo.json')
  ];
  localFiles.forEach((filePath) => fs.writeFileSync(filePath, 'test', 'utf8'));
  assert.throws(() => assertLocalTarget(path.resolve(tempRoot, '..', 'outside.txt'), tempRoot));
  const removed = cleanupLocalMachineFiles('Nhung-Beo', tempRoot);
  assert.strictEqual(removed.length, 3);
  localFiles.forEach((filePath) => assert.strictEqual(fs.existsSync(filePath), false));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('live machine cleanup tests: OK');
