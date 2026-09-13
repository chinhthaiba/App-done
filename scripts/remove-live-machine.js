'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const readline = require('readline');
const {
  findToken,
  readLocalMachineStatuses,
  writeHumanStatusReport
} = require('./pull-live-reports');

const root = path.resolve(__dirname, '..');
const reportsDir = path.join(root, 'reports');
const statusDir = path.join(reportsDir, 'status');
const syncStatePath = path.join(reportsDir, '.live-report-sync-state.json');
const DEFAULT_REPO = 'chinhthaiba/chinhthaiba-thaiasia-releases';
const REPORT_BRANCH = 'reports';
const DEFAULT_OFFLINE_AFTER_MS = 7 * 60 * 1000;

function normalizeMachineName(value) {
  const machine = String(value || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(machine)) {
    throw new Error('Ten may khong hop le. Chi dung chu, so, dau gach ngang hoac gach duoi.');
  }
  return machine;
}

function buildMachineTargets(machineName) {
  const machine = normalizeMachineName(machineName);
  return {
    remote: [
      `reports/ThaiAsia-24h-report-${machine}.txt`,
      `reports/ThaiAsia-24h-report-bundle-${machine}.txt`,
      `commands/ack-${machine}.json`,
      `status/heartbeat-${machine}.json`
    ],
    local: [
      path.join(reportsDir, `ThaiAsia-24h-report-${machine}.txt`),
      path.join(reportsDir, `ThaiAsia-24h-report-bundle-${machine}.txt`),
      path.join(statusDir, `heartbeat-${machine}.json`)
    ]
  };
}

function assessHeartbeatDeletionSafety(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return { safe: true, reason: 'heartbeat_missing' };
  const state = String(payload.state || '').toLowerCase();
  const lastSeenMs = Date.parse(String(payload.lastSeenAt || ''));
  const configuredOfflineAfterMs = Number(payload.offlineAfterMs);
  const offlineAfterMs = Number.isFinite(configuredOfflineAfterMs) && configuredOfflineAfterMs > 0
    ? Math.max(60 * 1000, configuredOfflineAfterMs)
    : DEFAULT_OFFLINE_AFTER_MS;
  const ageMs = Number.isFinite(lastSeenMs) ? Math.max(0, Number(nowMs) - lastSeenMs) : null;
  const fresh = ageMs != null && ageMs <= offlineAfterMs;
  if (state === 'online' && fresh) {
    return { safe: false, reason: 'machine_recently_online', ageMs, offlineAfterMs };
  }
  return { safe: true, reason: state === 'offline' ? 'machine_offline' : 'heartbeat_stale', ageMs, offlineAfterMs };
}

function apiPath(repo, filePath) {
  const safeRepo = String(repo || '').trim();
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(safeRepo)) throw new Error('Repository khong hop le');
  const encodedPath = String(filePath || '').split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${safeRepo}/contents/${encodedPath}`;
}

function githubRequest(urlString, method, token, payload = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload), 'utf8');
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ThaiAsia-LiveMachineCleaner/1',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (token && url.hostname.toLowerCase() === 'api.github.com') headers.Authorization = `Bearer ${token}`;
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = body.length;
    }
    const request = https.request(url, { method, headers, timeout: 20000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (_) {}
        resolve({ statusCode: Number(response.statusCode || 0), data, raw });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('GitHub timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function readRemoteJsonFile(repo, token, filePath) {
  const response = await githubRequest(`${apiPath(repo, filePath)}?ref=${encodeURIComponent(REPORT_BRANCH)}`, 'GET', token);
  if (response.statusCode === 404) return null;
  if (response.statusCode !== 200 || !response.data) {
    throw new Error(`Khong doc duoc ${filePath}: GitHub HTTP ${response.statusCode}`);
  }
  try {
    const text = Buffer.from(String(response.data.content || '').replace(/\s+/g, ''), 'base64').toString('utf8');
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function deleteRemoteFile(repo, token, filePath) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const getResponse = await githubRequest(`${apiPath(repo, filePath)}?ref=${encodeURIComponent(REPORT_BRANCH)}`, 'GET', token);
    if (getResponse.statusCode === 404) return { path: filePath, result: 'not_found' };
    const sha = getResponse.data && getResponse.data.sha;
    if (getResponse.statusCode !== 200 || !sha) {
      throw new Error(`Khong lay duoc SHA cua ${filePath}: GitHub HTTP ${getResponse.statusCode}`);
    }
    const deleteResponse = await githubRequest(apiPath(repo, filePath), 'DELETE', token, {
      message: `Remove retired live machine ${path.basename(filePath)} [skip ci]`,
      sha,
      branch: REPORT_BRANCH
    });
    if (deleteResponse.statusCode === 200) return { path: filePath, result: 'deleted' };
    if (deleteResponse.statusCode !== 409 || attempt >= 2) {
      throw new Error(`Khong xoa duoc ${filePath}: GitHub HTTP ${deleteResponse.statusCode}`);
    }
  }
  throw new Error(`Khong xoa duoc ${filePath}`);
}

function readLocalHeartbeat(machineName) {
  const heartbeatPath = path.join(statusDir, `heartbeat-${normalizeMachineName(machineName)}.json`);
  try { return JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')); } catch (_) { return null; }
}

function assertLocalTarget(targetPath, baseDir = reportsDir) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (target === base || !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Tu choi xoa duong dan ngoai reports: ${target}`);
  }
  return target;
}

