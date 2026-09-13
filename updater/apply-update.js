'use strict';

// This helper is copied to userData and launched with ELECTRON_RUN_AS_NODE=1.
// It only runs after the Electron app has staged and cryptographically verified
// a complete resources/app payload.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PARENT_EXIT_TIMEOUT_MS = 90 * 1000;
const NEW_APP_HEALTH_TIMEOUT_MS = 120 * 1000;
const POLL_MS = 1000;

const instructionPath = process.argv[2];
let instruction = null;

if (require.main === module) {
  main().catch((error) => {
    appendLog('FATAL update helper error', error && error.stack || error);
    try { if (instruction && instruction.updateLockPath) fs.rmSync(instruction.updateLockPath, { force: true }); } catch (_) {}
    process.exitCode = 1;
  });
}

async function main() {
  if (!instructionPath || !fs.existsSync(instructionPath)) throw new Error('Missing update instruction file');
  instruction = JSON.parse(fs.readFileSync(instructionPath, 'utf8'));
  validateInstruction(instruction);
  appendLog('Update helper started', { from: instruction.oldVersion, to: instruction.newVersion, parentPid: instruction.parentPid });

  const parentExited = await waitForProcessExit(instruction.parentPid, PARENT_EXIT_TIMEOUT_MS);
  if (!parentExited) throw new Error(`App PID ${instruction.parentPid} did not exit before timeout`);

  let movedCurrentToRollback = false;
  let launchedPid = 0;
  try {
    if (fs.existsSync(instruction.rollbackAppDir)) safeRemoveAppDirectory(instruction.rollbackAppDir);
    fs.renameSync(instruction.targetAppDir, instruction.rollbackAppDir);
    movedCurrentToRollback = true;
    copyDirectory(instruction.stagedAppDir, instruction.targetAppDir);
    verifyInstalledPayload(instruction.targetAppDir, instruction.newVersion);
    try { fs.rmSync(instruction.heartbeatPath, { force: true }); } catch (_) {}
    launchedPid = launchApp(instruction.appExe);
    appendLog('New version launched', { version: instruction.newVersion, pid: launchedPid });
    const healthy = await waitForHealthyHeartbeat(instruction.heartbeatPath, instruction.newVersion, launchedPid, NEW_APP_HEALTH_TIMEOUT_MS);
    if (!healthy) throw new Error(`New version ${instruction.newVersion} did not become healthy`);
    appendLog('Update completed; rollback copy retained', { version: instruction.newVersion, rollback: instruction.rollbackAppDir });
    safeRemoveStagedDirectory(instruction.stagedAppDir);
  } catch (error) {
    appendLog('Update failed; starting rollback', error && error.stack || error);
    if (launchedPid) terminateProcess(launchedPid);
    if (fs.existsSync(instruction.targetAppDir)) safeRemoveAppDirectory(instruction.targetAppDir);
    if (movedCurrentToRollback && fs.existsSync(instruction.rollbackAppDir)) {
      fs.renameSync(instruction.rollbackAppDir, instruction.targetAppDir);
      verifyInstalledPayload(instruction.targetAppDir, instruction.oldVersion);
      const rollbackPid = launchApp(instruction.appExe);
      appendLog('Rollback version launched', { version: instruction.oldVersion, pid: rollbackPid });
    }
    throw error;
  } finally {
    try { fs.rmSync(instruction.updateLockPath, { force: true }); } catch (_) {}
    try { fs.rmSync(instructionPath, { force: true }); } catch (_) {}
  }
}

function validateInstruction(value) {
  if (!value || value.schemaVersion !== 1) throw new Error('Invalid update instruction schema');
  if (!Number.isSafeInteger(value.parentPid) || value.parentPid <= 0) throw new Error('Invalid parent PID');
  for (const key of ['appExe', 'targetAppDir', 'stagedAppDir', 'rollbackAppDir', 'heartbeatPath', 'updateLockPath', 'logPath']) {
    if (!path.isAbsolute(String(value[key] || ''))) throw new Error(`Instruction path is invalid: ${key}`);
  }
  const target = path.resolve(value.targetAppDir);
  const rollback = path.resolve(value.rollbackAppDir);
  if (path.basename(target).toLowerCase() !== 'app' || path.basename(path.dirname(target)).toLowerCase() !== 'resources') {
    throw new Error(`Refusing unexpected target app directory: ${target}`);
  }
  if (path.dirname(target).toLowerCase() !== path.dirname(rollback).toLowerCase() || path.basename(rollback).toLowerCase() !== 'app.rollback') {
    throw new Error(`Refusing unexpected rollback directory: ${rollback}`);
  }
  if (!fs.existsSync(value.appExe) || !fs.existsSync(value.stagedAppDir)) throw new Error('App executable or staged payload is missing');
  verifyInstalledPayload(value.stagedAppDir, value.newVersion);
}

function verifyInstalledPayload(appDir, expectedVersion) {
  const packagePath = path.join(appDir, 'package.json');
  const mainPath = path.join(appDir, 'main.js');
  const publicKeyPath = path.join(appDir, 'updater', 'update-public-key.pem');
  if (!fs.existsSync(packagePath) || !fs.existsSync(mainPath) || !fs.existsSync(publicKeyPath)) {
    throw new Error(`Incomplete app payload: ${appDir}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (String(pkg.version || '') !== String(expectedVersion || '')) {
    throw new Error(`App version mismatch at ${appDir}: ${pkg.version} != ${expectedVersion}`);
  }
}

function copyDirectory(source, destination) {
  if (!fs.statSync(source).isDirectory()) throw new Error(`Staged payload is not a directory: ${source}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else throw new Error(`Unsupported staged entry: ${from}`);
  }
}

function safeRemoveAppDirectory(targetPath) {
  const resolved = path.resolve(targetPath);
  const parent = path.dirname(resolved);
  if (path.basename(parent).toLowerCase() !== 'resources' || !['app', 'app.rollback'].includes(path.basename(resolved).toLowerCase())) {
    throw new Error(`Refusing to remove unexpected app directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function safeRemoveStagedDirectory(stagedAppDir) {
  const resolved = path.resolve(stagedAppDir);
  if (path.basename(resolved).toLowerCase() !== 'app' || path.basename(path.dirname(resolved)).toLowerCase().startsWith('v') === false) return;
  try { fs.rmSync(path.dirname(resolved), { recursive: true, force: true }); } catch (_) {}
}

function launchApp(appExe, args = []) {
  const appDir = path.dirname(appExe);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(appExe, args, {
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    cwd: appDir,
    env
  });
  child.unref();
  const pid = Number(child.pid || 0);
  if (!pid) throw new Error(`Unable to start app executable: ${appExe}`);
  return pid;
}

function terminateProcess(pid) {
  try { process.kill(pid); } catch (_) {}
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await delay(POLL_MS);
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitForHealthyHeartbeat(filePath, expectedVersion, expectedPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const heartbeat = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const fresh = Date.now() - Number(heartbeat.ts || 0) < 15000;
      if (fresh && heartbeat.version === expectedVersion && Number(heartbeat.pid) === Number(expectedPid)) return true;
    } catch (_) {}
    await delay(POLL_MS);
  }
  return false;
}

function appendLog(message, detail) {
  const logPath = instruction && instruction.logPath;
  if (!logPath) return;
  let suffix = '';
  try { suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`; } catch (_) {}
  try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] [helper] ${message}${suffix}\n`, 'utf8'); } catch (_) {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  validateInstruction,
  verifyInstalledPayload,
  copyDirectory,
  launchApp,
  waitForProcessExit,
  waitForHealthyHeartbeat
};
