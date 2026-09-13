const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const appCode = fs.readFileSync(path.join(root, 'ThaiAsia-AllInOneapp.js'), 'utf8');

// Test 1: extractCustomerNote skips Floor/Etage/Zimmer lines
function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  return text.slice(start, end);
}

const extractNoteCode = between(appCode, '  function extractCustomerNote(rawText) {', '  function isLikelyCustomerName');
const stripUiNoise = t => String(t || '');
const normalizeText = t => String(t || '').trim();
const uniq = arr => Array.from(new Set(arr));

const testExtractNote = new Function('stripUiNoise', 'normalizeText', 'uniq',
  `return (${extractNoteCode});`
)(stripUiNoise, normalizeText, uniq);

const rawLieferandoPanel = [
  'Felix Trapp',
  '+4915735984469 Bestätigungscode: 800430602',
  'Firma: Station 11-9 (HCH 2)',
  'Bestellung angenommen um 16:42 - 28 Aug',
  '11/9',
  'Floor: Bettenhaus 11, 9. Etage',
  '3 Gerichte',
  '1 62. Krosse Ente EUR 15.70',
  '1 53. Krosses Hühnerfilet EUR 14.60',
  '1 54. Krosses Hühnerfilet EUR 14.60',
  'Zwischensumme EUR 44.90',
  'Liefergebühr EUR 3.00',
  'Gesamt EUR 48.89'
].join('\n');

const extractedNote = testExtractNote(rawLieferandoPanel);
console.log('Extracted Note from Lieferando:', JSON.stringify(extractedNote));
assert.strictEqual(extractedNote, '11/9', 'Floor line must be excluded from customerNote');

const stripPriceCode = between(appCode, '  function stripPriceFromItemText(text) {', '  // Merged isVisible');
const allNoteCode = between(appCode, '  function sanitizeLegacyPayload(payload) {', '  function sanitizeOrderCodeForKey');
const normalizePaymentMethod = v => v;
const normalizeComparableText = t => String(t || '').toLowerCase().trim();

const testBuildNote = new Function(
  'normalizeText', 'normalizeComparableText', 'normalizePaymentMethod',
  `
  ${stripPriceCode}
  ${allNoteCode}
  return buildAdminNote;
  `
)(normalizeText, normalizeComparableText, normalizePaymentMethod);

const testPayload = {
  source: 'live-orders.takeaway.com',
  orderCode: '7JQGCH',
  customerName: 'Felix Trapp',
  phone: '+4915735984469,800430602#',
  address: 'Ernst-Grube-Straße 40, 06120 Halle (Saale)',
  floor: 'Bettenhaus 11, 9. Etage',
  firma: 'Station 11-9 (HCH 2)',
  customerNote: '11/9 Floor: Bettenhaus 11, 9. Etage', // Giả sử nếu có sót
  items: [
    { qty: '1', code: '62', name: 'Krosse Ente' },
    { qty: '1', code: '53', name: 'Krosses Hühnerfilet' },
    { qty: '1', code: '54', name: 'Krosses Hühnerfilet' }
  ]
};

const finalAdminNote = testBuildNote(testPayload);
console.log('Final Admin Note:\n' + finalAdminNote);

assert(!finalAdminNote.includes('11/9 Floor:'), 'Floor must not be duplicated in note');
assert(finalAdminNote.includes('Haus Nr. / Zimmer / Etage : Bettenhaus 11, 9. Etage'), 'Floor must be formatted with Haus Nr...');
assert(finalAdminNote.includes('Firma: Station 11-9 (HCH 2)'), 'Firma must be formatted');
assert(finalAdminNote.includes('11/9'), 'Badge 11/9 must be retained cleanly');

const itemsOnlyNote = testBuildNote({
  source: 'live-orders.takeaway.com',
  items: [
    { qty: '2', code: '110' },
    { qty: '1', code: '118' }
  ]
});
assert.strictEqual(
  itemsOnlyNote,
  '.\n2 x 110\n1 x 118',
  'Items must follow the dot directly when no information exists above them'
);

const infoAndItemsNote = testBuildNote({
  source: 'live-orders.takeaway.com',
  floor: '3',
  items: [{ qty: '2', code: '110' }]
});
assert.strictEqual(
  infoAndItemsNote,
  '.\nHaus Nr. / Zimmer / Etage : 3\n2 x 110',
  'Information and Items must follow each other without a blank line'
);

const uberLandmarkNote = testBuildNote({
  source: 'merchants-beta.ubereats.com',
  additionalAddressInfo: 'Sparkassen-Eisdom',
  items: [{ qty: '1', code: '10' }]
});
assert.strictEqual(
  uberLandmarkNote,
  '.\nThông tin địa chỉ bổ sung: Sparkassen-Eisdom\n1 x 10',
  'Uber landmark must be carried into the Admin note'
);

assert.strictEqual(
  testBuildNote({ source: 'live-orders.takeaway.com', items: [] }),
  '.',
  'An empty note must keep the dot placeholder'
);

console.log('All tests in test-takeaway-note-cleanup: OK!');
