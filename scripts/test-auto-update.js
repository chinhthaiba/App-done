'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const releaseFiles = require('../updater/release-files');
const format = require('../updater/release-format');
const helper = require('../updater/apply-update');
const restartHelper = require('../updater/restart-app');
const {
  evaluateMachineHeartbeat,
  buildHumanStatusReport,
  applyRecentReportEvidence
} = require('./pull-live-reports');
const {
  isValidRepository,
  createReportSync,
  createRemoteCommandReceiver,
  normalizeReportContentForHash,
  getRateLimitDelayMs
} = require('../updater/auto-update-manager');

const root = path.resolve(__dirname, '..');

assert.strictEqual(format.normalizeVersion('v1.2.3'), '1.2.3');
assert.strictEqual(format.compareVersions('1.0.1', '1.0.0'), 1);
assert.strictEqual(format.compareVersions('1.0.0', '1.0.0'), 0);
assert.strictEqual(format.compareVersions('1.0.0-beta.1', '1.0.0'), -1);
assert.throws(() => format.normalizeReleasePath('../main.js'), /Unsafe release path/);
assert.throws(() => format.normalizeReleasePath('C:\\main.js'), /Unsafe release path/);
assert.strictEqual(isValidRepository('x247hl/thaiasia-releases'), true);
assert.strictEqual(isValidRepository('https://github.com/x/y'), false);
assert.strictEqual(
  normalizeReportContentForHash('Generated: 2026-01-01\n  "generatedAt": "2026-01-01",\nPhiên bản app: v1.2.18\nevent-a'),
  normalizeReportContentForHash('Generated: 2026-01-02\n  "generatedAt": "2026-01-02",\nPhiên bản app: v1.2.18\nevent-a')
);
assert.notStrictEqual(
  normalizeReportContentForHash('Phiên bản app: v1.2.18\nevent-a'),
  normalizeReportContentForHash('Phiên bản app: v1.2.19\nevent-a')
);
assert.strictEqual(
  getRateLimitDelayMs({ statusCode: 429, headers: { 'retry-after': '120' }, data: { message: 'rate limit' } }),
  120000
);

for (const relativePath of releaseFiles) {
  assert(fs.statSync(path.join(root, relativePath)).isFile(), `missing release file: ${relativePath}`);
}

const privateKey = fs.readFileSync(path.join(root, '.release-secrets', 'update-private-key.pem'), 'utf8');
const publicKey = fs.readFileSync(path.join(root, 'updater', 'update-public-key.pem'), 'utf8');
const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, version: '1.0.1' }), 'utf8');
const signature = crypto.sign(null, manifestBytes, privateKey);
assert.strictEqual(crypto.verify(null, manifestBytes, publicKey, signature), true);
assert.strictEqual(crypto.verify(null, Buffer.from('tampered'), publicKey, signature), false);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thaiasia-update-test-'));
try {
  const source = path.join(tempRoot, 'source');
  const destination = path.join(tempRoot, 'destination');
  fs.mkdirSync(path.join(source, 'updater'), { recursive: true });
  fs.writeFileSync(path.join(source, 'main.js'), 'module.exports = true;\n');
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ version: '9.8.7' }));
  fs.writeFileSync(path.join(source, 'updater', 'update-public-key.pem'), publicKey);
  helper.verifyInstalledPayload(source, '9.8.7');
  helper.copyDirectory(source, destination);
  helper.verifyInstalledPayload(destination, '9.8.7');
  assert.throws(() => helper.verifyInstalledPayload(destination, '9.8.6'), /version mismatch/);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const validManifest = format.validateManifest({
  schemaVersion: 1,
  version: '1.2.3',
  bundle: {
    name: 'thaiasia-app-v1.2.3.bundle.json.gz',
    size: 123,
    sha256: 'a'.repeat(64)
  }
});
assert.strictEqual(validManifest.version, '1.2.3');
assert.throws(() => format.validateManifest({ ...validManifest, bundle: { ...validManifest.bundle, size: 0 } }), /bundle size/);

