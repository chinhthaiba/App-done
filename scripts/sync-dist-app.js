'use strict';

const fs = require('fs');
const path = require('path');
const releaseFiles = require('../updater/release-files');

const root = path.resolve(__dirname, '..');

const distTargets = [
  path.join(root, 'dist', 'ThaiAsiaApp-win32-x64'),
  'E:/ThaiAsiaApp-win32-x64'
].filter(p => fs.existsSync(p));

for (const targetRoot of distTargets) {
  const targetApp = path.join(targetRoot, 'resources', 'app');
  if (!fs.existsSync(targetApp)) continue;

  for (const relativePath of releaseFiles) {
    const source = path.join(root, relativePath);
    const destination = path.join(targetApp, relativePath);
    if (!fs.existsSync(source)) throw new Error(`Missing release file: ${relativePath}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  const packageLockSource = path.join(root, 'package-lock.json');
  if (fs.existsSync(packageLockSource)) {
    fs.copyFileSync(packageLockSource, path.join(targetApp, 'package-lock.json'));
  }

  const shortcutBat = path.join(root, 'Tao-Shortcut-Desktop.bat');
  if (fs.existsSync(shortcutBat)) fs.copyFileSync(shortcutBat, path.join(targetRoot, 'Tao-Shortcut-Desktop.bat'));
  const iconIco = path.join(root, 'icon.ico');
  if (fs.existsSync(iconIco)) fs.copyFileSync(iconIco, path.join(targetRoot, 'icon.ico'));
  const stopBat = path.join(root, 'Dong-App.bat');
  if (fs.existsSync(stopBat)) fs.copyFileSync(stopBat, path.join(targetRoot, 'Dong-App.bat'));
  const stopVbs = path.join(root, 'Dong-App-An.vbs');
  if (fs.existsSync(stopVbs)) fs.copyFileSync(stopVbs, path.join(targetRoot, 'Dong-App-An.vbs'));

  console.log(`[sync:dist] Updated ${releaseFiles.length} files at: ${targetApp}`);
}

