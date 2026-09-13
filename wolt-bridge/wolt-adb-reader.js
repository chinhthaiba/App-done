'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseWoltXml } = require('./wolt-parser');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(__dirname, 'out');
const DEFAULT_XML = path.join(OUT_DIR, 'last-window.xml');
const DEFAULT_JSON = path.join(OUT_DIR, 'last-order.json');

function parseArgs(argv) {
  const args = { command: 'dump', adb: process.env.ADB_PATH || '', serial: '' };

  for (let i = 2; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--adb') {
      args.adb = argv[++i] || '';
    } else if (value === '--serial') {
      args.serial = argv[++i] || '';
    } else if (value === '--help' || value === '-h') {
      args.command = 'help';
    } else if (!value.startsWith('--')) {
      args.command = value;
    }
  }

  return args;
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function resolveAdbPath(userPath) {
  const candidates = [
    userPath,
    'D:\\platform-tools\\adb.exe',
    'D:\\platform-tools-latest-windows\\platform-tools\\adb.exe',
    'C:\\platform-tools\\adb.exe',
    'adb',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'adb') return candidate;
    if (fileExists(candidate)) return candidate;
  }

  return candidates[0] || 'adb';
}

function runAdb(adbPath, serial, adbArgs, options = {}) {
  const fullArgs = serial ? ['-s', serial].concat(adbArgs) : adbArgs;
  return execFileSync(adbPath, fullArgs, {
    cwd: ROOT_DIR,
    encoding: options.encoding === null ? null : 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function listDevices(adbPath) {
  const output = runAdb(adbPath, '', ['devices']);
  return output
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split(/\s+/);
      return { serial: parts[0], status: parts[1] || '' };
    });
}

function pickDevice(adbPath, preferredSerial) {
  const devices = listDevices(adbPath);
  if (preferredSerial) {
    const found = devices.find(device => device.serial === preferredSerial);
    if (!found) {
      throw new Error(`Không thấy thiết bị serial ${preferredSerial}. Chạy: adb devices`);
    }
    if (found.status !== 'device') {
      throw new Error(`Thiết bị ${preferredSerial} đang ở trạng thái ${found.status}. Mở khóa tablet và bấm "Cho phép gỡ lỗi USB".`);
    }
    return found;
  }

  const ready = devices.find(device => device.status === 'device');
  if (ready) return ready;

  const unauthorized = devices.find(device => device.status === 'unauthorized');
  if (unauthorized) {
    throw new Error(`Thiết bị ${unauthorized.serial} đang unauthorized. Mở khóa tablet, rút/cắm USB và bấm "Cho phép gỡ lỗi USB".`);
  }

  throw new Error('Không thấy Android device. Kiểm tra dây USB, bật USB debugging, rồi chạy adb devices.');
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function dumpWindowXml(adbPath, serial) {
  runAdb(adbPath, serial, ['shell', 'uiautomator', 'dump', '/sdcard/window.xml']);
  const buffer = runAdb(adbPath, serial, ['exec-out', 'cat', '/sdcard/window.xml'], { encoding: null });
  return buffer.toString('utf8');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function printSummary(payload, xmlPath, jsonPath) {
  console.log('');
  console.log('✅ Đã đọc Wolt XML qua ADB');
  console.log(`XML : ${xmlPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log('');
  console.log('--- Payload tóm tắt ---');
  console.log(`Name     : ${payload.customerName || '—'}`);
  console.log(`Last name: ${payload.lastName}`);
  console.log(`Phone    : ${payload.phone || '—'}`);
  console.log(`Address  : ${payload.address || '—'}`);
  console.log(`Note     : ${payload.customerNote || '—'}`);
  console.log(`Total    : ${payload.total || '—'}`);
  console.log(`Items    : ${payload.adminItemsText || '—'}`);
  console.log('');
  console.log('Nếu thông tin chưa đúng, gửi file JSON/XML trong wolt-bridge\\out cho Codex để chỉnh parser.');
}

function printDevices(adbPath) {
  const devices = listDevices(adbPath);
  console.log('ADB devices:');
  if (!devices.length) {
    console.log('  (không thấy thiết bị)');
    return;
  }
  for (const device of devices) {
    console.log(`  ${device.serial}\t${device.status}`);
  }
}

function saveScreenshot(adbPath, serial) {
  ensureOutDir();
  const outPath = path.join(OUT_DIR, 'last-screen.png');
  const buffer = runAdb(adbPath, serial, ['exec-out', 'screencap', '-p'], { encoding: null });
  fs.writeFileSync(outPath, buffer);
  console.log(`✅ Đã lưu screenshot: ${outPath}`);
}

function printHelp() {
  console.log([
    'Wolt ADB Bridge',
    '',
    'Lệnh:',
    '  node wolt-bridge\\wolt-adb-reader.js devices',
    '  node wolt-bridge\\wolt-adb-reader.js dump',
    '  node wolt-bridge\\wolt-adb-reader.js screenshot',
    '',
    'Tùy chọn:',
    '  --adb "D:\\platform-tools\\adb.exe"',
    '  --serial SERIAL',
    '',
    'Output:',
    '  wolt-bridge\\out\\last-window.xml',
    '  wolt-bridge\\out\\last-order.json',
  ].join('\n'));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command === 'help') {
    printHelp();
    return;
  }

  const adbPath = resolveAdbPath(args.adb);

  if (args.command === 'devices') {
    printDevices(adbPath);
    return;
  }

  const device = pickDevice(adbPath, args.serial);
  console.log(`Android device: ${device.serial}`);

  if (args.command === 'screenshot') {
    saveScreenshot(adbPath, device.serial);
    return;
  }

  if (args.command !== 'dump') {
    throw new Error(`Không biết lệnh: ${args.command}. Dùng --help để xem lệnh.`);
  }

  ensureOutDir();
  const xml = dumpWindowXml(adbPath, device.serial);
  const payload = parseWoltXml(xml);

  fs.writeFileSync(DEFAULT_XML, xml, 'utf8');
  writeJson(DEFAULT_JSON, payload);
  printSummary(payload, DEFAULT_XML, DEFAULT_JSON);
}

try {
  main();
} catch (error) {
  console.error('');
  console.error('❌ Wolt ADB Bridge lỗi:');
  console.error(error && error.message ? error.message : error);
  console.error('');
  console.error('Gợi ý nhanh:');
  console.error('- Chạy: node wolt-bridge\\wolt-adb-reader.js devices');
  console.error('- Nếu unauthorized: mở khóa tablet và bấm "Cho phép gỡ lỗi USB"');
  console.error('- Nếu không thấy adb: dùng --adb "D:\\platform-tools\\adb.exe"');
  process.exitCode = 1;
}