const preparedDir = path.join(root, 'release-output', `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`);
if (fs.existsSync(preparedDir)) {
  const preparedManifestBytes = fs.readFileSync(path.join(preparedDir, format.MANIFEST_ASSET_NAME));
  const preparedSignature = Buffer.from(fs.readFileSync(path.join(preparedDir, format.SIGNATURE_ASSET_NAME), 'utf8').trim(), 'base64');
  assert.strictEqual(crypto.verify(null, preparedManifestBytes, publicKey, preparedSignature), true);
  const preparedManifest = format.validateManifest(JSON.parse(preparedManifestBytes.toString('utf8')));
  const preparedBundleBytes = fs.readFileSync(path.join(preparedDir, preparedManifest.bundle.name));
  assert.strictEqual(format.sha256(preparedBundleBytes), preparedManifest.bundle.sha256);
  const preparedBundle = JSON.parse(zlib.gunzipSync(preparedBundleBytes).toString('utf8'));
  assert.strictEqual(preparedBundle.version, preparedManifest.version);
  assert.deepStrictEqual(
    preparedBundle.files.map((file) => file.path).sort(),
    [...releaseFiles].sort()
  );
}

const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const watchdogSource = fs.readFileSync(path.join(root, 'run-watchdog.bat'), 'utf8');
const runSource = fs.readFileSync(path.join(root, 'run.bat'), 'utf8');
assert(mainSource.includes('createAutoUpdateManager'));
assert(mainSource.includes("const os = require('os');"));
assert(mainSource.includes('createReportSync'));
assert(mainSource.includes('reportSync.syncReportsAsync'));
assert(mainSource.includes('version: app.getVersion()'));
assert(watchdogSource.includes('UPDATE_LOCK'));
assert(!watchdogSource.includes('copy /Y "%APP_DIR%main.js"'));
assert(releaseFiles.length === 24);
assert(!fs.readFileSync(path.join(root, 'updater', 'apply-update.js'), 'utf8').includes("spawn('cmd.exe'"));
assert(mainSource.includes("ELECTRON_RUN_AS_NODE: '1'"));
assert(mainSource.includes("triggerRelaunch('remote-command-restart'"));

assert(mainSource.includes('createRemoteCommandReceiver'));
assert(mainSource.includes('remoteCommandReceiver.start'));
assert(mainSource.includes('reload_wolt'));
assert(mainSource.includes('quit_app'));
const readySource = mainSource.slice(mainSource.indexOf('app.whenReady().then'));
assert(readySource.indexOf('remoteCommandReceiver.start()') < readySource.indexOf('createWindow();'));
assert(readySource.indexOf('remoteCommandReceiver.start()') < readySource.indexOf('startRemoteHeartbeatSync();'));
assert(mainSource.includes("path.join(USER_DATA_DIR, 'remote-control.log')"));
assert(mainSource.includes('APP_HEARTBEAT_INTERVAL_MS = 3000'));
assert(mainSource.includes('REMOTE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000'));
assert(mainSource.includes('REMOTE_OFFLINE_AFTER_MS = 7 * 60 * 1000'));
assert(mainSource.includes('initializeAppRunState()'));
assert(mainSource.includes("browserWindow.on('query-session-end'"));
assert(mainSource.includes('markCleanShutdown('));

