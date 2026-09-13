'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const root = path.resolve(__dirname, '..');
const reportsDir = path.join(root, 'reports');
const statusDir = path.join(reportsDir, 'status');
const humanStatusPath = path.join(statusDir, 'ThaiAsia-trang-thai-may.txt');
const syncStatePath = path.join(reportsDir, '.live-report-sync-state.json');
const DEFAULT_REPO = 'x247hl/thaiasia-releases';
const REPORT_BRANCH = 'reports';
const POLL_INTERVAL_MS = 60 * 1000; // In watch mode, pull every 60 seconds
const OFFLINE_AFTER_MS = 7 * 60 * 1000;

function loadSyncState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStatePath, 'utf8'));
    return {
      directoryEtag: String(parsed && parsed.directoryEtag || ''),
      fileShas: parsed && parsed.fileShas && typeof parsed.fileShas === 'object'
        ? parsed.fileShas
        : {},
      statusDirectoryEtag: String(parsed && parsed.statusDirectoryEtag || ''),
      statusFileShas: parsed && parsed.statusFileShas && typeof parsed.statusFileShas === 'object'
        ? parsed.statusFileShas
        : {},
      rateLimitedUntil: Number(parsed && parsed.rateLimitedUntil || 0)
    };
  } catch (_) {
    return {
      directoryEtag: '',
      fileShas: {},
      statusDirectoryEtag: '',
      statusFileShas: {},
      rateLimitedUntil: 0
    };
  }
}

function saveSyncState(state) {
  try {
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(syncStatePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

const liveSyncState = loadSyncState();

function getRateLimitDelayMs(response, nowMs = Date.now()) {
  const statusCode = Number(response && response.statusCode || 0);
  if (statusCode !== 403 && statusCode !== 429) return 0;
  const headers = response && response.headers || {};
  const message = String(
    response && response.data && response.data.message || response && response.raw || ''
  ).toLowerCase();
  const retryAfterSeconds = Number(headers['retry-after']);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const resetSeconds = Number(headers['x-ratelimit-reset']);
  const limited = statusCode === 429 || Number.isFinite(retryAfterSeconds) || remaining === 0 || message.includes('rate limit');
  if (!limited) return 0;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.max(60 * 1000, Math.ceil(retryAfterSeconds * 1000));
  }
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return Math.max(60 * 1000, (resetSeconds * 1000) - Number(nowMs) + 5000);
  }
  return 60 * 1000;
}

function findToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const guidePath = path.join(root, 'AUTO-UPDATE-HUONG-DAN.md');
  if (fs.existsSync(guidePath)) {
    const text = fs.readFileSync(guidePath, 'utf8');
    const match = text.match(/github_pat_[A-Za-z0-9_]+/);
    if (match) return match[0].trim();
  }
  return '';
}

function githubGet(urlStr, token, redirects = 0, extraHeaders = {}) {
  if (redirects > 5) return Promise.reject(new Error('GitHub redirects exceeded'));
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const headers = {
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'ThaiAsia-ReportPuller/1',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extraHeaders
    };
    if (token && url.hostname.toLowerCase() === 'api.github.com') headers.Authorization = `Bearer ${token}`;

    const req = https.get(url, { headers, timeout: 30000 }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        githubGet(next, token, redirects + 1, extraHeaders).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode, headers: res.headers, raw });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub timeout')));
    req.on('error', reject);
  });
}

function githubGetJson(urlStr, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ThaiAsia-ReportPuller/1',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extraHeaders
    };
    if (token && url.hostname.toLowerCase() === 'api.github.com') headers.Authorization = `Bearer ${token}`;

    const req = https.get(url, { headers, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (_) {}
        resolve({ statusCode: Number(res.statusCode || 0), headers: res.headers, data, raw });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub timeout')));
    req.on('error', reject);
  });
}