function cleanupLocalMachineFiles(machineName, baseDir = reportsDir) {
  const machine = normalizeMachineName(machineName);
  const localTargets = [
    path.join(baseDir, `ThaiAsia-24h-report-${machine}.txt`),
    path.join(baseDir, `ThaiAsia-24h-report-bundle-${machine}.txt`),
    path.join(baseDir, 'status', `heartbeat-${machine}.json`)
  ];
  const removed = [];
  for (const target of localTargets) {
    const safeTarget = assertLocalTarget(target, baseDir);
    try {
      fs.unlinkSync(safeTarget);
      removed.push(safeTarget);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

function cleanupLocalSyncState(machineName) {
  const machine = normalizeMachineName(machineName);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(syncStatePath, 'utf8')); } catch (_) {}
  if (!state || typeof state !== 'object') state = {};
  if (state.fileShas && typeof state.fileShas === 'object') {
    delete state.fileShas[`ThaiAsia-24h-report-${machine}.txt`];
    delete state.fileShas[`ThaiAsia-24h-report-bundle-${machine}.txt`];
  }
  if (state.statusFileShas && typeof state.statusFileShas === 'object') {
    delete state.statusFileShas[`heartbeat-${machine}.json`];
  }
  state.directoryEtag = '';
  state.statusDirectoryEtag = '';
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(syncStatePath, JSON.stringify(state, null, 2), 'utf8');
}

function askConfirmation(machineName) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Nhap lai chinh xac ten may '${machineName}' de xac nhan xoa: `, (answer) => {
      rl.close();
      resolve(String(answer || '').trim() === machineName);
    });
  });
}

function parseArgs(argv, env = process.env) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const machineArg = args.find((arg) => !String(arg).startsWith('--'))
    || (env && env.THAIASIA_REMOVE_MACHINE);
  return {
    machine: normalizeMachineName(machineArg),
    repo: String((args.find((arg) => String(arg).startsWith('--repo=')) || '').slice(7) || DEFAULT_REPO),
    yes: args.includes('--yes'),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run')
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error('[Loi]', error.message);
    console.log('Cach dung: npm run live:remove-machine -- <Ten-May> [--dry-run] [--yes] [--force]');
    process.exitCode = 1;
    return;
  }

  const targets = buildMachineTargets(options.machine);
  console.log('============================================================');
  console.log(` MAY SE DUOC GO BO KHOI LIVE REPORT: ${options.machine}`);
  console.log('============================================================');
  console.log('GitHub:');
  targets.remote.forEach((item) => console.log(`  - ${item}`));
  console.log('May chinh:');
  targets.local.forEach((item) => console.log(`  - ${item}`));
  if (options.dryRun) {
    console.log('\n[DRY RUN] Chua xoa file nao.');
    return;
  }

  const token = findToken();
  if (!token) {
    console.error('[Loi] Khong tim thay GitHub token.');
    process.exitCode = 1;
    return;
  }

  const heartbeatPath = `status/heartbeat-${options.machine}.json`;
  const remoteHeartbeat = await readRemoteJsonFile(options.repo, token, heartbeatPath);
  const heartbeat = remoteHeartbeat || readLocalHeartbeat(options.machine);
  const safety = assessHeartbeatDeletionSafety(heartbeat);
  if (!safety.safe && !options.force) {
    const seconds = Math.round(Number(safety.ageMs || 0) / 1000);
    console.error(`[Tu choi] May ${options.machine} van dang online; tin hieu cach day ${seconds} giay.`);
    console.error(`Hay tat app tren may do, doi heartbeat chuyen offline, roi chay lai. Chi dung --force khi chac chan.`);
    process.exitCode = 2;
    return;
  }

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.error('[Tu choi] Can terminal tuong tac de xac nhan, hoac truyen --yes.');
      process.exitCode = 1;
      return;
    }
    const confirmed = await askConfirmation(options.machine);
    if (!confirmed) {
      console.log('[Huy] Ten xac nhan khong khop. Chua xoa file nao.');
      return;
    }
  }

  const results = [];
  for (let index = 0; index < targets.remote.length; index += 1) {
    const filePath = targets.remote[index];
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await deleteRemoteFile(options.repo, token, filePath);
    results.push(result);
    console.log(result.result === 'deleted' ? `[GitHub] Da xoa ${filePath}` : `[GitHub] Khong ton tai ${filePath}`);
  }

  const localRemoved = cleanupLocalMachineFiles(options.machine);
  cleanupLocalSyncState(options.machine);
  try { writeHumanStatusReport(readLocalMachineStatuses()); } catch (_) {}
  console.log(`[May chinh] Da xoa ${localRemoved.length} file cuc bo.`);
  console.log(`[Hoan tat] May ${options.machine} da duoc go khoi Live Report.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[Loi]', error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeMachineName,
  buildMachineTargets,
  assessHeartbeatDeletionSafety,
  assertLocalTarget,
  cleanupLocalMachineFiles,
  parseArgs
};