const heartbeatNow = Date.parse('2026-08-26T12:00:00.000Z');
assert.strictEqual(evaluateMachineHeartbeat({
  machine: 'Kasse-PC',
  state: 'online',
  lastSeenAt: '2026-08-26T11:53:01.000Z'
}, heartbeatNow).state, 'online');
assert.strictEqual(evaluateMachineHeartbeat({
  machine: 'Kasse-PC',
  state: 'online',
  lastSeenAt: '2026-08-26T11:52:59.000Z'
}, heartbeatNow).state, 'offline');
const readableOnlineStatus = buildHumanStatusReport([evaluateMachineHeartbeat({
  machine: 'Kasse-PC',
  state: 'online',
  version: '1.2.21',
  startedAt: '2026-08-26T08:00:00.000Z',
  lastSeenAt: '2026-08-26T11:59:30.000Z',
  remoteControl: { running: true }
}, heartbeatNow)], heartbeatNow);
assert(readableOnlineStatus.includes('Máy: Kasse-PC'));
assert(readableOnlineStatus.includes('Trạng thái: ĐANG HOẠT ĐỘNG'));
assert(readableOnlineStatus.includes('Phiên bản app: v1.2.21'));
assert(readableOnlineStatus.includes('Điều khiển từ xa: Đang hoạt động'));
const readableOfflineStatus = buildHumanStatusReport([evaluateMachineHeartbeat({
  machine: 'Kasse-PC',
  state: 'online',
  lastSeenAt: '2026-08-26T11:52:00.000Z'
}, heartbeatNow)], heartbeatNow);
assert(readableOfflineStatus.includes('Trạng thái: CHƯA NHẬN ĐƯỢC TÍN HIỆU'));
assert(readableOfflineStatus.includes('Không nhận được tín hiệu hơn 7 phút'));
const heartbeatLateButReportFresh = applyRecentReportEvidence([
  evaluateMachineHeartbeat({
    machine: 'Kasse-PC',
    state: 'online',
    lastSeenAt: '2026-08-26T11:52:00.000Z'
  }, heartbeatNow)
], new Map([['Kasse-PC', {
  generatedAt: '2026-08-26T11:59:00.000Z',
  generatedMs: Date.parse('2026-08-26T11:59:00.000Z')
}]]), heartbeatNow);
assert.strictEqual(heartbeatLateButReportFresh[0].state, 'online');
assert.strictEqual(heartbeatLateButReportFresh[0].heartbeatDelayed, true);
assert(buildHumanStatusReport(heartbeatLateButReportFresh, heartbeatNow).includes('Heartbeat đang chậm'));
assert.strictEqual(evaluateMachineHeartbeat({
  machine: 'Kasse-PC',
  state: 'offline',
  lastSeenAt: '2026-08-26T11:59:59.000Z',
  reason: 'app_quit'
}, heartbeatNow).state, 'offline');