async function fetchFile(repo, token, filePath, branch) {
  const url = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`;
  const res = await githubGet(url, token);
  const rateLimitWaitMs = getRateLimitDelayMs(res);
  if (rateLimitWaitMs > 0) {
    const error = new Error(`GitHub rate limit; retry after ${Math.ceil(rateLimitWaitMs / 1000)}s`);
    error.rateLimitWaitMs = rateLimitWaitMs;
    throw error;
  }
  if (res.statusCode === 404) return null;
  if (res.statusCode !== 200) {
    throw new Error(`GitHub GET ${filePath} failed with HTTP ${res.statusCode}: ${res.raw.slice(0, 300)}`);
  }
  return res.raw;
}

async function pullOnce(repo, token, state = liveSyncState) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const pulledFiles = [];
  let availableFiles = [];
  if (Number(state.rateLimitedUntil || 0) > Date.now()) {
    const hasLocalData = Object.keys(state.fileShas || {}).some((name) =>
      fs.existsSync(path.join(reportsDir, name))
    );
    return {
      pulledFiles,
      hasData: hasLocalData,
      unchanged: true,
      rateLimited: true,
      waitMs: Number(state.rateLimitedUntil) - Date.now()
    };
  }

  // 1. List all files in 'reports' folder on GitHub
  const dirUrl = `https://api.github.com/repos/${repo}/contents/reports?ref=${REPORT_BRANCH}`;
  const listRes = await githubGetJson(
    dirUrl,
    token,
    state.directoryEtag ? { 'If-None-Match': state.directoryEtag } : {}
  );
  const listRateLimitWaitMs = getRateLimitDelayMs(listRes);
  if (listRateLimitWaitMs > 0) {
    state.rateLimitedUntil = Date.now() + listRateLimitWaitMs;
    saveSyncState(state);
    return { pulledFiles, hasData: true, unchanged: true, rateLimited: true, waitMs: listRateLimitWaitMs };
  }
  state.rateLimitedUntil = 0;

  if (listRes.statusCode === 304) {
    const hasLocalData = Object.keys(state.fileShas || {}).some((name) =>
      fs.existsSync(path.join(reportsDir, name))
    );
    return { pulledFiles, hasData: hasLocalData, unchanged: true };
  }

  const nextEtag = String(listRes.headers && listRes.headers.etag || '');
  if (nextEtag) state.directoryEtag = nextEtag;

  if (listRes.statusCode === 200 && Array.isArray(listRes.data)) {
    for (const item of listRes.data) {
      if (item && item.type === 'file' && item.name) {
        availableFiles.push(item.name);
        const localPath = path.join(reportsDir, item.name);
        const remoteSha = String(item.sha || '');
        if (remoteSha && state.fileShas[item.name] === remoteSha && fs.existsSync(localPath)) {
          continue;
        }
        let content;
        try {
          content = await fetchFile(repo, token, item.path, REPORT_BRANCH);
        } catch (error) {
          if (Number(error && error.rateLimitWaitMs) > 0) {
            state.rateLimitedUntil = Date.now() + Number(error.rateLimitWaitMs);
            saveSyncState(state);
          }
          throw error;
        }
        if (content !== null) {
          fs.writeFileSync(localPath, content, 'utf8');
          if (remoteSha) state.fileShas[item.name] = remoteSha;
          pulledFiles.push(item.name);
        }
      }
    }
    saveSyncState(state);
  }

  // 2. Fallback for legacy single file name if no files found
  if (availableFiles.length === 0) {
    const txtContent = await fetchFile(repo, token, 'reports/ThaiAsia-24h-report.txt', REPORT_BRANCH);
    if (txtContent !== null) {
      fs.writeFileSync(path.join(reportsDir, 'ThaiAsia-24h-report.txt'), txtContent, 'utf8');
      pulledFiles.push('ThaiAsia-24h-report.txt');
      availableFiles.push('ThaiAsia-24h-report.txt');
    }
  }

  return { pulledFiles, hasData: availableFiles.length > 0, unchanged: pulledFiles.length === 0 };
}

