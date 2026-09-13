'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const releaseFiles = require('./release-files');
const {
  MANIFEST_ASSET_NAME,
  SIGNATURE_ASSET_NAME,
  MAX_MANIFEST_BYTES,
  MAX_SIGNATURE_BYTES,
  MAX_BUNDLE_BYTES,
  compareVersions,
  normalizeVersion,
  normalizeReleasePath,
  sha256,
  validateManifest
} = require('./release-format');

const DEFAULT_REPOSITORY = 'x247hl/thaiasia-releases';
const DEFAULT_FALLBACK_TOKEN = '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';
const DEFAULT_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 15 * 1000;
const INSTALL_RETRY_INTERVAL_MS = 1000;
const REQUIRED_IDLE_MS = 2 * 60 * 1000;
const MAX_UNCOMPRESSED_BUNDLE_BYTES = 64 * 1024 * 1024;

function createAutoUpdateManager(options) {
  const {
    app,
    BrowserWindow,
    ipcMain,
    safeStorage,
    dialog,
    appDir,
    userDataDir,
    heartbeatPath,
    watchdogStateDir,
    log = () => {},
    isAppBusy = async () => true,
    requestQuitForUpdate = () => app.quit()
  } = options;

  const updateRoot = path.join(userDataDir, 'updates');
  const configPath = path.join(updateRoot, 'auto-update-config.json');
  const statusPath = path.join(updateRoot, 'auto-update-status.json');
  const logPath = path.join(updateRoot, 'auto-update.log');
  const publicKeyPath = path.join(appDir, 'updater', 'update-public-key.pem');
  const updateLockPath = path.join(watchdogStateDir, 'update.lock');
  let config = loadConfig();
  let settingsWindow = null;
  let checkTimer = null;
  let installTimer = null;
  let checkInFlight = false;
  let applyStarted = false;
  let pendingUpdate = null;
  let idleSince = 0;
  let status = readJson(statusPath, {
    state: 'idle',
    currentVersion: app.getVersion(),
    lastCheckAt: null,
    message: 'Chưa kiểm tra cập nhật'
  });

  fs.mkdirSync(updateRoot, { recursive: true });

  function appendLog(message, detail) {
    const suffix = detail === undefined ? '' : ` ${safeJson(detail)}`;
    const line = `[${new Date().toISOString()}] ${message}${suffix}`;
    try { fs.appendFileSync(logPath, `${line}\n`, 'utf8'); } catch (_) {}
    try { log(`[AutoUpdate] ${message}`, detail === undefined ? '' : detail); } catch (_) {}
  }

  function updateStatus(next) {
    status = {
      ...status,
      ...next,
      currentVersion: app.getVersion(),
      updatedAt: new Date().toISOString()
    };
    writeJsonAtomic(statusPath, status);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('thaiasia-updater:status-changed', publicStatus());
    }
  }

  function publicStatus() {
    return {
      ...status,
      repository: config.repository,
      autoInstall: config.autoInstall !== false,
      hasToken: Boolean(config.encryptedToken || DEFAULT_FALLBACK_TOKEN),
      packaged: Boolean(app.isPackaged)
    };
  }

  function loadConfig() {
    const loaded = readJson(configPath, {});
    return {
      repository: isValidRepository(loaded.repository) ? loaded.repository : DEFAULT_REPOSITORY,
      encryptedToken: typeof loaded.encryptedToken === 'string' ? loaded.encryptedToken : '',
      autoInstall: loaded.autoInstall !== false
    };
  }

  function saveConfig() {
    writeJsonAtomic(configPath, config);
  }

  function decryptToken() {
    if (config.encryptedToken) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        try {
          const decrypted = safeStorage.decryptString(Buffer.from(config.encryptedToken, 'base64'));
          if (decrypted) return decrypted;
        } catch (_) {}
      }
    }
    return DEFAULT_FALLBACK_TOKEN;
  }

  async function saveSettings(input) {
    const repository = String(input && input.repository || '').trim();
    if (!isValidRepository(repository)) throw new Error('Repository phải có dạng owner/name');
    const next = { ...config, repository, autoInstall: input.autoInstall !== false };
    if (input && input.clearToken === true) next.encryptedToken = '';
    const token = String(input && input.token || '').trim();
    if (token) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        throw new Error('Không thể mã hóa token bằng Windows DPAPI');
      }
      next.encryptedToken = safeStorage.encryptString(token).toString('base64');
    }
    config = next;
    saveConfig();
    updateStatus({ state: 'idle', message: 'Đã lưu cấu hình cập nhật' });
    return publicStatus();
  }

  async function checkNow({ interactive = false } = {}) {
    if (checkInFlight || applyStarted) return publicStatus();
    if (!app.isPackaged) {
      updateStatus({ state: 'disabled', message: 'Auto-update chỉ chạy trong bản đóng gói' });
      return publicStatus();
    }
    let token = '';
    try {
      token = decryptToken();
    } catch (error) {
      return failCheck(error, interactive);
    }
    if (!token) {
      updateStatus({ state: 'needs-setup', message: 'Chưa cấu hình GitHub token chỉ-đọc' });
      if (interactive) openSettingsWindow();
      return publicStatus();
    }

    checkInFlight = true;
    updateStatus({ state: 'checking', lastCheckAt: new Date().toISOString(), message: 'Đang kiểm tra GitHub Releases…' });
    try {
      const releaseUrl = `https://api.github.com/repos/${config.repository}/releases/latest`;
      const releaseBytes = await requestBuffer(releaseUrl, token, 'application/vnd.github+json', 2 * 1024 * 1024);
      const release = JSON.parse(releaseBytes.toString('utf8'));
      if (release.draft || release.prerelease) throw new Error('GitHub latest release is not a stable release');
      const remoteVersion = normalizeVersion(release.tag_name);
      if (!remoteVersion) throw new Error(`Release tag không hợp lệ: ${release.tag_name || ''}`);
      if (compareVersions(remoteVersion, app.getVersion()) <= 0) {
        pendingUpdate = null;
        updateStatus({ state: 'up-to-date', availableVersion: remoteVersion, message: `Đang dùng bản mới nhất ${app.getVersion()}` });
        if (interactive) showInfo('Auto Update', `App đang dùng phiên bản mới nhất: ${app.getVersion()}`);
        return publicStatus();
      }

      const assets = Array.isArray(release.assets) ? release.assets : [];
      const manifestAsset = findAsset(assets, MANIFEST_ASSET_NAME);
      const signatureAsset = findAsset(assets, SIGNATURE_ASSET_NAME);
      if (!manifestAsset || !signatureAsset) throw new Error('Release thiếu manifest hoặc chữ ký');
      updateStatus({ state: 'downloading', availableVersion: remoteVersion, message: `Đang tải bản ${remoteVersion}…` });

      const manifestBytes = await downloadReleaseAsset(manifestAsset, token, MAX_MANIFEST_BYTES);
      const signatureBytes = await downloadReleaseAsset(signatureAsset, token, MAX_SIGNATURE_BYTES);
      const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
      const signature = Buffer.from(signatureBytes.toString('utf8').trim(), 'base64');
      if (!crypto.verify(null, manifestBytes, publicKey, signature)) throw new Error('Chữ ký manifest không hợp lệ');
      const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')));
      if (manifest.version !== remoteVersion) throw new Error('Release tag và manifest version không khớp');
      const bundleAsset = findAsset(assets, manifest.bundle.name);
      if (!bundleAsset) throw new Error(`Release thiếu ${manifest.bundle.name}`);
      const bundleBytes = await downloadReleaseAsset(bundleAsset, token, MAX_BUNDLE_BYTES);
      if (bundleBytes.length !== manifest.bundle.size) throw new Error('Kích thước bundle không khớp manifest');
      if (sha256(bundleBytes) !== manifest.bundle.sha256) throw new Error('SHA-256 của bundle không hợp lệ');

      const stagedAppDir = stageBundle(bundleBytes, manifest);
      pendingUpdate = { version: remoteVersion, stagedAppDir, manifest };
      idleSince = 0;
      updateStatus({
        state: config.autoInstall === false ? 'ready-manual' : 'waiting-idle',
        availableVersion: remoteVersion,
        downloadedAt: new Date().toISOString(),
        message: config.autoInstall === false
          ? `Bản ${remoteVersion} đã tải xong; đang chờ cài thủ công`
          : `Bản ${remoteVersion} đã tải xong; tự động cài sau 60s rảnh`
      });
      if (config.autoInstall !== false) ensureInstallTimer();
      return publicStatus();
    } catch (error) {
      return failCheck(error, interactive);
    } finally {
      checkInFlight = false;
    }
  }

  function failCheck(error, interactive) {
    const message = friendlyError(error);
    appendLog('Update check failed', message);
    updateStatus({ state: 'error', lastError: message, message: `Kiểm tra thất bại: ${message}` });
    if (interactive) showError('Không kiểm tra được cập nhật', message);
    return publicStatus();
  }

  function stageBundle(bundleBytes, manifest) {
    const jsonBytes = zlib.gunzipSync(bundleBytes);
    if (jsonBytes.length > MAX_UNCOMPRESSED_BUNDLE_BYTES) throw new Error('Bundle giải nén vượt giới hạn an toàn');
    const bundle = JSON.parse(jsonBytes.toString('utf8'));
    if (!bundle || bundle.schemaVersion !== 1 || bundle.version !== manifest.version || !Array.isArray(bundle.files)) {
      throw new Error('Cấu trúc bundle không hợp lệ');
    }
    const coreRequired = [
      'main.js',
      'package.json',
      'updater/auto-update-manager.js',
      'updater/apply-update.js',
      'updater/release-format.js',
      'updater/update-public-key.pem'
    ];
    const received = new Set();
    const stageRoot = path.join(updateRoot, 'staged', `v${manifest.version}`);
    const appStage = path.join(stageRoot, 'app');
    safeRemoveInside(updateRoot, stageRoot);
    fs.mkdirSync(appStage, { recursive: true });

    for (const file of bundle.files) {
      const relativePath = normalizeReleasePath(file && file.path);
      if (received.has(relativePath)) throw new Error(`File bundle trùng lặp: ${relativePath}`);
      const data = Buffer.from(String(file.data || ''), 'base64');
      if (data.length !== Number(file.size) || sha256(data) !== String(file.sha256 || '')) {
        throw new Error(`File bundle bị hỏng: ${relativePath}`);
      }
      const destination = path.resolve(appStage, ...relativePath.split('/'));
      assertInside(appStage, destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, data);
      received.add(relativePath);
    }
    for (const required of coreRequired) {
      if (!received.has(required)) throw new Error(`Bundle thiếu file bắt buộc: ${required}`);
    }
    const stagedPackage = JSON.parse(fs.readFileSync(path.join(appStage, 'package.json'), 'utf8'));
    if (stagedPackage.version !== manifest.version) throw new Error('package.json trong bundle sai phiên bản');
    writeJsonAtomic(path.join(stageRoot, 'verified.json'), {
      version: manifest.version,
      verifiedAt: new Date().toISOString(),
      manifestSha256: sha256(Buffer.from(JSON.stringify(manifest), 'utf8'))
    });
    return appStage;
  }

  function ensureInstallTimer() {
    if (installTimer) return;
    installTimer = setInterval(() => attemptInstall().catch((error) => failApply(error)), INSTALL_RETRY_INTERVAL_MS);
    setTimeout(() => attemptInstall().catch((error) => failApply(error)), 1000);
  }

  async function attemptInstall({ force = false } = {}) {
    if (!pendingUpdate || applyStarted) return publicStatus();
    if (!force && config.autoInstall === false) return publicStatus();
    let busy = true;
    try { busy = await isAppBusy(); } catch (_) { busy = true; }
    if (busy) {
      idleSince = 0;
      updateStatus({ state: 'waiting-idle', message: `Bản ${pendingUpdate.version} sẵn sàng; app đang xử lý đơn` });
      return publicStatus();
    }
    if (!idleSince) idleSince = Date.now();
    const idleFor = Date.now() - idleSince;
    if (!force && idleFor < REQUIRED_IDLE_MS) {
      const remaining = Math.max(1, Math.ceil((REQUIRED_IDLE_MS - idleFor) / 1000));
      updateStatus({ state: 'waiting-idle', message: `Bản ${pendingUpdate.version} sẵn sàng; tự động cài sau ${remaining}s (bấm 'Cài bản đã tải' để cài ngay)` });
      return publicStatus();
    }
    await launchApplyHelper(pendingUpdate);
    return publicStatus();
  }

  async function launchApplyHelper(update) {
    applyStarted = true;
    const helperDir = path.join(updateRoot, 'helper');
    const helperPath = path.join(helperDir, 'apply-update.js');
    const instructionPath = path.join(helperDir, 'apply-instruction.json');
    const stagedHelper = path.join(update.stagedAppDir, 'updater', 'apply-update.js');
    const sourceHelper = fs.existsSync(stagedHelper) ? stagedHelper : path.join(appDir, 'updater', 'apply-update.js');
    fs.mkdirSync(helperDir, { recursive: true });
    fs.copyFileSync(sourceHelper, helperPath);
    fs.mkdirSync(watchdogStateDir, { recursive: true });
    fs.writeFileSync(updateLockPath, `${new Date().toISOString()} v${update.version}\n`, 'utf8');
    writeJsonAtomic(instructionPath, {
      schemaVersion: 1,
      parentPid: process.pid,
      appExe: process.execPath,
      targetAppDir: appDir,
      stagedAppDir: update.stagedAppDir,
      rollbackAppDir: path.join(path.dirname(appDir), 'app.rollback'),
      heartbeatPath,
      updateLockPath,
      logPath,
      oldVersion: app.getVersion(),
      newVersion: update.version,
      createdAt: new Date().toISOString()
    });
    updateStatus({ state: 'applying', message: `Đang cài bản ${update.version} và khởi động lại app…` });
    appendLog('Launching update helper', { from: app.getVersion(), to: update.version });
    const child = spawn(process.execPath, [helperPath, instructionPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      cwd: path.dirname(process.execPath),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    child.unref();
    setTimeout(() => requestQuitForUpdate(update.version), 500);
  }

  function failApply(error) {
    applyStarted = false;
    const message = friendlyError(error);
    appendLog('Unable to apply staged update', message);
    updateStatus({ state: 'error', lastError: message, message: `Không thể cài cập nhật: ${message}` });
    return publicStatus();
  }

  function start() {
    registerIpc();
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => checkNow().catch(() => {}), DEFAULT_CHECK_INTERVAL_MS);
    setTimeout(() => checkNow().catch(() => {}), INITIAL_CHECK_DELAY_MS);
    updateStatus({ state: app.isPackaged ? 'idle' : 'disabled', message: app.isPackaged ? 'Auto-update đã khởi động' : 'Auto-update tắt trong môi trường development' });
  }

  function registerIpc() {
    ipcMain.removeHandler('thaiasia-updater:get-settings');
    ipcMain.removeHandler('thaiasia-updater:save-settings');
    ipcMain.removeHandler('thaiasia-updater:check-now');
    ipcMain.removeHandler('thaiasia-updater:install-now');
    ipcMain.handle('thaiasia-updater:get-settings', () => publicStatus());
    ipcMain.handle('thaiasia-updater:save-settings', (_, input) => saveSettings(input));
    ipcMain.handle('thaiasia-updater:check-now', () => checkNow({ interactive: false }));
    ipcMain.handle('thaiasia-updater:install-now', () => attemptInstall({ force: true }));
  }

  function openSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = new BrowserWindow({
      width: 620,
      height: 650,
      minWidth: 560,
      minHeight: 560,
      show: false,
      autoHideMenuBar: true,
      title: 'ThaiAsia Auto Update',
      icon: path.join(appDir, 'icon.ico'),
      webPreferences: {
        preload: path.join(appDir, 'updater', 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    settingsWindow.loadFile(path.join(appDir, 'updater', 'settings.html'));
    settingsWindow.once('ready-to-show', () => settingsWindow && settingsWindow.show());
    settingsWindow.on('closed', () => { settingsWindow = null; });
  }

  function showInfo(title, message) {
    if (dialog) dialog.showMessageBox({ type: 'info', title, message }).catch(() => {});
  }

  function showError(title, message) {
    if (dialog) dialog.showMessageBox({ type: 'error', title, message }).catch(() => {});
  }

  return {
    start,
    checkNow,
    attemptInstall,
    openSettingsWindow,
    getStatus: publicStatus,
    decryptToken,
    getRepository: () => config.repository || 'x247hl/thaiasia-releases'
  };
}

function isValidRepository(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(value || '').trim());
}

function findAsset(assets, name) {
  return assets.find((asset) => asset && asset.name === name && asset.url);
}

function downloadReleaseAsset(asset, token, maxBytes) {
  return requestBuffer(asset.url, token, 'application/octet-stream', maxBytes);
}

function requestBuffer(rawUrl, token, accept, maxBytes, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('GitHub chuyển hướng quá nhiều lần'));
  const url = new URL(rawUrl);
  const headers = {
    Accept: accept,
    'User-Agent': 'ThaiAsia-Win7-AutoUpdater/1',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token && url.hostname.toLowerCase() === 'api.github.com') headers.Authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: 60000 }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).toString();
        requestBuffer(next, token, accept, maxBytes, redirects + 1).then(resolve, reject);
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy(new Error(`Download vượt giới hạn ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`GitHub HTTP ${statusCode}: ${body.toString('utf8', 0, 300)}`));
          return;
        }
        resolve(body);
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('GitHub request timeout')));
    request.on('error', reject);
  });
}

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    // Windows cannot atomically replace an existing destination with rename.
    // Keep a recoverable previous copy, then promote the complete temp file.
    const backupPath = `${filePath}.bak`;
    try { fs.rmSync(backupPath, { force: true }); } catch (_) {}
    if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath);
    fs.renameSync(tempPath, filePath);
  }
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function friendlyError(error) {
  const text = String(error && error.message || error || 'Unknown error');
  return text.replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [hidden]').slice(0, 800);
}

function assertInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error(`Path escapes update directory: ${target}`);
}

function safeRemoveInside(baseDir, targetPath) {
  assertInside(baseDir, targetPath);
  if (path.resolve(baseDir) === path.resolve(targetPath)) throw new Error('Refusing to remove update root');
  fs.rmSync(targetPath, { recursive: true, force: true });
}

const MIN_REPORT_SYNC_INTERVAL_MS = 60 * 1000;
const MIN_HEARTBEAT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
// setInterval is anchored before the previous GitHub PUT completes, so its next
// tick can arrive a few milliseconds before five minutes have elapsed according
// to lastHeartbeatSyncAt. Allow a small boundary tolerance; the scheduler still
// initiates heartbeat uploads only once every five minutes.
const HEARTBEAT_THROTTLE_TOLERANCE_MS = 15 * 1000;
const GITHUB_MUTATION_PAUSE_MS = 1000;
const machineHost = (os.hostname() || 'Win7').replace(/[^a-zA-Z0-9_-]/g, '_');
const REPORT_TXT_PATH = `reports/ThaiAsia-24h-report-${machineHost}.txt`;
const REPORT_BUNDLE_PATH = `reports/ThaiAsia-24h-report-bundle-${machineHost}.txt`;
const REPORT_BRANCH = 'reports';

function normalizeReportContentForHash(text) {
  return String(text || '')
    .replace(/^(Thời gian xuất|Generated|Window start|Window end|Máy tính|Khoảng thời gian):.*$/gm, '')
    .replace(/^\s*"(?:generatedAt|windowStart|windowEnd|windowHours)"\s*:\s*.*$/gm, '')
    .trim();
}

function getRateLimitDelayMs(response, nowMs = Date.now()) {
  const statusCode = Number(response && response.statusCode || 0);
  if (statusCode !== 403 && statusCode !== 429) return 0;
  const headers = response && response.headers && typeof response.headers === 'object'
    ? response.headers
    : {};
  const message = String(response && response.data && response.data.message || response && response.data || '').toLowerCase();
  const remaining = Number(headers['x-ratelimit-remaining']);
  const retryAfterSeconds = Number(headers['retry-after']);
  const resetSeconds = Number(headers['x-ratelimit-reset']);
  const isRateLimit = statusCode === 429 ||
    Number.isFinite(retryAfterSeconds) ||
    remaining === 0 ||
    message.includes('rate limit') ||
    message.includes('secondary limit') ||
    message.includes('abuse');
  if (!isRateLimit) return 0;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.max(60 * 1000, Math.ceil(retryAfterSeconds * 1000));
  }
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
    return Math.max(60 * 1000, (resetSeconds * 1000) - Number(nowMs) + 5000);
  }
  return 60 * 1000;
}

function rateLimitError(response, nowMs = Date.now()) {
  const waitMs = getRateLimitDelayMs(response, nowMs);
  if (!waitMs) return null;
  const error = new Error(`GitHub rate limit reached; retry after ${Math.ceil(waitMs / 1000)}s`);
  error.rateLimitWaitMs = waitMs;
  error.githubResponse = response;
  return error;
}

function createReportSync(options = {}) {
  const {
    getToken = () => '',
    getRepository = () => 'x247hl/thaiasia-releases',
    machineName = '',
    log = () => {},
    useFallbackToken = true,
    githubRequest = githubApiRequest
  } = options;

  let lastSyncAt = 0;
  let lastTxtSha256 = '';
  let lastBundleSha256 = '';
  let syncInFlight = false;
  let heartbeatSyncInFlight = false;
  let branchVerified = false;
  let rateLimitedUntil = 0;
  let lastHeartbeatSyncAt = 0;
  const remoteFileShas = new Map();

  async function syncReportsAsync(reportData = {}, { force = false } = {}) {
    const { humanText = '', bundleText = '' } = reportData;
    if (!humanText && !bundleText) return { skipped: true, reason: 'empty_content' };

    const now = Date.now();
    // Ignore presentation timestamps but retain version/update metadata and all
    // operational events. Regenerating an unchanged report must not create a commit.
    const currentTxtHash = sha256(Buffer.from(normalizeReportContentForHash(humanText), 'utf8'));
    const currentBundleHash = sha256(Buffer.from(normalizeReportContentForHash(bundleText), 'utf8'));

    const txtUnchanged = !humanText || currentTxtHash === lastTxtSha256;
    const bundleUnchanged = !bundleText || currentBundleHash === lastBundleSha256;
    if (!force && txtUnchanged && bundleUnchanged) {
      return { skipped: true, reason: 'content_unchanged' };
    }

    if (!force && now - lastSyncAt < MIN_REPORT_SYNC_INTERVAL_MS) {
      return { skipped: true, reason: 'throttled', waitMs: MIN_REPORT_SYNC_INTERVAL_MS - (now - lastSyncAt) };
    }

    if (!force && now < rateLimitedUntil) {
      return { skipped: true, reason: 'rate_limited', waitMs: rateLimitedUntil - now };
    }

    if (syncInFlight || heartbeatSyncInFlight) {
      return { skipped: true, reason: 'in_flight' };
    }

    let token = '';
    try {
      token = typeof getToken === 'function' ? (getToken() || '') : '';
    } catch (_) {
      token = '';
    }
    if (!token && useFallbackToken) token = DEFAULT_FALLBACK_TOKEN;
    if (!token) return { skipped: true, reason: 'no_token' };

    let repo = 'x247hl/thaiasia-releases';
    try {
      repo = typeof getRepository === 'function' ? (getRepository() || repo) : repo;
    } catch (_) {}
    if (!repo || !repo.includes('/')) repo = 'x247hl/thaiasia-releases';

    const mHost = (machineName || os.hostname() || 'Win7').replace(/[^a-zA-Z0-9_-]/g, '_');
    const txtPath = `reports/ThaiAsia-24h-report-${mHost}.txt`;
    const bundlePath = `reports/ThaiAsia-24h-report-bundle-${mHost}.txt`;

    syncInFlight = true;
    try {
      log(`[ReportSync] Starting 24h report sync to GitHub (${txtPath})...`);
      await ensureBranchExists(repo, token, REPORT_BRANCH);
      const shouldUploadTxt = !!humanText && (force || currentTxtHash !== lastTxtSha256);
      const shouldUploadBundle = !!bundleText && (force || currentBundleHash !== lastBundleSha256);

      if (shouldUploadTxt) {
        await uploadFileToGitHub(repo, token, txtPath, REPORT_BRANCH, humanText, 'Update live 24h report summary');
        lastTxtSha256 = currentTxtHash;
      }

      if (shouldUploadBundle) {
        if (shouldUploadTxt) {
          await new Promise((resolve) => setTimeout(resolve, GITHUB_MUTATION_PAUSE_MS));
        }
        await uploadFileToGitHub(repo, token, bundlePath, REPORT_BRANCH, bundleText, 'Update live 24h report bundle');
        lastBundleSha256 = currentBundleHash;
      }

      lastSyncAt = Date.now();
      log(`[ReportSync] 24h reports synced successfully to GitHub: ${txtPath}`);
      return { success: true, syncedAt: new Date(lastSyncAt).toISOString() };
    } catch (error) {
      if (Number(error && error.rateLimitWaitMs) > 0) {
        rateLimitedUntil = Date.now() + Number(error.rateLimitWaitMs);
      }
      const errMsg = friendlyError(error);
      log('[ReportSync] Report sync failed (non-fatal):', errMsg);
      return { success: false, error: errMsg };
    } finally {
      syncInFlight = false;
    }
  }

  async function ensureBranchExists(repo, token, branch) {
    if (branchVerified) return;
    const branchUrl = `https://api.github.com/repos/${repo}/branches/${branch}`;
    const branchCheck = await githubRequest(branchUrl, 'GET', token, null);
    const branchLimited = rateLimitError(branchCheck);
    if (branchLimited) throw branchLimited;
    if (branchCheck.statusCode === 200) {
      branchVerified = true;
      return;
    }

    const repoInfo = await githubRequest(`https://api.github.com/repos/${repo}`, 'GET', token, null);
    const repoLimited = rateLimitError(repoInfo);
    if (repoLimited) throw repoLimited;
    if (repoInfo.statusCode !== 200) {
      throw new Error(`Cannot get repository info: HTTP ${repoInfo.statusCode}`);
    }
    const defaultBranch = repoInfo.data && repoInfo.data.default_branch ? repoInfo.data.default_branch : 'main';
    const refInfo = await githubRequest(`https://api.github.com/repos/${repo}/git/ref/heads/${defaultBranch}`, 'GET', token, null);
    const refLimited = rateLimitError(refInfo);
    if (refLimited) throw refLimited;
    if (refInfo.statusCode !== 200 || !refInfo.data || !refInfo.data.object || !refInfo.data.object.sha) {
      throw new Error(`Cannot get default branch ref for ${defaultBranch}`);
    }
    const baseSha = refInfo.data.object.sha;

    const createBranch = await githubRequest(`https://api.github.com/repos/${repo}/git/refs`, 'POST', token, {
      ref: `refs/heads/${branch}`,
      sha: baseSha
    });
    const createLimited = rateLimitError(createBranch);
    if (createLimited) throw createLimited;
    if (createBranch.statusCode === 201 || createBranch.statusCode === 200 || createBranch.statusCode === 422) {
      branchVerified = true;
    } else {
      throw new Error(`Failed to create branch ${branch}: HTTP ${createBranch.statusCode}`);
    }
  }

  async function syncHeartbeatAsync(heartbeatData = {}, { force = false } = {}) {
    const machine = (machineName || os.hostname() || 'Win7').replace(/[^a-zA-Z0-9_-]/g, '_');
    const now = Date.now();
    if (!force && now - lastHeartbeatSyncAt < MIN_HEARTBEAT_SYNC_INTERVAL_MS - HEARTBEAT_THROTTLE_TOLERANCE_MS) {
      return {
        skipped: true,
        reason: 'throttled',
        waitMs: Math.max(0, MIN_HEARTBEAT_SYNC_INTERVAL_MS - (now - lastHeartbeatSyncAt))
      };
    }
    if (now < rateLimitedUntil) {
      return { skipped: true, reason: 'rate_limited', waitMs: rateLimitedUntil - now };
    }
    if (syncInFlight || heartbeatSyncInFlight) {
      return { skipped: true, reason: 'in_flight' };
    }

    let token = '';
    try { token = typeof getToken === 'function' ? (getToken() || '') : ''; } catch (_) {}
    if (!token && useFallbackToken) token = DEFAULT_FALLBACK_TOKEN;
    if (!token) return { skipped: true, reason: 'no_token' };

    let repo = 'x247hl/thaiasia-releases';
    try { repo = typeof getRepository === 'function' ? (getRepository() || repo) : repo; } catch (_) {}
    if (!repo || !repo.includes('/')) repo = 'x247hl/thaiasia-releases';

    const heartbeatPath = `status/heartbeat-${machine}.json`;
    const payload = {
      schemaVersion: 1,
      machine,
      ...heartbeatData,
      lastSeenAt: heartbeatData && heartbeatData.lastSeenAt
        ? heartbeatData.lastSeenAt
        : new Date(now).toISOString()
    };

    heartbeatSyncInFlight = true;
    try {
      await ensureBranchExists(repo, token, REPORT_BRANCH);
      await uploadFileToGitHub(
        repo,
        token,
        heartbeatPath,
        REPORT_BRANCH,
        `${JSON.stringify(payload, null, 2)}\n`,
        `Update heartbeat for ${machine}`
      );
      lastHeartbeatSyncAt = Date.now();
      log(`[Heartbeat] Synced machine status to GitHub: ${heartbeatPath}`);
      return { success: true, syncedAt: new Date(lastHeartbeatSyncAt).toISOString(), path: heartbeatPath };
    } catch (error) {
      if (Number(error && error.rateLimitWaitMs) > 0) {
        rateLimitedUntil = Date.now() + Number(error.rateLimitWaitMs);
      }
      const errMsg = friendlyError(error);
      log('[Heartbeat] GitHub sync failed (non-fatal):', errMsg);
      return { success: false, error: errMsg };
    } finally {
      heartbeatSyncInFlight = false;
    }
  }

  async function uploadFileToGitHub(repo, token, filePath, branch, contentString, commitMessage) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let existingSha = remoteFileShas.get(filePath);
      if (!existingSha) {
        const getUrl = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${branch}`;
        const existing = await githubRequest(getUrl, 'GET', token, null);
        const limited = rateLimitError(existing);
        if (limited) throw limited;
        if (existing.statusCode === 200 && existing.data && existing.data.sha) {
          existingSha = existing.data.sha;
          remoteFileShas.set(filePath, existingSha);
        }
      }

      const putUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
      const payload = {
        message: `${commitMessage} [skip ci]`,
        content: Buffer.from(contentString, 'utf8').toString('base64'),
        branch
      };
      if (existingSha) payload.sha = existingSha;

      const res = await githubRequest(putUrl, 'PUT', token, payload);
      const limited = rateLimitError(res);
      if (limited) throw limited;
      if (res.statusCode === 200 || res.statusCode === 201) {
        const nextSha = res.data && res.data.content && res.data.content.sha;
        if (nextSha) remoteFileShas.set(filePath, nextSha);
        return res.data;
      }
      if (res.statusCode === 409 && attempt < maxAttempts) {
        remoteFileShas.delete(filePath);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw new Error(`GitHub PUT ${filePath} returned HTTP ${res.statusCode}: ${JSON.stringify(res.data)}`);
    }
  }

  return {
    syncReportsAsync,
    syncHeartbeatAsync,
    sha256: (s) => sha256(Buffer.from(String(s || ''), 'utf8'))
  };
}

function githubApiRequest(urlStr, method, token, bodyData, requestOptions = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const postBytes = bodyData ? Buffer.from(JSON.stringify(bodyData), 'utf8') : null;
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ThaiAsia-Win7-ReportSync/1',
      'X-GitHub-Api-Version': '2022-11-28',
      ...((requestOptions && requestOptions.headers) || {})
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (postBytes) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = postBytes.length;
    }

    const req = https.request(url, { method, headers, timeout: 25000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { data = raw; }
        // A locally configured read-only token can read releases/commands but GitHub
        // returns 403 when report/ack files are written.  Older installations were
        // explicitly told to use a read-only token, so retry writes with the bundled
        // control token as well as retrying an expired token (401).
        const response = { statusCode: res.statusCode, headers: res.headers, data };
        const shouldRetryWithFallback = token && token !== DEFAULT_FALLBACK_TOKEN && !getRateLimitDelayMs(response) && (
          res.statusCode === 401 || (method !== 'GET' && res.statusCode === 403)
        );
        if (shouldRetryWithFallback) {
          githubApiRequest(urlStr, method, DEFAULT_FALLBACK_TOKEN, bodyData, requestOptions).then(resolve, reject);
          return;
        }
        resolve(response);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub request timeout')));
    req.on('error', reject);
    if (postBytes) req.write(postBytes);
    req.end();
  });
}

function createRemoteCommandReceiver(options = {}) {
  const {
    getToken = () => '',
    getRepository = () => 'x247hl/thaiasia-releases',
    machineName = (os.hostname() || 'Win7').replace(/[^a-zA-Z0-9_-]/g, '_'),
    stateDir = '',
    handlers = {},
    log = () => {},
    checkIntervalMs = 30 * 1000,
    githubRequest = githubApiRequest,
    reportBranch = REPORT_BRANCH
  } = options;

  const lastCommandPath = stateDir ? path.join(stateDir, 'last-command.json') : '';
  const commandCachePath = stateDir ? path.join(stateDir, 'remote-command-cache.json') : '';
  const safeMachineName = String(machineName || os.hostname() || 'Win7').replace(/[^a-zA-Z0-9_-]/g, '_');
  let localCommandState = null;
  let commandCache = { directoryEtag: '', completedShas: {} };
  try {
    if (lastCommandPath && fs.existsSync(lastCommandPath)) {
      const data = JSON.parse(fs.readFileSync(lastCommandPath, 'utf8'));
      if (data && (data.commandId || data.lastCommandId)) {
        localCommandState = {
          commandId: String(data.commandId || data.lastCommandId),
          ackPayload: data.ackPayload && typeof data.ackPayload === 'object' ? data.ackPayload : null,
          commandPath: String(data.commandPath || ''),
          commandSha: String(data.commandSha || '')
        };
      }
    }
  } catch (_) {}
  try {
    if (commandCachePath && fs.existsSync(commandCachePath)) {
      const data = JSON.parse(fs.readFileSync(commandCachePath, 'utf8'));
      commandCache = {
        directoryEtag: String(data && data.directoryEtag || ''),
        completedShas: data && data.completedShas && typeof data.completedShas === 'object'
          ? data.completedShas
          : {}
      };
    }
  } catch (_) {}

  let timer = null;
  let inFlight = false;
  let startedAt = null;
  let lastPollAt = null;
  let lastHttpStatus = null;
  let lastError = '';
  let lastReceivedCommandId = '';
  let rateLimitedUntil = 0;

  function saveCommandCache() {
    if (!commandCachePath) return;
    try {
      fs.mkdirSync(path.dirname(commandCachePath), { recursive: true });
      fs.writeFileSync(commandCachePath, JSON.stringify(commandCache, null, 2), 'utf8');
    } catch (err) {
      log('[RemoteControl] Failed to save command cache:', friendlyError(err));
    }
  }

  function markCommandCompleted(commandPath, commandSha) {
    if (!commandPath || !commandSha) return;
    commandCache.completedShas[commandPath] = commandSha;
    saveCommandCache();
  }

  function throwIfRateLimited(response) {
    const error = rateLimitError(response);
    if (error) throw error;
  }

  function saveLocalState(nextState) {
    localCommandState = nextState;
    if (!lastCommandPath) return;
    try {
      fs.mkdirSync(path.dirname(lastCommandPath), { recursive: true });
      if (nextState) {
        fs.writeFileSync(lastCommandPath, JSON.stringify({
          commandId: nextState.commandId,
          ackPayload: nextState.ackPayload || null,
          commandPath: nextState.commandPath || '',
          commandSha: nextState.commandSha || '',
          updatedAt: new Date().toISOString()
        }, null, 2), 'utf8');
      } else if (fs.existsSync(lastCommandPath)) {
        fs.unlinkSync(lastCommandPath);
      }
    } catch (err) {
      log('[RemoteControl] Failed to save local command state:', friendlyError(err));
    }
  }

  function apiUrl(repo, filePath) {
    return `https://api.github.com/repos/${repo}/contents/${filePath}`;
  }

  function responseSummary(res) {
    const message = res && res.data && typeof res.data === 'object' ? res.data.message : '';
    return `HTTP ${res && res.statusCode || 0}${message ? ` (${message})` : ''}`;
  }

  async function getGitHubFile(repo, token, filePath, requestOptions) {
    const response = await githubRequest(
      `${apiUrl(repo, filePath)}?ref=${encodeURIComponent(reportBranch)}`,
      'GET',
      token,
      null,
      requestOptions
    );
    throwIfRateLimited(response);
    return response;
  }

  async function putGitHubJson(repo, token, filePath, value, message, existingSha) {
    const payload = {
      message,
      content: Buffer.from(JSON.stringify(value, null, 2), 'utf8').toString('base64'),
      branch: reportBranch
    };
    if (existingSha) payload.sha = existingSha;
    const res = await githubRequest(apiUrl(repo, filePath), 'PUT', token, payload);
    throwIfRateLimited(res);
    if (res.statusCode !== 200 && res.statusCode !== 201) {
      throw new Error(`GitHub PUT ${filePath} failed: ${responseSummary(res)}`);
    }
    return res;
  }

  async function uploadAck(repo, token, ackPayload) {
    const ackPath = `commands/ack-${safeMachineName}.json`;
    let existingAck = await getGitHubFile(repo, token, ackPath);
    if (existingAck.statusCode !== 200 && existingAck.statusCode !== 404) {
      throw new Error(`GitHub GET ${ackPath} failed: ${responseSummary(existingAck)}`);
    }
    let ackSha = existingAck.statusCode === 200 && existingAck.data ? existingAck.data.sha : undefined;
    try {
      await putGitHubJson(repo, token, ackPath, ackPayload,
        `Ack command ${ackPayload.commandId} on ${safeMachineName} [skip ci]`, ackSha);
    } catch (firstError) {
      // Another writer may have updated this machine's ack between GET and PUT.
      // Refresh the SHA once so a harmless 409 race does not lose the response.
      existingAck = await getGitHubFile(repo, token, ackPath);
      ackSha = existingAck.statusCode === 200 && existingAck.data ? existingAck.data.sha : undefined;
      await putGitHubJson(repo, token, ackPath, ackPayload,
        `Ack command ${ackPayload.commandId} on ${safeMachineName} [skip ci]`, ackSha);
      log('[RemoteControl] Ack upload succeeded after refreshing SHA:', firstError.message);
    }
    log(`[RemoteControl] Ack uploaded to GitHub: ${ackPath}`);
  }

  async function uploadDoneMarker(repo, token, commandId, action, targetPart) {
    const doneMarkerPath = `commands/done-${commandId}-${safeMachineName}.json`;
    await putGitHubJson(repo, token, doneMarkerPath, {
      commandId,
      action,
      machineName: safeMachineName,
      target: targetPart,
      executedAt: new Date().toISOString()
    }, `Mark command ${commandId} done on ${safeMachineName} [skip ci]`);
    log(`[RemoteControl] Done marker uploaded to GitHub: ${doneMarkerPath}`);
  }

  async function publishCompletion(repo, token, ackPayload, targetPart) {
    // Ack must exist before done.  A done marker is the permanent instruction to
    // skip a command; writing it first used to lose responses forever on failure.
    await uploadAck(repo, token, ackPayload);
    await new Promise((resolve) => setTimeout(resolve, GITHUB_MUTATION_PAUSE_MS));
    await uploadDoneMarker(repo, token, ackPayload.commandId, ackPayload.action, targetPart);
    saveLocalState(null);
  }

  async function checkCommandsAsync() {
    if (inFlight) {
      log('[RemoteControl] checkCommands skipped: inFlight=true');
      return;
    }
    if (Date.now() < rateLimitedUntil) {
      lastError = `GitHub rate limit backoff until ${new Date(rateLimitedUntil).toISOString()}`;
      return;
    }
    let token = '';
    try { token = typeof getToken === 'function' ? getToken() : ''; } catch (e) { log('[RemoteControl] getToken() error:', e && e.message); token = ''; }
    if (!token) {
      token = DEFAULT_FALLBACK_TOKEN;
      log('[RemoteControl] getToken() returned empty, using fallback token');
    }
    let repo = 'x247hl/thaiasia-releases';
    try { repo = typeof getRepository === 'function' ? (getRepository() || repo) : repo; } catch (e) { log('[RemoteControl] getRepository() error:', e && e.message); }
    if (!repo || !repo.includes('/')) {
      repo = 'x247hl/thaiasia-releases';
      log('[RemoteControl] Invalid repo, using default');
    }

    inFlight = true;
    try {
      lastPollAt = new Date().toISOString();
      log(`[RemoteControl] Polling commands... machine=${safeMachineName} repo=${repo}`);
      const conditionalHeaders = commandCache.directoryEtag && !localCommandState
        ? { 'If-None-Match': commandCache.directoryEtag }
        : {};
      const dirRes = await githubRequest(
        `https://api.github.com/repos/${repo}/contents/commands?ref=${encodeURIComponent(reportBranch)}`,
        'GET',
        token,
        null,
        { headers: conditionalHeaders }
      );
      throwIfRateLimited(dirRes);
      lastHttpStatus = Number(dirRes.statusCode || 0);
      const nextDirectoryEtag = String(dirRes.headers && dirRes.headers.etag || '');
      if (nextDirectoryEtag && nextDirectoryEtag !== commandCache.directoryEtag) {
        commandCache.directoryEtag = nextDirectoryEtag;
        saveCommandCache();
      }
      if (dirRes.statusCode === 304) {
        lastError = '';
        return;
      }
      log(`[RemoteControl] GitHub /commands response: status=${dirRes.statusCode} isArray=${Array.isArray(dirRes.data)} count=${Array.isArray(dirRes.data) ? dirRes.data.length : 0}`);
      if (dirRes.statusCode !== 200 || !Array.isArray(dirRes.data)) {
        lastError = `Cannot list commands: ${responseSummary(dirRes)}`;
        log(`[RemoteControl] Cannot list commands: ${responseSummary(dirRes)}`);
      } else {
        lastError = '';
        const myNameLower = safeMachineName.toLowerCase();
        for (const item of dirRes.data) {
          const itemNameLower = String(item && item.name || '').toLowerCase();
          if (!item || !item.name || !itemNameLower.startsWith('command-') || !itemNameLower.endsWith('.json')) continue;
          const targetPart = item.name.slice('command-'.length, -'.json'.length);
          if (targetPart.toLowerCase() !== 'all' && targetPart.toLowerCase() !== myNameLower) continue;

          const cmdPath = item.path;
          const listedCommandSha = String(item.sha || '');
          if (listedCommandSha && commandCache.completedShas[cmdPath] === listedCommandSha) continue;
          const res = await getGitHubFile(repo, token, cmdPath);
          if (res.statusCode === 200 && res.data && res.data.content) {
            const raw = Buffer.from(res.data.content, 'base64').toString('utf8');
            let cmd = null;
            try { cmd = JSON.parse(raw); } catch (err) {
              log(`[RemoteControl] Invalid command JSON in ${cmdPath}:`, friendlyError(err));
            }
            if (cmd && cmd.id) {
              const commandId = String(cmd.id);
              const action = String(cmd.action || '');
              const params = cmd.params || {};
              const commandSha = String(res.data.sha || listedCommandSha || '');

              const doneMarkerPath = `commands/done-${commandId}-${safeMachineName}.json`;
              const doneCheck = await getGitHubFile(repo, token, doneMarkerPath);
              if (doneCheck.statusCode === 200) {
                if (localCommandState && localCommandState.commandId === commandId) saveLocalState(null);
                markCommandCompleted(cmdPath, commandSha);
                log(`[RemoteControl] Command already completed: id=${commandId}`);
                continue;
              }
              if (doneCheck.statusCode !== 404) {
                log(`[RemoteControl] Cannot check done marker ${doneMarkerPath}: ${responseSummary(doneCheck)}`);
                continue;
              }

              // If execution succeeded locally but publishing failed, retry only
              // Ack/done and never execute the action a second time.
              if (localCommandState && localCommandState.commandId === commandId && localCommandState.ackPayload) {
                log(`[RemoteControl] Retrying pending Ack/Done for command id=${commandId}`);
                try {
                  await publishCompletion(repo, token, localCommandState.ackPayload, targetPart);
                  markCommandCompleted(cmdPath, commandSha);
                } catch (publishErr) {
                  log('[RemoteControl] Pending Ack/Done upload failed:', friendlyError(publishErr));
                }
                continue;
              }

              // Recover state written by v1.2.7. That version stored only the id
              // before execution. Do not replay a potentially destructive action.
              if (localCommandState && localCommandState.commandId === commandId && !localCommandState.ackPayload) {
                const recoveredAck = {
                  commandId,
                  action,
                  target: targetPart,
                  machineName: safeMachineName,
                  executedAt: new Date().toISOString(),
                  ok: false,
                  result: null,
                  error: 'Recovered legacy local state; action was not replayed to avoid duplicate execution'
                };
                saveLocalState({ commandId, ackPayload: recoveredAck, commandPath: cmdPath, commandSha });
                try {
                  await publishCompletion(repo, token, recoveredAck, targetPart);
                  markCommandCompleted(cmdPath, commandSha);
                } catch (publishErr) {
                  log('[RemoteControl] Legacy state recovery upload failed:', friendlyError(publishErr));
                }
                continue;
              }

              log(`[RemoteControl] Received active command id=${commandId} action=${action} target=${targetPart}`);
              lastReceivedCommandId = commandId;

              let execOk = true;
              let execResult = null;
              let execError = null;

              if (typeof handlers[action] === 'function') {
                try {
                  execResult = await Promise.resolve(handlers[action](params));
                } catch (err) {
                  execOk = false;
                  execError = friendlyError(err);
                  log(`[RemoteControl] Error executing action ${action}:`, execError);
                }
              } else {
                execOk = false;
                execError = `No handler for action '${action}'`;
                log(`[RemoteControl] Unknown action '${action}'`);
              }

              const ackPayload = {
                commandId,
                action,
                target: targetPart,
                machineName: safeMachineName,
                executedAt: new Date().toISOString(),
                ok: execOk,
                result: execResult,
                error: execError
              };
              // Persist the full result before network writes. If GitHub is down,
              // the next polling cycle publishes this response without re-running.
              saveLocalState({ commandId, ackPayload, commandPath: cmdPath, commandSha });
              try {
                await publishCompletion(repo, token, ackPayload, targetPart);
                markCommandCompleted(cmdPath, commandSha);
              } catch (publishErr) {
                log('[RemoteControl] Failed to publish Ack/Done; will retry without re-executing:', friendlyError(publishErr));
                continue;
              }

              // A machine-specific command can be removed only after Ack and Done
              // have both been committed. A 409 means a newer command replaced it.
              if (targetPart.toLowerCase() === myNameLower) {
                try {
                  const deleteRes = await githubRequest(apiUrl(repo, cmdPath), 'DELETE', token, {
                    message: `Consume command ${commandId} on ${safeMachineName} [skip ci]`,
                    sha: res.data.sha,
                    branch: reportBranch
                  });
                  if (deleteRes.statusCode !== 200) {
                    log(`[RemoteControl] Command cleanup skipped: ${responseSummary(deleteRes)}`);
                  }
                } catch (deleteErr) {
                  log('[RemoteControl] Command cleanup failed (completion is already recorded):', friendlyError(deleteErr));
                }
              }
            }
          } else {
            log(`[RemoteControl] Cannot read ${cmdPath}: ${responseSummary(res)}`);
          }
        }
      }
    } catch (err) {
      if (Number(err && err.rateLimitWaitMs) > 0) {
        rateLimitedUntil = Date.now() + Number(err.rateLimitWaitMs);
      }
      lastError = friendlyError(err);
      log('[RemoteControl] Command check error (non-fatal):', friendlyError(err));
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    startedAt = new Date().toISOString();
    log(`[RemoteControl] Starting command receiver: machine=${safeMachineName} interval=${checkIntervalMs}ms`);
    timer = setInterval(() => {
      checkCommandsAsync().catch(err => {
        log('[RemoteControl] Unhandled error in checkCommandsAsync:', err && err.message || err);
        inFlight = false;
      });
    }, checkIntervalMs);
    setTimeout(() => {
      checkCommandsAsync().catch(err => {
        log('[RemoteControl] Unhandled error in initial checkCommandsAsync:', err && err.message || err);
        inFlight = false;
      });
    }, 0);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start,
    stop,
    checkNow: checkCommandsAsync,
    getStatus: () => ({
      machineName: safeMachineName,
      running: Boolean(timer),
      startedAt,
      lastPollAt,
      lastHttpStatus,
      lastError,
      lastReceivedCommandId,
      rateLimitedUntil: rateLimitedUntil > Date.now() ? new Date(rateLimitedUntil).toISOString() : null
    })
  };
}

module.exports = {
  createAutoUpdateManager,
  createReportSync,
  createRemoteCommandReceiver,
  isValidRepository,
  normalizeReportContentForHash,
  getRateLimitDelayMs,
  requestBuffer
};