(async () => {
  // Integration check: both launchers must return the actual child PID. The
  // child writes its PID into a heartbeat, exactly like the packaged app.
  const launchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'thaiasia-launch-test-'));
  let launchedPid = 0;
  let restartPid = 0;
  try {
    const childScript = path.join(launchRoot, 'heartbeat-child.js');
    const heartbeatPath = path.join(launchRoot, 'heartbeat.json');
    fs.writeFileSync(childScript, [
      "const fs = require('fs');",
      "const filePath = process.argv[2];",
      "const version = process.argv[3];",
      "const write = () => fs.writeFileSync(filePath, JSON.stringify({ ts: Date.now(), version, pid: process.pid }));",
      "write();",
      "setInterval(write, 100);"
    ].join('\n'), 'utf8');

    launchedPid = helper.launchApp(process.execPath, [childScript, heartbeatPath, 'launch-test']);
    assert(Number.isSafeInteger(launchedPid) && launchedPid > 0);
    assert.strictEqual(await helper.waitForHealthyHeartbeat(heartbeatPath, 'launch-test', launchedPid, 5000), true);
    process.kill(launchedPid);
    assert.strictEqual(await helper.waitForProcessExit(launchedPid, 5000), true);
    launchedPid = 0;

    restartPid = restartHelper.launchApp(process.execPath, [childScript, heartbeatPath, 'restart-test']);
    assert(Number.isSafeInteger(restartPid) && restartPid > 0);
    assert.strictEqual(await helper.waitForHealthyHeartbeat(heartbeatPath, 'restart-test', restartPid, 5000), true);
    process.kill(restartPid);
    assert.strictEqual(await restartHelper.waitForProcessExit(restartPid, 5000), true);
    restartPid = 0;
  } finally {
    if (launchedPid) { try { process.kill(launchedPid); } catch (_) {} }
    if (restartPid) { try { process.kill(restartPid); } catch (_) {} }
    fs.rmSync(launchRoot, { recursive: true, force: true });
  }

  const rs = createReportSync({ getToken: () => '', useFallbackToken: false });
  const emptyRes = await rs.syncReportsAsync({});
  assert.strictEqual(emptyRes.skipped, true);
  assert.strictEqual(emptyRes.reason, 'empty_content');

  const noTokenRes = await rs.syncReportsAsync({ humanText: 'test' });
  assert.strictEqual(noTokenRes.skipped, true);
  assert.strictEqual(noTokenRes.reason, 'no_token');

  let reportBranchGets = 0;
  let reportFileGets = 0;
  let reportPuts = 0;
  let heartbeatFileGets = 0;
  let heartbeatPuts = 0;
  const reportRequest = async (url, method, token, body) => {
    const parsed = new URL(url);
    if (method === 'GET' && parsed.pathname.endsWith('/branches/reports')) {
      reportBranchGets++;
      return { statusCode: 200, headers: {}, data: {} };
    }
    if (method === 'GET' && parsed.pathname.includes('/contents/reports/')) {
      reportFileGets++;
      return { statusCode: 200, headers: {}, data: { sha: 'remote-sha-1' } };
    }
    if (method === 'PUT' && parsed.pathname.includes('/contents/reports/')) {
      reportPuts++;
      assert(body.sha, 'Cached or fetched SHA must be included when updating a report');
      return { statusCode: 200, headers: {}, data: { content: { sha: `remote-sha-${reportPuts + 1}` } } };
    }
    if (method === 'GET' && parsed.pathname.includes('/contents/status/heartbeat-')) {
      heartbeatFileGets++;
      return { statusCode: 200, headers: {}, data: { sha: 'heartbeat-sha-1' } };
    }
    if (method === 'PUT' && parsed.pathname.includes('/contents/status/heartbeat-')) {
      heartbeatPuts++;
      assert(body.sha, 'Cached or fetched SHA must be included when updating a heartbeat');
      return { statusCode: 200, headers: {}, data: { content: { sha: `heartbeat-sha-${heartbeatPuts + 1}` } } };
    }
    throw new Error(`Unexpected report request: ${method} ${parsed.pathname}`);
  };
  const optimizedReportSync = createReportSync({
    getToken: () => 'test-token',
    getRepository: () => 'owner/repo',
    machineName: 'TEST PC',
    useFallbackToken: false,
    githubRequest: reportRequest
  });
  await optimizedReportSync.syncReportsAsync({ humanText: 'Phiên bản app: v1\nThời gian xuất: A\nevent-a' }, { force: true });
  await optimizedReportSync.syncReportsAsync({ humanText: 'Phiên bản app: v1\nThời gian xuất: B\nevent-a' }, { force: true });
  const unchangedReport = await optimizedReportSync.syncReportsAsync({ humanText: 'Phiên bản app: v1\nThời gian xuất: C\nevent-a' });
  assert.strictEqual(unchangedReport.reason, 'content_unchanged');
  assert.strictEqual(reportBranchGets, 1, 'Report branch must be verified only once');
  assert.strictEqual(reportFileGets, 1, 'Remote report SHA must be cached after the first upload');
  assert.strictEqual(reportPuts, 2);
  await optimizedReportSync.syncHeartbeatAsync({ state: 'online', version: '1.2.20' }, { force: true });
  await optimizedReportSync.syncHeartbeatAsync({ state: 'offline', reason: 'test' }, { force: true });
  const throttledHeartbeat = await optimizedReportSync.syncHeartbeatAsync({ state: 'online' });
  assert.strictEqual(throttledHeartbeat.reason, 'throttled');
  const realDateNow = Date.now;
  const heartbeatBoundaryNow = realDateNow() + (5 * 60 * 1000) - 1000;
  Date.now = () => heartbeatBoundaryNow;
  try {
    const boundaryHeartbeat = await optimizedReportSync.syncHeartbeatAsync({ state: 'online' });
    assert.strictEqual(boundaryHeartbeat.success, true, 'Five-minute scheduler boundary must not be skipped');
  } finally {
    Date.now = realDateNow;
  }
  assert.strictEqual(heartbeatFileGets, 1, 'Remote heartbeat SHA must be cached after the first upload');
  assert.strictEqual(heartbeatPuts, 3);

  const rcr = createRemoteCommandReceiver({ getToken: () => '', handlers: { ping: () => 'pong' } });
  assert.strictEqual(typeof rcr.start, 'function');
  assert.strictEqual(typeof rcr.checkNow, 'function');
  assert.strictEqual(typeof rcr.getStatus, 'function');

  // A failed Ack upload must not create Done or execute the same command twice.
  // The next poll retries publication from local state and then records Done.
  const receiverStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thaiasia-command-test-'));
  try {
    const command = { id: 'test-100', target: 'all', action: 'ping', params: {} };
    const commandContent = Buffer.from(JSON.stringify(command), 'utf8').toString('base64');
    let handlerRuns = 0;
    let ackPutAttempts = 0;
    let doneWrites = 0;
    let doneExists = false;
    const writeOrder = [];

    let commandGets = 0;
    let conditionalDirectoryGets = 0;
    const mockGithubRequest = async (url, method, bodyToken, bodyData, requestOptions = {}) => {
      const parsed = new URL(url);
      const apiPath = parsed.pathname;
      if (method === 'GET' && apiPath.endsWith('/contents/commands')) {
        if (requestOptions.headers && requestOptions.headers['If-None-Match']) {
          conditionalDirectoryGets++;
          return { statusCode: 304, headers: { etag: '"commands-v1"' }, data: null };
        }
        return {
          statusCode: 200,
          headers: { etag: '"commands-v1"' },
          data: [{ name: 'command-all.json', path: 'commands/command-all.json', sha: 'command-sha' }]
        };
      }
      if (method === 'GET' && apiPath.endsWith('/commands/command-all.json')) {
        commandGets++;
        return { statusCode: 200, headers: {}, data: { sha: 'command-sha', content: commandContent } };
      }
      if (method === 'GET' && apiPath.endsWith('/commands/done-test-100-TEST_PC.json')) {
        return { statusCode: doneExists ? 200 : 404, data: doneExists ? { sha: 'done-sha' } : { message: 'Not Found' } };
      }
      if (method === 'GET' && apiPath.endsWith('/commands/ack-TEST_PC.json')) {
        return { statusCode: 404, data: { message: 'Not Found' } };
      }
      if (method === 'PUT' && apiPath.endsWith('/commands/ack-TEST_PC.json')) {
        ackPutAttempts++;
        if (ackPutAttempts <= 2) return { statusCode: 403, data: { message: 'write denied' } };
        writeOrder.push('ack');
        return { statusCode: 201, data: { content: { sha: 'ack-sha' } } };
      }
      if (method === 'PUT' && apiPath.endsWith('/commands/done-test-100-TEST_PC.json')) {
        doneExists = true;
        doneWrites++;
        writeOrder.push('done');
        return { statusCode: 201, data: { content: { sha: 'done-sha' } } };
      }
      throw new Error(`Unexpected mock GitHub request: ${method} ${apiPath}`);
    };

    const reliableReceiver = createRemoteCommandReceiver({
      getToken: () => 'test-token',
      getRepository: () => 'owner/repo',
      machineName: 'TEST PC',
      stateDir: receiverStateDir,
      githubRequest: mockGithubRequest,
      handlers: { ping: () => { handlerRuns++; return 'pong'; } }
    });

    await reliableReceiver.checkNow();
    assert.strictEqual(handlerRuns, 1);
    assert.strictEqual(doneWrites, 0);
    assert.strictEqual(fs.existsSync(path.join(receiverStateDir, 'last-command.json')), true);

    await reliableReceiver.checkNow();
    assert.strictEqual(handlerRuns, 1);
    assert.strictEqual(doneWrites, 1);
    assert.deepStrictEqual(writeOrder, ['ack', 'done']);
    assert.strictEqual(fs.existsSync(path.join(receiverStateDir, 'last-command.json')), false);

    await reliableReceiver.checkNow();
    assert.strictEqual(handlerRuns, 1);
    assert.strictEqual(commandGets, 2, 'The pending publication may re-read the command once');
    assert.strictEqual(conditionalDirectoryGets, 1, 'Unchanged command directory must use an ETag request');
  } finally {
    fs.rmSync(receiverStateDir, { recursive: true, force: true });
  }

  let rateLimitedCalls = 0;
  const rateLimitedReceiver = createRemoteCommandReceiver({
    getToken: () => 'test-token',
    getRepository: () => 'owner/repo',
    machineName: 'RATE TEST',
    githubRequest: async () => {
      rateLimitedCalls++;
      return {
        statusCode: 429,
        headers: { 'retry-after': '120' },
        data: { message: 'secondary rate limit' }
      };
    }
  });
  await rateLimitedReceiver.checkNow();
  await rateLimitedReceiver.checkNow();
  assert.strictEqual(rateLimitedCalls, 1, 'Remote Control must stop polling during GitHub rate-limit backoff');
  assert(rateLimitedReceiver.getStatus().rateLimitedUntil);
})().then(() => {
  console.log('auto-update tests: OK');
}).catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