function evaluateMachineHeartbeat(payload, nowMs = Date.now(), offlineAfterMs = OFFLINE_AFTER_MS) {
  const heartbeat = payload && typeof payload === 'object' ? payload : {};
  const machine = String(heartbeat.machine || 'unknown');
  const lastSeenAt = String(heartbeat.lastSeenAt || '');
  const lastSeenMs = Date.parse(lastSeenAt);
  const ageMs = Number.isFinite(lastSeenMs) ? Math.max(0, Number(nowMs) - lastSeenMs) : null;
  const explicitOffline = String(heartbeat.state || '').toLowerCase() === 'offline';
  let state = 'unknown';
  let reason = String(heartbeat.reason || '');
  if (explicitOffline) {
    state = 'offline';
    if (!reason) reason = 'clean_shutdown';
  } else if (ageMs !== null) {
    state = ageMs > Number(offlineAfterMs) ? 'offline' : 'online';
    if (state === 'offline' && !reason) reason = 'heartbeat_timeout';
  }
  return {
    machine,
    state,
    reason,
    lastSeenAt,
    ageMs,
    version: String(heartbeat.version || ''),
    bootId: String(heartbeat.bootId || ''),
    startedAt: String(heartbeat.startedAt || ''),
    offlineAfterMs: Number(heartbeat.offlineAfterMs || offlineAfterMs),
    remoteControlRunning: Boolean(heartbeat.remoteControl && heartbeat.remoteControl.running),
    previousUnexpectedStop: heartbeat.previousUnexpectedStop || null
  };
}

function readReportEvidenceByMachine() {
  const evidence = new Map();
  if (!fs.existsSync(reportsDir)) return evidence;
  const prefix = 'ThaiAsia-24h-report-bundle-';
  for (const name of fs.readdirSync(reportsDir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.txt')) continue;
    const machine = name.slice(prefix.length, -4);
    const filePath = path.join(reportsDir, name);
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const header = buffer.subarray(0, bytesRead).toString('utf8');
      const match = header.match(/^Generated:\s*(.+)$/m);
      const generatedAt = match ? match[1].trim() : '';
      const generatedMs = Date.parse(generatedAt);
      if (Number.isFinite(generatedMs)) evidence.set(machine, { generatedAt, generatedMs });
    } catch (_) {
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_) {}
    }
  }
  return evidence;
}

function applyRecentReportEvidence(statuses, reportEvidence, nowMs = Date.now(), offlineAfterMs = OFFLINE_AFTER_MS) {
  return (statuses || []).map((status) => {
    if (!status || status.state !== 'offline' || status.reason !== 'heartbeat_timeout') return status;
    const evidence = reportEvidence && typeof reportEvidence.get === 'function'
      ? reportEvidence.get(status.machine)
      : null;
    const proofMs = Number(evidence && evidence.generatedMs);
    const heartbeatMs = Date.parse(String(status.lastSeenAt || ''));
    if (!Number.isFinite(proofMs) || nowMs - proofMs > offlineAfterMs || (Number.isFinite(heartbeatMs) && proofMs <= heartbeatMs)) {
      return status;
    }
    return {
      ...status,
      state: 'online',
      reason: 'recent_report_activity',
      heartbeatDelayed: true,
      lastSeenAt: String(evidence.generatedAt || new Date(proofMs).toISOString()),
      ageMs: Math.max(0, nowMs - proofMs)
    };
  });
}

function readLocalMachineStatuses(nowMs = Date.now()) {
  if (!fs.existsSync(statusDir)) return [];
  const statuses = fs.readdirSync(statusDir)
    .filter((name) => /^heartbeat-[a-zA-Z0-9_-]+\.json$/.test(name))
    .map((name) => {
      try {
        return evaluateMachineHeartbeat(JSON.parse(fs.readFileSync(path.join(statusDir, name), 'utf8')), nowMs);
      } catch (_) {
        return evaluateMachineHeartbeat({ machine: name.slice(10, -5) }, nowMs);
      }
    })
    .sort((a, b) => a.machine.localeCompare(b.machine));
  return applyRecentReportEvidence(statuses, readReportEvidenceByMachine(), nowMs);
}

