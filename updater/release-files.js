'use strict';

// Complete application payload. The updater replaces resources/app as one unit,
// so every runtime file required by the Electron app must be listed here.
module.exports = Object.freeze([
  'main.js',
  'preload.js',
  'preload-admin.js',
  'preload-liveorder.js',
  'preload-ubereats.js',
  'preload-wolt.js',
  'preload-tienship.js',
  'tienship.js',
  'ThaiAsia-AllInOneapp.js',
  'UberEats-Bridge.js',
  'Wolt-Bridge.js',
  'Autofertig.js',
  'index.html',
  'icon.ico',
  'package.json',
  'README.txt',
  'updater/auto-update-manager.js',
  'updater/apply-update.js',
  'updater/restart-app.js',
  'updater/release-files.js',
  'updater/release-format.js',
  'updater/settings.html',
  'updater/settings-preload.js',
  'updater/update-public-key.pem'
]);
