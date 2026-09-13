#!/usr/bin/env node
'use strict';

/*
  Wolt LDPlayer reader - single-file test tool.

  Mục tiêu bước 1:
  - Không đụng main app.
  - Không sửa dist.
  - Không tạo file phụ mặc định.
  - Chỉ đọc text đang có trong Wolt qua ADB/UIAutomator để xem LDPlayer có cho lấy dữ liệu không.

  Xóa file này là sạch.
*/

const { execFileSync } = require('child_process');

const CONFIG = {
  woltPackage: 'com.wolt.picker',
  dumpPath: '/sdcard/window.xml',
  commonLdPorts: [5555, 5557, 5559, 5561, 5563, 62001],
  commonAdbPaths: [
    process.env.WOLT_ADB,
    process.env.ADB_PATH,
    'adb',
    'C:\\LDPlayer\\LDPlayer9\\adb.exe',
    'C:\\LDPlayer\\LDPlayer4.0\\adb.exe',
    'C:\\LDPlayer\\LDPlayer4\\adb.exe',
    'C:\\Program Files\\LDPlayer\\LDPlayer9\\adb.exe',
    'C:\\Program Files\\LDPlayer\\LDPlayer4\\adb.exe',
    'C:\\ChangZhi\\LDPlayer9\\adb.exe',
    'C:\\ChangZhi\\LDPlayer\\adb.exe',
    'D:\\LDPlayer\\LDPlayer9\\adb.exe',
    'D:\\LDPlayer\\LDPlayer4.0\\adb.exe',
    'D:\\LDPlayer\\LDPlayer4\\adb.exe'
  ].filter(Boolean)
};

function usage() {
  console.log(`
Wolt LDPlayer reader - one file

Lệnh test:
  node wolt-ldplayer-onefile.js devices
  node wolt-ldplayer-onefile.js read
  node wolt-ldplayer-onefile.js read --open
  node wolt-ldplayer-onefile.js read --scroll 3

Tùy chọn:
  --device <serial>   Chọn máy ADB nếu có nhiều máy.
  --open              Mở app Wolt Merchant trước khi đọc.
  --scroll <n>        Đọc thêm n lần sau khi vuốt lên, dùng khi đơn dài.
  --json              In JSON thay vì danh sách text.

Nếu không tìm thấy ADB, chạy PowerShell:
  $env:WOLT_ADB="C:\\LDPlayer\\LDPlayer9\\adb.exe"
  node wolt-ldplayer-onefile.js devices
`.trim());
}

function hasArg(name) {
  return process.argv.includes(name);
}

function getArgValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function run(exe, args, options) {
  const mergedOptions = Object.assign({
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true
  }, options || {});

  return execFileSync(exe, args, mergedOptions).toString();
}

function tryRun(exe, args, options) {
  try {
    return { ok: true, text: run(exe, args, options) };
  } catch (error) {
    const stderr = error && error.stderr ? error.stderr.toString() : '';
    const stdout = error && error.stdout ? error.stdout.toString() : '';
    const message = stderr || stdout || (error && error.message) || String(error);
    return { ok: false, text: message.trim() };
  }
}

function findAdb() {
  for (const candidate of CONFIG.commonAdbPaths) {
    const result = tryRun(candidate, ['version'], { timeout: 5000 });
    if (result.ok) return candidate;
  }

  throw new Error(
    'Không tìm thấy adb.exe. Hãy set $env:WOLT_ADB="C:\\\\LDPlayer\\\\LDPlayer9\\\\adb.exe" rồi chạy lại.'
  );
}

function parseAdbDevices(output) {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.toLowerCase().startsWith('list of devices'))
    .map(line => {
      const parts = line.split(/\s+/);
      return { serial: parts[0], state: parts[1] || '' };
    })
    .filter(device => device.serial);
}

function listDevices(adb) {
  const result = tryRun(adb, ['devices'], { timeout: 8000 });
  if (!result.ok) return [];
  return parseAdbDevices(result.text).filter(device => device.state === 'device');
}

function connectCommonLdPorts(adb) {
  for (const port of CONFIG.commonLdPorts) {
    tryRun(adb, ['connect', `127.0.0.1:${port}`], { timeout: 3000 });
  }
}

function pickDevice(adb) {
  const requested = getArgValue('--device', '');
  if (requested) return requested;

  let devices = listDevices(adb);
  if (!devices.length) {
    connectCommonLdPorts(adb);
    sleep(600);
    devices = listDevices(adb);
  }

  if (!devices.length) {
    throw new Error(
      'ADB chưa thấy LDPlayer. Hãy mở LDPlayer/Wolt rồi chạy: node wolt-ldplayer-onefile.js devices'
    );
  }

  return devices[0].serial;
}

function adbShell(adb, device, shellArgs, options) {
  return run(adb, ['-s', device, 'shell'].concat(shellArgs), options);
}