async function pullMachineStatuses(repo, token, state = liveSyncState, nowMs = Date.now()) {
  fs.mkdirSync(statusDir, { recursive: true });
  if (!state.statusFileShas || typeof state.statusFileShas !== 'object') state.statusFileShas = {};
  if (Number(state.rateLimitedUntil || 0) > nowMs) {
    return { statuses: readLocalMachineStatuses(nowMs), unchanged: true, rateLimited: true };
  }

  const url = `https://api.github.com/repos/${repo}/contents/status?ref=${REPORT_BRANCH}`;
  const response = await githubGetJson(
    url,
    token,
    state.statusDirectoryEtag ? { 'If-None-Match': state.statusDirectoryEtag } : {}
  );
  const rateLimitWaitMs = getRateLimitDelayMs(response, nowMs);
  if (rateLimitWaitMs > 0) {
    state.rateLimitedUntil = nowMs + rateLimitWaitMs;
    saveSyncState(state);
    return { statuses: readLocalMachineStatuses(nowMs), unchanged: true, rateLimited: true };
  }
  state.rateLimitedUntil = 0;

  if (response.statusCode === 304) {
    return { statuses: readLocalMachineStatuses(nowMs), unchanged: true };
  }
  if (response.statusCode === 404) {
    state.statusDirectoryEtag = '';
    saveSyncState(state);
    return { statuses: readLocalMachineStatuses(nowMs), unchanged: true };
  }
  if (response.statusCode !== 200 || !Array.isArray(response.data)) {
    throw new Error(`GitHub GET status failed with HTTP ${response.statusCode}: ${response.raw.slice(0, 300)}`);
  }

  const etag = String(response.headers && response.headers.etag || '');
  if (etag) state.statusDirectoryEtag = etag;
  const remoteNames = new Set();
  const pulledFiles = [];
  for (const item of response.data) {
    if (!item || item.type !== 'file' || !/^heartbeat-[a-zA-Z0-9_-]+\.json$/.test(String(item.name || ''))) continue;
    const name = String(item.name);
    const localPath = path.join(statusDir, name);
    const remoteSha = String(item.sha || '');
    remoteNames.add(name);
    if (remoteSha && state.statusFileShas[name] === remoteSha && fs.existsSync(localPath)) continue;
    try {
      const content = await fetchFile(repo, token, item.path, REPORT_BRANCH);
      if (content !== null) {
        fs.writeFileSync(localPath, content, 'utf8');
        if (remoteSha) state.statusFileShas[name] = remoteSha;
        pulledFiles.push(name);
      }
    } catch (error) {
      if (Number(error && error.rateLimitWaitMs) > 0) {
        state.rateLimitedUntil = Date.now() + Number(error.rateLimitWaitMs);
        saveSyncState(state);
      }
      throw error;
    }
  }

  for (const name of Object.keys(state.statusFileShas)) {
    if (remoteNames.has(name)) continue;
    delete state.statusFileShas[name];
    try { fs.unlinkSync(path.join(statusDir, name)); } catch (_) {}
  }
  saveSyncState(state);
  return {
    statuses: readLocalMachineStatuses(nowMs),
    pulledFiles,
    unchanged: pulledFiles.length === 0
  };
}

function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'khong ro';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatAgeVietnamese(ageMs) {
  if (!Number.isFinite(ageMs)) return 'Không xác định';
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds} giây trước`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút ${seconds % 60} giây trước`;
  const hours = Math.floor(minutes / 60);
  return `${hours} giờ ${minutes % 60} phút trước`;
}

function formatLocalTime(value) {
  const time = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(time)) return 'Không xác định';
  return new Date(time).toLocaleString('vi-VN', { hour12: false });
}

