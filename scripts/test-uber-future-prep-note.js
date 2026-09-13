'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const uberSource = fs.readFileSync(path.join(root, 'UberEats-Bridge.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(root, 'ThaiAsia-AllInOneapp.js'), 'utf8');

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract ${startMarker}`);
  return source.slice(start, end);
}

function normalizeText(value) {
  return String(value || '').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function comparableText(value) {
  return normalizeText(value).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đ]/g, 'd');
}

function testFuturePreparationExtraction() {
  const source = between(
    uberSource,
    'function readFuturePreparationNote',
    '/** Cộng thêm phút'
  );
  const context = {
    nt: normalizeText,
    nct: comparableText,
    document: { body: { innerText: '' } }
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const today = {
    innerText: 'Thời gian bắt đầu chuẩn bị\ndự kiến vào khoảng Hôm nay tại 19:00'
  };
  assert.strictEqual(
    context.readFuturePreparationNote(today),
    '',
    'Đơn Hôm nay phải giữ nguyên, không thêm ghi chú'
  );

  const tomorrow = {
    innerText: 'Thời gian bắt đầu chuẩn bị\ndự kiến vào khoảng ngày\nmai tại 17:05'
  };
  assert.strictEqual(
    context.readFuturePreparationNote(tomorrow),
    'Thời gian bắt đầu chuẩn bị dự kiến vào khoảng ngày mai tại 17:05'
  );

  const explicitDate = {
    innerText: 'Thời gian bắt đầu chuẩn bị dự kiến vào khoảng Thứ Sáu, 24 tháng 7 tại 18:30'
  };
  assert.strictEqual(
    context.readFuturePreparationNote(explicitDate),
    'Thời gian bắt đầu chuẩn bị dự kiến vào khoảng Thứ Sáu, 24 tháng 7 tại 18:30'
  );

  assert.strictEqual(
    context.readFuturePreparationNote({ innerText: 'Estimated preparation start time tomorrow at 12:45' }),
    'Estimated preparation start time tomorrow at 12:45'
  );
  assert.strictEqual(
    context.readFuturePreparationNote({ innerText: 'Geplanter Vorbereitungsbeginn heute um 12:45' }),
    '',
    'German today marker must also preserve old behavior'
  );
}

function testAdminNotePlacement() {
  const source = between(
    adminSource,
    'function buildAdminNote',
    'function sanitizeOrderCodeForKey'
  );
  const context = {
    normalizeText,
    normalizeComparableText: comparableText,
    sanitizeLegacyPayload(payload) { return payload; },
    buildItemsMultilineText() { return '1 x 11\n2 x 143'; }
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const futureLine = 'Thời gian bắt đầu chuẩn bị dự kiến vào khoảng ngày mai tại 17:05';
  const note = context.buildAdminNote({
    items: [{ qty: '1', code: '11' }],
    postItemsNote: futureLine
  });
  assert(note.includes(`1 x 11\n2 x 143\n${futureLine}`), 'Future line must be directly below Items');

  const todayNote = context.buildAdminNote({
    items: [{ qty: '1', code: '11' }],
    postItemsNote: ''
  });
  assert.strictEqual(
    todayNote,
    '.\n1 x 11\n2 x 143',
    'Items-only note must follow the dot without a blank line'
  );
  assert(!todayNote.includes('Thời gian bắt đầu chuẩn bị'), 'Today payload must not change Admin note');
}

function testPayloadWiring() {
  assert(uberSource.includes("const postItemsNote  = scheduled ? readFuturePreparationNote(modal) : '';"));
  assert(uberSource.includes('postItemsNote:    nt(postItemsNote)'));
  assert(adminSource.includes("payload.postItemsNote   = normalizeText(payload.postItemsNote   || '')"));
  assert(adminSource.includes('p.postItemsNote'));
}

testFuturePreparationExtraction();
testAdminNotePlacement();
testPayloadWiring();

console.log('uber future preparation note tests: OK');
