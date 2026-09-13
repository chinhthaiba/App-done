'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'ThaiAsia-AllInOneapp.js'), 'utf8');

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract ${startMarker}`);
  return text.slice(start, end);
}

const normalizeHelpers = between(source, '  function normalizeText', '  // ---- Module log functions');
const nameParser = between(source, '  function isLikelyCustomerName', '  function extractItemsFromText');
const context = {};
vm.createContext(context);
vm.runInContext(
  `${normalizeHelpers}\n${nameParser}\n` +
  'this.isLikelyCustomerName = isLikelyCustomerName;' +
  'this.extractCustomerNameFromRawText = extractCustomerNameFromRawText;',
  context
);

const corporateOrder = [
  '#MFY88D',
  '06184 Kabelsketal, Orionstraße 6',
  'Schaeffler Vehicle Lifetime So Amrei Lages',
  '+4915735984469',
  'Bestätigungscode: 489219224',
  'Firma: Schaeffler Vehicle Lifetime Solutions Germany GmbH & Co. KG',
  'Bestellung angenommen um 09:49 - 26 Aug',
  '6 Gerichte',
  'Zwischensumme EUR 74.70',
  'Liefergebühr EUR 3.00',
  'Gesamt EUR 77.70'
].join('\n');

assert.strictEqual(
  context.extractCustomerNameFromRawText(corporateOrder),
  'Schaeffler Vehicle Lifetime So Amrei Lages'
);

const ordinaryOrder = [
  '#ABCDE1',
  '06108 Halle, Markt 12',
  'Max Mustermann',
  '+491751559898',
  'Bestätigungscode: 123456'
].join('\n');
assert.strictEqual(context.extractCustomerNameFromRawText(ordinaryOrder), 'Max Mustermann');

assert.strictEqual(context.isLikelyCustomerName('06184 Kabelsketal, Orionstraße 6'), false);
assert.strictEqual(context.isLikelyCustomerName('Firma: Schaeffler Vehicle Lifetime Solutions Germany GmbH & Co. KG'), false);
assert.strictEqual(context.isLikelyCustomerName('Bestätigungscode: 489219224'), false);
assert.strictEqual(context.isLikelyCustomerName('Gesamt EUR 77.70'), false);

console.log('takeaway customer-name tests: OK');