function explainOfflineReason(reason) {
  const value = String(reason || '');
  if (value === 'heartbeat_timeout') return 'Không nhận được tín hiệu hơn 7 phút. Có thể app đã tắt, máy mất điện hoặc mất mạng.';
  if (value === 'app_quit' || value === 'menu-quit-app' || value === 'remote_quit') return 'App đã được tắt bình thường.';
  if (value === 'windows_shutdown_restart_or_logoff') return 'Windows đã tắt, khởi động lại hoặc đăng xuất.';
  if (value.startsWith('auto_update_to_')) return 'App tạm dừng để cài bản cập nhật.';
  if (value.includes('restart') || value.includes('relaunch')) return 'App đang khởi động lại.';
  if (value === 'remote_wipe') return 'App đã nhận lệnh xóa từ xa.';
  return value ? `App đã dừng. Mã lý do: ${value}` : 'App đã tắt hoặc không còn kết nối.';
}

function buildHumanStatusReport(statuses, nowMs = Date.now()) {
  const lines = [
    '======================================================================',
    '                 TRẠNG THÁI CÁC MÁY THAIASIA',
    '======================================================================',
    `Cập nhật trên máy chính lúc: ${formatLocalTime(nowMs)}`,
    'Quy ước: Không có tín hiệu mới trong hơn 7 phút thì máy được báo mất kết nối.',
    ''
  ];
  if (!Array.isArray(statuses) || statuses.length === 0) {
    lines.push('CHƯA NHẬN ĐƯỢC TÍN HIỆU TỪ MÁY NÀO.');
    lines.push('Máy nhà hàng cần chạy phiên bản có chức năng heartbeat.');
    return `${lines.join('\n')}\n`;
  }
  statuses.forEach((status, index) => {
    const timedOut = status.state === 'offline' && status.reason === 'heartbeat_timeout';
    const stateLabel = status.state === 'online'
      ? 'ĐANG HOẠT ĐỘNG'
      : (timedOut ? 'CHƯA NHẬN ĐƯỢC TÍN HIỆU' : (status.state === 'offline' ? 'APP ĐÃ TẮT' : 'CHƯA XÁC ĐỊNH'));
    lines.push(`${index + 1}. Máy: ${status.machine}`);
    lines.push(`   Trạng thái: ${stateLabel}`);
    lines.push(`   Phiên bản app: ${status.version ? `v${status.version}` : 'Không xác định'}`);
    lines.push(`   App khởi động lúc: ${formatLocalTime(status.startedAt)}`);
    lines.push(`   Tín hiệu gần nhất: ${formatLocalTime(status.lastSeenAt)} (${formatAgeVietnamese(status.ageMs)})`);
    if (status.state === 'online') {
      const remoteControlLabel = status.remoteControlRunning
        ? 'Đang hoạt động'
        : (status.reason === 'startup' ? 'Đang khởi động' : 'Chưa xác nhận được');
      lines.push(`   Điều khiển từ xa: ${remoteControlLabel}`);
      if (status.heartbeatDelayed) {
        lines.push('   Ghi chú: Heartbeat đang chậm; app vẫn hoạt động vì vừa gửi report mới lên GitHub.');
      }
    } else if (status.state === 'offline') {
      lines.push(`   Giải thích: ${explainOfflineReason(status.reason)}`);
    }
    if (status.previousUnexpectedStop) {
      const previousLastSeen = status.previousUnexpectedStop.lastSeenAt;
      lines.push(`   Lần chạy trước bị tắt bất thường; tín hiệu cuối: ${formatLocalTime(previousLastSeen)}`);
    }
    lines.push('');
  });
  return `${lines.join('\n')}\n`;
}

function writeHumanStatusReport(statuses, nowMs = Date.now()) {
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(humanStatusPath, buildHumanStatusReport(statuses, nowMs), 'utf8');
  return humanStatusPath;
}