function tryAdbShell(adb, device, shellArgs, options) {
  return tryRun(adb, ['-s', device, 'shell'].concat(shellArgs), options);
}

function openWolt(adb, device) {
  const result = tryAdbShell(
    adb,
    device,
    ['monkey', '-p', CONFIG.woltPackage, '-c', 'android.intent.category.LAUNCHER', '1'],
    { timeout: 8000 }
  );

  if (!result.ok) {
    throw new Error('Không mở được Wolt bằng package ' + CONFIG.woltPackage + ': ' + result.text);
  }

  sleep(1800);
}

function getFocusedApp(adb, device) {
  const result = tryAdbShell(adb, device, ['dumpsys', 'window', 'windows'], { timeout: 10000 });
  if (!result.ok) return '';

  const text = result.text || '';
  const focusMatch =
    text.match(/mCurrentFocus=Window\{[^}]+\s+([a-zA-Z0-9_.]+)\/[^}\s]+/) ||
    text.match(/mFocusedApp=.*\s([a-zA-Z0-9_.]+)\/[^}\s]+/);

  return focusMatch && focusMatch[1] ? focusMatch[1] : '';
}

function dumpWindowXml(adb, device) {
  let dumpResult = tryAdbShell(
    adb,
    device,
    ['uiautomator', 'dump', '--compressed', CONFIG.dumpPath],
    { timeout: 15000 }
  );

  if (!dumpResult.ok) {
    dumpResult = tryAdbShell(
      adb,
      device,
      ['uiautomator', 'dump', CONFIG.dumpPath],
      { timeout: 15000 }
    );
  }

  if (!dumpResult.ok) {
    throw new Error('Không dump được UIAutomator XML: ' + dumpResult.text);
  }

  const catResult = tryRun(
    adb,
    ['-s', device, 'exec-out', 'cat', CONFIG.dumpPath],
    { timeout: 15000 }
  );

  if (!catResult.ok || !catResult.text.trim()) {
    throw new Error('Không đọc được XML từ LDPlayer: ' + catResult.text);
  }

  return catResult.text;
}

function decodeXml(value) {
  return (value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeText(value) {
  return decodeXml(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTextsFromXml(xml) {
  const found = [];
  const seen = new Set();
  const attrRegex = /\b(?:text|content-desc)="([^"]*)"/g;
  let match;

  while ((match = attrRegex.exec(xml))) {
    const line = normalizeText(match[1]);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    found.push(line);
  }

  return found;
}

function swipeUp(adb, device) {
  tryAdbShell(adb, device, ['input', 'swipe', '800', '780', '800', '240', '450'], { timeout: 5000 });
  sleep(900);
}

function collectVisibleTexts(adb, device, scrollCount) {
  const all = [];
  const seen = new Set();
  const passes = Math.max(1, scrollCount + 1);

  for (let pass = 0; pass < passes; pass++) {
    const xml = dumpWindowXml(adb, device);
    const lines = extractTextsFromXml(xml);

    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      all.push(line);
    }

    if (pass < passes - 1) swipeUp(adb, device);
  }

  return all;
}

function printDevices(adb) {
  connectCommonLdPorts(adb);
  sleep(500);
  const devices = listDevices(adb);

  console.log('ADB:', adb);
  if (!devices.length) {
    console.log('Không thấy device nào.');
    console.log('Hãy mở LDPlayer > menu góc phải > Settings > Other settings > ADB debugging > Open local connection/Enable.');
    console.log('Sau đó Save, restart LDPlayer nếu cần, rồi chạy lại lệnh devices.');
    return;
  }

  devices.forEach((device, index) => {
    console.log(`${index + 1}. ${device.serial} (${device.state})`);
  });
}

function printReadResult(info) {
  if (hasArg('--json')) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.log('ADB:', info.adb);
  console.log('Device:', info.device);
  console.log('Focused app:', info.focusedApp || '(không đọc được)');
  console.log('Text lines:', info.lines.length);
  console.log('');

  if (!info.lines.length) {
    console.log('Không thấy text nào trong UI dump.');
    return;
  }

  info.lines.forEach((line, index) => {
    console.log(String(index + 1).padStart(3, '0') + ' | ' + line);
  });
}

function main() {
  const command = process.argv[2] || 'help';

  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  const adb = findAdb();

  if (command === 'devices') {
    printDevices(adb);
    return;
  }

  if (command === 'read') {
    const device = pickDevice(adb);
    if (hasArg('--open')) openWolt(adb, device);

    const focusedApp = getFocusedApp(adb, device);
    const scrollCount = Math.max(0, parseInt(getArgValue('--scroll', '0'), 10) || 0);
    const lines = collectVisibleTexts(adb, device, scrollCount);

    printReadResult({ adb, device, focusedApp, lines, scrollCount });
    return;
  }

  usage();
}

try {
  main();
} catch (error) {
  console.error('LỖI:', error && error.message ? error.message : String(error));
  process.exitCode = 1;
}
