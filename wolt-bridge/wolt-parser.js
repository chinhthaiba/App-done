'use strict';

function normalizeText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function normalizeComparable(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đ]/g, 'd');
}

function decodeXmlValue(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseNodeAttributes(rawNode) {
  const attrs = {};
  rawNode.replace(/([\w:-]+)="([^"]*)"/g, (_, key, value) => {
    attrs[key] = decodeXmlValue(value);
    return '';
  });
  return attrs;
}

function extractNodes(xml) {
  const nodes = [];
  const nodePattern = /<node\b[^>]*>/g;
  let match;

  while ((match = nodePattern.exec(String(xml || ''))) !== null) {
    const attrs = parseNodeAttributes(match[0]);
    nodes.push({
      text: normalizeText(attrs.text),
      contentDesc: normalizeText(attrs['content-desc']),
      resourceId: attrs['resource-id'] || '',
      className: attrs.class || '',
      packageName: attrs.package || '',
      bounds: attrs.bounds || '',
      clickable: attrs.clickable === 'true',
      enabled: attrs.enabled !== 'false',
    });
  }

  return nodes;
}

function collectTextBlocks(nodes) {
  const blocks = [];
  const seen = new Set();

  for (const node of nodes || []) {
    if (node.packageName && node.packageName !== 'com.wolt.picker') continue;
    for (const raw of [node.text, node.contentDesc]) {
      const value = normalizeText(raw);
      if (!value) continue;
      const key = value + '|' + node.bounds;
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push({ value, bounds: node.bounds, clickable: node.clickable });
    }
  }

  return blocks;
}

function flattenLines(blocks) {
  const lines = [];
  for (const block of blocks || []) {
    for (const line of block.value.split('\n')) {
      const text = normalizeText(line);
      if (text) lines.push(text);
    }
  }
  return lines;
}

function isPriceLine(value) {
  return /^(?:EUR\s*)?\d+[,.]\d{2}\s*(?:€|EUR)?$/i.test(normalizeText(value)) ||
    /^€\s*\d+[,.]\d{2}$/i.test(normalizeText(value));
}

function stripPriceTail(value) {
  return normalizeText(value)
    .replace(/\s*(?:EUR\s*)?\d+[,.]\d{2}\s*(?:€|EUR)?\s*$/i, '')
    .replace(/\s*€\s*\d+[,.]\d{2}\s*$/i, '')
    .trim();
}

function formatAdminItemCode(code) {
  let value = normalizeText(code).replace(/\.$/, '');
  value = value.replace(/(\d+)\.\s+.+$/, '$1');
  return value;
}