function printMachineStatuses(statuses, prefix = '') {
  if (!statuses || statuses.length === 0) {
    console.log(`${prefix}[TRANG THAI] Chua nhan duoc heartbeat tu may nao.`);
    return;
  }
  for (const status of statuses || []) {
    const timedOut = status.state === 'offline' && status.reason === 'heartbeat_timeout';
    const label = status.state === 'online' ? 'DANG CHAY' : (timedOut ? 'MAT TIN HIEU' : (status.state === 'offline' ? 'APP DA TAT' : 'CHUA RO'));
    const reason = status.state === 'offline' ? ` | ${explainOfflineReason(status.reason)}` : '';
    const version = status.version ? ` | ban ${status.version}` : '';
    console.log(`${prefix}[${label}] May ${status.machine}${version} | tin hieu ${formatAgeVietnamese(status.ageMs)}${reason}`);
  }
}

async function main() {
  const isWatch = process.argv.includes('--watch');
  const repo = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : DEFAULT_REPO;
  const token = findToken();

  if (!token) {
    console.error('[Error] Khong tim thay GitHub token. Hay dat bien moi truong GITHUB_TOKEN hoac ghi vao AUTO-UPDATE-HUONG-DAN.md');
    process.exit(1);
  }

  console.log(`[ThaiAsia Reports] Ket noi toi repository: ${repo} (nhanh: ${REPORT_BRANCH})`);

  if (!isWatch) {
    try {
      const result = await pullOnce(repo, token);
      const statusResult = await pullMachineStatuses(repo, token);
      writeHumanStatusReport(statusResult.statuses);
      if (result.hasData) {
        if (result.unchanged) {
          console.log(`[ThaiAsia Reports] Bao cao tren GitHub khong thay doi. Khong can tai lai.`);
        } else {
          console.log(`[ThaiAsia Reports] Da dong bo thanh cong ${result.pulledFiles.length} file bao cao vao: ${reportsDir}`);
          result.pulledFiles.forEach((name) => console.log(`   - ${name}`));
        }
      } else {
        console.log(`[ThaiAsia Reports] Chua tim thay bao cao nao tren nhanh '${REPORT_BRANCH}'. (App tren Win 7 se day len sau chu ky tiep theo).`);
      }
      printMachineStatuses(statusResult.statuses, '[ThaiAsia Status] ');
      console.log(`[ThaiAsia Status] Ban de doc: ${humanStatusPath}`);
    } catch (err) {
      console.error('[ThaiAsia Reports] Loi dong bo:', err.message);
      process.exit(1);
    }
    return;
  }

  console.log('[ThaiAsia Reports] Che do LIVE SYNC dang chay (tu dong quet moi 60s). Nhan Ctrl+C de dung.');
  console.log('------------------------------------------------------------');

  const runLoop = async () => {
    try {
      const result = await pullOnce(repo, token);
      const statusResult = await pullMachineStatuses(repo, token);
      writeHumanStatusReport(statusResult.statuses);
      const timeStr = new Date().toLocaleTimeString();
      if (result.hasData) {
        if (result.unchanged) {
          console.log(`[${timeStr}] Live Sync: Bao cao khong thay doi.`);
        } else {
          console.log(`[${timeStr}] Live Sync: Da cap nhat ${result.pulledFiles.length} file bao cao tu cac may nha hang! (${result.pulledFiles.join(', ')})`);
        }
      } else {
        console.log(`[${timeStr}] Dang cho bao cao moi tu nha hang...`);
      }
      printMachineStatuses(statusResult.statuses, `[${timeStr}] `);
    } catch (err) {
      console.log(`[${new Date().toLocaleTimeString()}] Loi ket noi: ${err.message}`);
    }
  };

  await runLoop();
  setInterval(runLoop, POLL_INTERVAL_MS);
}

if (require.main === module) {
  main();
}

module.exports = {
  pullOnce,
  pullMachineStatuses,
  evaluateMachineHeartbeat,
  readLocalMachineStatuses,
  buildHumanStatusReport,
  writeHumanStatusReport,
  applyRecentReportEvidence,
  fetchFile,
  findToken,
  loadSyncState
};
