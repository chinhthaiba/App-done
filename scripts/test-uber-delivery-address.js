'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'UberEats-Bridge.js'), 'utf8');

function between(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  assert(start >= 0 && end > start, `Cannot extract ${startMarker}`);
  return text.slice(start, end);
}

const normalizeHelpers = between(source, '  const nt  =', '  const hasOrderItemsText');
const parserSource = between(source, '  function readDeliveryDetails', '  function findHoanTatBtn');
const context = {};
vm.createContext(context);
vm.runInContext(`${normalizeHelpers}\n${parserSource}\nthis.readDeliveryDetails = readDeliveryDetails;`, context);

const hotelOrderText = [
  'Chi tiết giao hàng',
  'Hotelstraße 1, 06184 Kabelsketal, Deutschland',
  'GOOD MORNING+ HALLE LEIPZIG',
  'Hotelstraße 1, Kabelsketal',
  'Tên khách sạn: GOOD MORNING HALLE LEIPZIG',
  'số tầng hoặc số phòng:',
  'Giao hàng tận cửa',
  'MEET_IN_LOBBY',
  'DK +45 50 26 56 16',
  'Hoàn tất'
].join('\n');

const hotelOrder = context.readDeliveryDetails({ innerText: hotelOrderText });
assert.strictEqual(
  hotelOrder.address,
  'Hotelstraße 1, 06184 Kabelsketal',
  'Hotelstraße must be parsed as a street, not discarded as hotel metadata'
);
assert.strictEqual(hotelOrder.hotel, 'GOOD MORNING HALLE LEIPZIG');
assert.strictEqual(hotelOrder.phone, '+4550265616');
assert.strictEqual(hotelOrder.doorNote, 'MEET_IN_LOBBY');
assert.strictEqual(hotelOrder.additionalAddressInfo, '', 'Labeled hotel name must not be duplicated as additional address info');

const landmarkOrder = context.readDeliveryDetails({
  innerText: [
    'Lieferdetails',
    'Selkestraße 1, 06122 Halle (Saale), Deutschland',
    'Sparkassen-Eisdom',
    'selkestraße',
    'halle saale',
    '06122',
    'deutschland',
    'An die Haustür liefern',
    'DE +49 173 7527137',
    'Fertig'
  ].join('\n')
}, { allowUnlabeledAddressInfo: true });
assert.strictEqual(landmarkOrder.address, 'Selkestraße 1, 06122 Halle (Saale)');
assert.strictEqual(landmarkOrder.phone, '+491737527137');
assert.strictEqual(
  landmarkOrder.additionalAddressInfo,
  'Sparkassen-Eisdom',
  'Unlabeled landmark directly below the full Uber address must be retained'
);

const summaryOrder = context.readDeliveryDetails({
  innerText: [
    'Mottl, F. • 456EF',
    'Selkestraße 1, 06122 Halle (Saale), Deutschland',
    'Details ansehen'
  ].join('\n')
});
assert.strictEqual(summaryOrder.address, 'Selkestraße 1, 06122 Halle (Saale)');
assert.strictEqual(summaryOrder.additionalAddressInfo, '', 'Summary action button must never become additional address info');

const combinedDialogOrder = context.readDeliveryDetails({
  innerText: [
    'Selkestraße 1, 06122 Halle (Saale), Deutschland',
    'Details ansehen',
    'Lieferdetails',
    'Selkestraße 1, 06122 Halle (Saale), Deutschland',
    'Sparkassen-Eisdom',
    'DE +49 173 7527137',
    'Fertig'
  ].join('\n')
}, { allowUnlabeledAddressInfo: true });
assert.strictEqual(
  combinedDialogOrder.additionalAddressInfo,
  'Sparkassen-Eisdom',
  'Parser must keep scanning when a larger dialog container also includes the summary address'
);

const ordinaryOrder = context.readDeliveryDetails({
  innerText: 'Chi tiết giao hàng\nMarkt 12, 06108 Halle, Deutschland\nDE +49 175 1559898\nHoàn tất'
});
assert.strictEqual(ordinaryOrder.address, 'Markt 12, 06108 Halle');
assert.strictEqual(ordinaryOrder.phone, '+491751559898');
assert.strictEqual(ordinaryOrder.additionalAddressInfo, '', 'Phone/action lines must not become additional address info');

assert(source.includes("action: 'uber_delivery_address_missing'"));
assert(source.includes('Đã dừng gửi Admin và dừng tự động xử lý Uber'));
assert(source.includes("address ? 'order_summary' : ''"));

console.log('uber delivery address tests: OK');