function parseItemsFromBlocks(blocks) {
  const items = [];

  for (const block of blocks || []) {
    const lines = block.value.split('\n').map(normalizeText).filter(Boolean);
    if (!lines.length) continue;

    const joined = normalizeText(lines.join(' '));
    const inlineMatch = joined.match(/^(\d+)\s*[x×]\s*(.{1,160}?)(?:\s+(?:EUR\s*)?\d+[,.]\d{2}\s*(?:€|EUR)?)?$/i);
    if (inlineMatch && /\d/.test(inlineMatch[2])) {
      items.push({
        qty: inlineMatch[1],
        code: stripPriceTail(inlineMatch[2]),
        name: '',
        note: '',
      });
      continue;
    }

    if (lines.length >= 2) {
      const qtyMatch = lines[0].match(/^(\d+)\s*[x×]?\s*$/i);
      const codeLine = lines.find((line, idx) => idx > 0 && !isPriceLine(line) && /\d/.test(line));
      if (qtyMatch && codeLine) {
        items.push({
          qty: qtyMatch[1],
          code: stripPriceTail(codeLine),
          name: '',
          note: '',
        });
      }
    }
  }

  const seen = new Set();
  return items
    .map(item => ({
      qty: normalizeText(item.qty || '1'),
      code: normalizeText(item.code),
      name: '',
      note: normalizeText(item.note),
    }))
    .filter(item => item.code && item.qty)
    .filter(item => {
      const key = item.qty + '|' + item.code;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function looksLikeAddress(value) {
  const text = normalizeText(value).replace(/\n/g, ' ');
  return /\b\d{5}\b/.test(text) &&
    /(str|straße|strasse|chaussee|allee|weg|platz|gasse|ring|ufer|damm|saale|halle|deutschland)/i.test(text);
}

function looksLikeStreetLine(value) {
  const text = normalizeText(value);
  return /\d/.test(text) &&
    /(str|straße|strasse|chaussee|allee|weg|platz|gasse|ring|ufer|damm)/i.test(text);
}

function looksLikePostcodeCityLine(value) {
  return /\b\d{5}\b/.test(normalizeText(value));
}

function extractAddress(lines, blocks) {
  for (const block of blocks || []) {
    const combined = block.value.split('\n').map(normalizeText).filter(Boolean).join(', ');
    if (looksLikeAddress(combined)) return combined;
  }

  for (let i = 0; i < lines.length; i++) {
    if (looksLikeAddress(lines[i])) return lines[i];
    if (looksLikeStreetLine(lines[i]) && looksLikePostcodeCityLine(lines[i + 1] || '')) {
      return `${lines[i]}, ${lines[i + 1]}`;
    }
  }

  return '';
}

function extractPhone(lines) {
  const joined = lines.join(' ');
  const match = joined.match(/(?:DE\s*)?(?:\+49|0)\s*[\d\s()/.-]{6,}/i);
  return match ? normalizeText(match[0]) : '';
}

function extractPrices(lines) {
  return lines.filter(isPriceLine);
}

function findAddressStartIndex(lines, address) {
  const addressText = normalizeText(address);
  if (!addressText) return -1;

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeText(lines[i]);
    if (!line) continue;
    if (addressText === line) return i;
    if (addressText.includes(line) && (looksLikeStreetLine(line) || looksLikePostcodeCityLine(line) || looksLikeAddress(line))) {
      return i;
    }
  }

  return -1;
}

function isUiNoise(value) {
  const text = normalizeComparable(value);
  if (!text) return true;
  return /^(home|zuruck|back|modal barrier|close|schliessen|dong|x|gui|gio hang|mon an|chi tiet|ho tro|lien he|van de dat hang|dat hang|thanh toan|delivery|pickup)$/.test(text) ||
    /^(chon|ban dang|ung dung|wolt merchant|wolt)$/i.test(text);
}

function extractCustomerName(lines, address) {
  const addressIdx = findAddressStartIndex(lines, address);
  const endIdx = addressIdx > 0 ? addressIdx : Math.min(lines.length, 12);
  const candidates = lines.slice(0, endIdx).filter(line => {
    if (isUiNoise(line)) return false;
    if (looksLikeAddress(line)) return false;
    if (isPriceLine(line)) return false;
    if (/^\d+\s*[x×]/i.test(line)) return false;
    if (/\d{1,2}\.\d{1,2}\.\d{4}/.test(line)) return false;
    if (/^\d{1,2}:\d{2}$/.test(line)) return false;
    if (line.length > 60) return false;
    return /[A-Za-zÀ-ỹÄÖÜäöüß]/.test(line);
  });

  return candidates.length ? candidates[candidates.length - 1] : '';
}

function extractOrderNote(lines, items, address, customerName) {
  const itemCodes = new Set(items.map(item => normalizeComparable(item.code)));
  const ignored = new Set([
    normalizeComparable(address),
    normalizeComparable(customerName),
    ...items.map(item => normalizeComparable(formatAdminItemCode(item.code))),
  ]);

  const notes = [];
  for (const line of lines) {
    const key = normalizeComparable(line);
    if (!key || ignored.has(key) || itemCodes.has(key)) continue;
    if (address && normalizeComparable(address).includes(key)) continue;
    if (isUiNoise(line) || looksLikeAddress(line) || isPriceLine(line)) continue;
    if (/^\d+\s*[x×]/i.test(line) || /^\d+$/.test(line)) continue;
    if (/^[A-Z0-9]{2,10}$/.test(line.trim())) continue;
    if (/\d{1,2}\.\d{1,2}\.\d{4}/.test(line)) continue;
    if (/^(telefon|phone|tel|zahlung|payment|gesamt|total|summe|lieferung|abholung|pickup|delivery)/i.test(key)) continue;
    if (line.length <= 160 && /[A-Za-zÀ-ỹÄÖÜäöüß]/.test(line)) notes.push(line);
  }

  return notes.slice(-2).join(' | ');
}

function parseWoltXml(xml) {
  const nodes = extractNodes(xml);
  const blocks = collectTextBlocks(nodes);
  const lines = flattenLines(blocks);
  const items = parseItemsFromBlocks(blocks);
  const address = extractAddress(lines, blocks);
  const phone = extractPhone(lines);
  const prices = extractPrices(lines);
  const total = prices.length ? prices[prices.length - 1] : '';
  const customerName = extractCustomerName(lines, address);
  const customerNote = extractOrderNote(lines, items, address, customerName);

  return {
    source: 'Wolt',
    customerName,
    lastName: '(Wolt)',
    phone,
    address,
    customerNote,
    paymentMethod: '',
    deliveryTime: '',
    subtotal: '',
    deliveryFee: '',
    total,
    items,
    adminItemsText: items
      .map(item => `${item.qty} x ${formatAdminItemCode(item.code)}${item.note ? '  :  ' + item.note : ''}`)
      .join(' + '),
    debug: {
      nodeCount: nodes.length,
      blockCount: blocks.length,
      lines,
      blocks: blocks.map(block => block.value),
    },
  };
}

module.exports = {
  parseWoltXml,
  extractNodes,
  collectTextBlocks,
  flattenLines,
  formatAdminItemCode,
};
