'use strict';

// Runs outside Electron's main process. It waits until the old instance has
// completely exited, then starts the executable directly so the returned PID is
// the real ThaiAsiaApp process (not an intermediate cmd.exe process).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PARENT_EXIT_TIMEOUT_MS = 90 * 1000;
const POLL_MS = 250;
const instructionPath = process.argv[2];
let instruction = null;

if (require.main === module) {
  main().catch((error) => {
    appendLog('FATAL restart helper error', error && error.stack || error);
    process.exitCode = 1;
  });
}

async function main() {
  if (!instructionPath || !fs.existsSync(instructionPath)) throw new Error('Missing restart instruction file');
  instruction = JSON.parse(fs.readFileSync(instructionPath, 'utf8'));
  validateInstruction(instruction);
  appendLog('Restart helper started', { parentPid: instruction.parentPid, reason: instruction.reason || '' });

  try {
    const parentExited = await waitForProcessExit(instruction.parentPid, PARENT_EXIT_TIMEOUT_MS);
    if (!parentExited) throw new Error(`App PID ${instruction.parentPid} did not exit before timeout`);
    await delay(500);
    const pid = launchApp(instruction.appExe);
    appendLog('App restarted by external helper', { pid, reason: instruction.reason || '' });
  } finally {
    try { fs.rmSync(instructionPath, { force: true }); } catch (_) {}
  }
}

function validateInstruction(value) {
  if (!value || value.schemaVersion !== 1) throw new Error('Invalid restart instruction schema');
  if (!Number.isSafeInteger(value.parentPid) || value.parentPid <= 0) throw new Error('Invalid parent PID');
  for (const key of ['appExe', 'logPath']) {
    if (!path.isAbsolute(String(value[key] || ''))) throw new Error(`Instruction path is invalid: ${key}`);
  }
  if (!fs.existsSync(value.appExe)) throw new Error(`App executable is missing: ${value.appExe}`);
}

function launchApp(appExe, args = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(appExe, args, {
    detached: true,
    stdio: 'ignore',
    cwd: path.dirname(appExe),
    windowsHide: false,
    env
  });
  child.unref();
  const pid = Number(child.pid || 0);
  if (!pid) throw new Error(`Unable to start app executable: ${appExe}`);
  return pid;
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

function appendLog(message, detail) {
  const logPath = instruction && instruction.logPath;
  if (!logPath) return;
  let suffix = '';
  try { suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`; } catch (_) {}
  try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] [restart-helper] ${message}${suffix}\n`, 'utf8'); } catch (_) {}
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  validateInstruction,
  launchApp,
  waitForProcessExit
};
