const fs = require('fs');
const path = require('path');
const releaseFiles = require('../updater/release-files');

const root = process.cwd();
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const targetRoot = path.join(root, 'dist', 'ThaiAsiaApp-win32-x64');
const resourcesApp = path.join(targetRoot, 'resources', 'app');

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

function copyIfExists(src, dest) {
  if (!exists(src)) return false;
  fs.copyFileSync(src, dest);
  return true;
}

if (!exists(electronDist)) {
  console.error('[build:win7] Missing Electron runtime at', electronDist);
  process.exit(1);
}

// Recreate dist runtime from local Electron 22 binaries
if (exists(targetRoot)) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
}
fs.mkdirSync(targetRoot, { recursive: true });
fs.cpSync(electronDist, targetRoot, { recursive: true, force: true });

const electronExe = path.join(targetRoot, 'electron.exe');
const appExe = path.join(targetRoot, 'ThaiAsiaApp.exe');
if (!exists(electronExe)) {
  console.error('[build:win7] electron.exe not found in copied runtime');
  process.exit(1);
}
fs.copyFileSync(electronExe, appExe);

fs.mkdirSync(resourcesApp, { recursive: true });

// package-lock is useful for diagnostics but is not part of the signed runtime
// payload. All files required to launch the app come from release-files.
const appFiles = [...releaseFiles, 'package-lock.json'];

for (const file of appFiles) {
  const src = path.join(root, file);
  const dest = path.join(resourcesApp, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  copyIfExists(src, dest);
}

const versionFile = path.join(targetRoot, 'version');
let version = 'unknown';
try { version = fs.readFileSync(versionFile, 'utf8').trim(); } catch (_) {}

console.log('[build:win7] dist rebuilt at:', targetRoot);
console.log('[build:win7] runtime version:', version);
console.log('[build:win7] exe:', appExe);
