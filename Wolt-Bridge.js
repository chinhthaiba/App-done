(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.ThaiAsiaWoltBridge = api;
    if (root.document) api.start(root);
  }
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  const ADMIN_URL = 'https://www.api.thaiasiasushibar.de/admin/orders/create';
  const BRIDGE_STORAGE_KEY = 'thaiasia_takeaway_order_bridge_v9';
  const BRIDGE_INDEX_KEY = 'thaiasia_takeaway_order_bridge_index_v9';
  const BRIDGE_ACTIVE_KEY = 'thaiasia_takeaway_order_bridge_active_v9';
  const WOLT_STATE_KEY = 'thaiasia_wolt_web_state_v1';
  const STATE_TTL_MS = 24 * 60 * 60 * 1000;
  const ADMIN_TIMEOUT_MS = 2 * 60 * 1000;
  const CONTROL_ID = 'thaiasia-wolt-controls';
  const RUNTIME_POLICY = Object.freeze({
    autoFill: true,
    autoSubmit: true,
    woltActions: true,
    waitForAdminAck: true,
    showAdmin: false,
    previewState: 'admin_pending'
  });

  function buildStoredPayload(payload, identity, policy, timestamp) {
    const runtime = policy || RUNTIME_POLICY;
    return {
      ...payload,
      __woltIdentity: identity,
      __autoFill: runtime.autoFill === true,
      __autoSubmit: runtime.autoSubmit === true,
      __autoActionAt: Number(timestamp || Date.now())
    };
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function firstValue() {
    for (let i = 0; i < arguments.length; i += 1) {
      const value = arguments[i];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return '';
  }

  function valueAt(object, path) {
    let value = object;
    for (const part of String(path || '').split('.')) {
      if (!value || typeof value !== 'object') return undefined;
      value = value[part];
    }
    return value;
  }

  function stringValue(value) {
    if (typeof value === 'string' || typeof value === 'number') return normalizeText(value);
    if (!value || typeof value !== 'object') return '';
    const direct = firstValue(value.name, value.text, value.value, value.label, value.displayName);
    if (direct && direct !== value) return stringValue(direct);
    const first = normalizeText(firstValue(value.firstName, value.first_name));
    const last = normalizeText(firstValue(value.lastName, value.last_name));
    return normalizeText(`${first} ${last}`);
  }

  function orderNumberOf(task) {
    return normalizeText(firstValue(
      valueAt(task, 'orderNumber'),
      valueAt(task, 'order_number'),
      valueAt(task, 'order.number'),
      valueAt(task, 'displayId'),
      valueAt(task, 'display_id'),
      valueAt(task, 'display_number'),
      valueAt(task, 'number'),
      valueAt(task, 'externalId'),
      valueAt(task, 'external_id'),
      valueAt(task, 'code')
    )).replace(/^WOLT[-\s]*/i, '');
  }

  function orderNumbersMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    // Compare without leading zeros (UI shows '082', API may return '82')
    var na = a.replace(/^0+/, '') || '0';
    var nb = b.replace(/^0+/, '') || '0';
    return na.toLowerCase() === nb.toLowerCase();
  }

  function extractOrderNumberMarker(value) {
    const text = normalizeText(value);
    if (!text) return '';
    const numeric = text.match(/#\s*(\d{1,10})(?!\d)/);
    if (numeric) return numeric[1];
    const explicit = text.match(/#\s*([A-Z0-9-]*\d[A-Z0-9-]*)(?=\s|$)/);
    return explicit ? explicit[1] : '';
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function labelContainsOrderMarker(label, orderNumber) {
    const text = normalizeText(label);
    const number = normalizeText(orderNumber).replace(/^WOLT[-\s]*/i, '');
    if (!text || !number) return false;
    if (/^\d+$/.test(number)) {
      const significant = number.replace(/^0+/, '') || '0';
      return new RegExp(`#\\s*0*${escapeRegExp(significant)}(?!\\d)`, 'i').test(text);
    }
    return new RegExp(`#\\s*${escapeRegExp(number)}(?![A-Z0-9-])`, 'i').test(text);
  }

  function isEmbeddedAcceptLabel(label, orderNumber) {
    return isEmbeddedActionLabel(label, orderNumber, 'accept');
  }

  function isEmbeddedActionLabel(label, orderNumber, actionName) {
    const text = normalizeText(label);
    if (!labelContainsOrderMarker(text, orderNumber)) return false;
    if (actionName === 'accept') return /(?:Bestellung annehmen|Accept order|Annehmen)\s*$/i.test(text);
    if (actionName === 'ready') return /(?:Bereit|Ready|Als bereit markieren|Mark as ready)\s*$/i.test(text);
    return false;
  }

  function isCompactFlutterSemanticRecord(row) {
    const element = row && row.element;
    const tag = normalizeText(element && element.tagName).toLowerCase();
    const label = normalizeText(row && row.label);
    return tag === 'flt-semantics' && label.length > 0 && label.length <= 80;
  }

  function shouldUseSemanticElementClick(row, actionName) {
    const action = String(actionName || '').toLowerCase();
    if (
      action === 'mark_ready' ||
      action === 'mark_ready_native_fallback' ||
      action === 'accept_order' ||
      action === 'delivery_time_confirm' ||
      action === 'delivery_time_option' ||
      (row && /^(?:Bereit|Ready|Bestellung annehmen|Annehmen|Accept order|Bestätigen|Confirm|\d{1,2}\s*Min\.?)$/i.test(normalizeText(row.label)))
    ) {
      return false;
    }
    return isCompactFlutterSemanticRecord(row) && !normalizeText(row && row.embeddedCardAction);
  }

  function embeddedAcceptClickPoint(rect) {
    const left = Number(rect && rect.left || 0);
    const top = Number(rect && rect.top || 0);
    const width = Number(rect && rect.width || 0);
    const height = Number(rect && rect.height || 0);
    return {
      x: Math.round(left + width * 0.43),
      y: Math.round(top + height - Math.min(28, Math.max(20, height * 0.09)))
    };
  }

  function selectEmbeddedActionRecord(records, orderNumber, actionName, viewportWidth, viewportHeight) {
    const maxWidth = Number(viewportWidth || 0) > 0 ? Number(viewportWidth) * 0.85 : Infinity;
    const maxHeight = Number(viewportHeight || 0) > 0 ? Number(viewportHeight) * 0.8 : Infinity;
    const candidates = (Array.isArray(records) ? records : []).filter(function (row) {
      const rect = row && row.rect ? row.rect : {};
      const width = Number(rect.width || 0);
      const height = Number(rect.height || 0);
      return row
        && row.element
        && !row.disabled
        && isEmbeddedActionLabel(row.label, orderNumber, actionName)
        && width >= 140
        && height >= 28
        && width <= maxWidth
        && height <= maxHeight;
    }).sort(function (a, b) {
      const areaA = Number(a.rect.width || 0) * Number(a.rect.height || 0);
      const areaB = Number(b.rect.width || 0) * Number(b.rect.height || 0);
      return areaA - areaB || a.label.length - b.label.length;
    });
    if (!candidates.length) return null;
    return { ...candidates[0], embeddedCardAction: actionName };
  }

  function formatOrderCode(value) {
    const number = normalizeText(value).replace(/^WOLT[-\s]*/i, '');
    return number ? `WOLT-${number}` : '';
  }

  function getTaskIdentity(task) {
    const internalId = normalizeText(firstValue(task && task.id, task && task.taskId, task && task.task_id));
    if (internalId) return `wolt:id:${internalId}`;
    const venue = normalizeText(firstValue(
      valueAt(task, 'venue.id'), valueAt(task, 'venueId'), valueAt(task, 'venueName'), valueAt(task, 'venue_name')
    )).toLowerCase();
    const daySource = firstValue(task && task.createdAt, task && task.created_at, task && task.preparationTargetTime);
    let day = '';
    try { day = new Date(daySource).toISOString().slice(0, 10); } catch (_) { }
    return `wolt:fallback:${venue}:${day}:${orderNumberOf(task)}`;
  }

  function getOrderDedupKey(task) {
    return getTaskIdentity(task);
  }

  function isTaskLike(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const hasOrder = !!orderNumberOf(value);
    const hasTaskShape = value.itemsByCategory != null
      || value.items_by_category != null
      || value.customer != null
      || value.dropOff != null
      || value.drop_off != null
      || value.status != null
      || value.items != null
      || value.delivery != null
      || value.delivery_info != null
      || value.deliveryInfo != null
      || value.address != null
      || value.price != null
      || value.total != null
      || value.totalPrice != null
      || value.total_price != null
      || value.orderPrice != null
      || value.order_price != null;
    return hasOrder && hasTaskShape;
  }

  function extractTasks(payload) {
    const found = [];
    const seenObjects = new Set();
    const seenTasks = new Set();

    function visit(value, depth) {
      if (!value || typeof value !== 'object' || depth > 10 || seenObjects.has(value)) return;
      seenObjects.add(value);
      if (isTaskLike(value)) {
        const key = getTaskIdentity(value) || formatOrderCode(orderNumberOf(value));
        if (!seenTasks.has(key)) {
          seenTasks.add(key);
          found.push(value);
        }
      }
      if (Array.isArray(value)) {
        for (const row of value) visit(row, depth + 1);
        return;
      }
      for (const key of Object.keys(value)) {
        const child = value[key];
        if (child && typeof child === 'object') visit(child, depth + 1);
      }
    }

    visit(payload, 0);
    return found;
  }

  function moneyToNumber(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object') {
      const raw = firstValue(value.amount, value.value, value.units, value.cents, value.centAmount);
      if (raw !== '') {
        const numeric = Number(raw);
        if (!Number.isFinite(numeric)) return moneyToNumber(raw);
        const multiplier = Number(value.multiplier);
        if (Number.isFinite(multiplier) && multiplier > 0) return numeric * multiplier;
        return Number.isInteger(numeric) ? numeric / 100 : numeric;
      }
      return null;
    }
    if (typeof value === 'string' && /[.,]\d{1,2}\b/.test(value)) {
      const cleaned = value.replace(/[^0-9,.-]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
      const parsed = Number(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Number.isInteger(numeric) ? numeric / 100 : numeric;
  }

  function formatMoney(value) {
    const numeric = moneyToNumber(value);
    if (numeric == null) return '';
    return `${numeric.toFixed(2).replace('.', ',')} €`;
  }

  function hasMoneyValue(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function zeroMoneyLike(reference) {
    return reference && typeof reference === 'object'
      ? { amount: 0, currency: reference.currency || 'EUR' }
      : 0;
  }

  function dateTimeText(value) {
    if (!value) return '';
    const directTime = String(value).match(/(?:^|T|\s)([01]?\d|2[0-3]):([0-5]\d)(?:\b|:)/);
    if (directTime && !/[zZ]|[+-]\d\d:?\d\d$/.test(String(value))) {
      return `${String(directTime[1]).padStart(2, '0')}:${directTime[2]}`;
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(date);
    } catch (_) {
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
  }

  function dateNoteText(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('de-DE', {
        timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric'
      }).format(date);
    } catch (_) {
      return `${String(date.getDate()).padStart(2, '0')}.${String(date.getMonth() + 1).padStart(2, '0')}.${date.getFullYear()}`;
    }
  }

  function collectItems(task) {
    const source = firstValue(task.itemsByCategory, task.items_by_category, task.items, []);
    const rows = [];

    function append(value, categoryName) {
      if (!value) return;
      if (Array.isArray(value)) {
        for (const row of value) append(row, categoryName);
        return;
      }
      if (typeof value !== 'object') return;
      if (Array.isArray(value.items)) {
        const nextCategory = normalizeText(firstValue(value.name, value.categoryName, categoryName));
        for (const row of value.items) append(row, nextCategory);
        return;
      }
      if (value.name != null && (value.count != null || value.quantity != null || value.price != null || value.menuItemId != null)) {
        rows.push(value);
        return;
      }
      for (const key of Object.keys(value)) {
        if (key === 'options' || key === 'identifiers') continue;
        const child = value[key];
        if (child && typeof child === 'object') append(child, categoryName || key);
      }
    }

    append(source, '');
    return rows;
  }

  function optionLabels(value, output, depth) {
    if (value == null || depth > 5) return;
    if (Array.isArray(value)) {
      for (const row of value) optionLabels(row, output, depth + 1);
      return;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const text = normalizeText(value);
      if (text) output.push(text);
      return;
    }
    if (typeof value !== 'object') return;
    const label = normalizeText(firstValue(value.name, value.label, value.title));
    const selectedValue = normalizeText(firstValue(value.value, value.selection, value.selectedValue));
    if (label && selectedValue && label !== selectedValue) output.push(`${label}: ${selectedValue}`);
    else if (label) output.push(label);
    else if (selectedValue) output.push(selectedValue);
    for (const key of ['options', 'values', 'items', 'children', 'selections']) {
      if (value[key] != null) optionLabels(value[key], output, depth + 1);
    }
  }

  function parseItemNameAndCode(item) {
    const rawName = normalizeText(firstValue(item.name, item.title, item.menuItemName));
    let code = normalizeText(firstValue(
      valueAt(item, 'identifiers.merchantSku'),
      valueAt(item, 'identifiers.merchant_sku'),
      valueAt(item, 'identifiers.sku'),
      item.merchantSku,
      item.merchant_sku,
      item.sku
    ));
    let name = rawName;
    if (!code && rawName) {
      const numbered = rawName.match(/^((?:[\p{L}]+[ -])?\d{1,4}[A-Za-z]?)\s*[.)-]?\s+(.+)$/u);
      if (numbered) {
        code = normalizeText(numbered[1]);
        name = normalizeText(numbered[2]);
      }
    }
    if (!code && Array.isArray(item.identifiers)) {
      const identifier = item.identifiers.find(function (row) {
        const type = normalizeText(firstValue(row && row.type, row && row.name, row && row.key)).toLowerCase();
        return /merchant.?sku|external.?id|product.?code|^sku$/.test(type);
      });
      code = normalizeText(firstValue(
        identifier && identifier.value,
        identifier && identifier.id,
        identifier && identifier.code
      ));
    }
    if (!code) code = rawName;
    return { code, name: name || rawName };
  }

  function buildAddress(task) {
    const dropOff = firstValue(task.dropOff, task.drop_off, task.deliveryInfo, task.delivery_info, {});
    const address = firstValue(dropOff.address, valueAt(task, 'deliveryInfo.address'), {});
    if (typeof address === 'string') return normalizeText(address);
    const streetName = normalizeText(firstValue(
      address.streetAddress, address.street_address, address.addressLine, address.address_line, address.street
    ));
    const houseNumber = normalizeText(firstValue(address.houseNumber, address.house_number));
    const street = normalizeText(`${streetName} ${houseNumber}`);
    const zip = normalizeText(firstValue(address.zipCode, address.zip_code, address.postalCode, address.postal_code));
    const city = normalizeText(firstValue(address.city, address.locality));
    const cityPart = normalizeText(`${zip} ${city}`);
    if (cityPart && street) return `${cityPart}, ${street}`;
    return normalizeText(firstValue(street, cityPart, dropOff.addressDetails, dropOff.address_details));
  }

  function joinUnique(values, separator) {
    const seen = new Set();
    const output = [];
    for (const value of values || []) {
      const text = stringValue(value);
      const key = text.toLowerCase();
      if (text && !seen.has(key)) {
        seen.add(key);
        output.push(text);
      }
    }
    return output.join(separator || ' | ');
  }

  function buildPayloadFromTask(task, options) {
    const opts = options || {};
    const customer = firstValue(task.customer, {});
    const dropOff = firstValue(task.dropOff, task.drop_off, task.deliveryInfo, task.delivery_info, {});
    const entranceRaw = firstValue(dropOff.entrance, valueAt(dropOff, 'address.entrance'), {});
    // entrance can be a plain string/number ("3") or an object with sub-fields
    const entrance = (entranceRaw && typeof entranceRaw === 'object') ? entranceRaw : {};
    // Eingang = the entrance/staircase number itself (e.g. "3" shown in Wolt UI)
    const eingangValue = normalizeText(firstValue(
      typeof entranceRaw === 'string' || typeof entranceRaw === 'number' ? entranceRaw : '',
      entrance.entrance, entrance.entranceCode, entrance.entrance_code,
      entrance.staircase, entrance.stairwayCode, entrance.stairway_code,
      dropOff.entranceCode, dropOff.entrance_code, dropOff.staircase
    ));
    const addressObject = typeof dropOff.address === 'object' && dropOff.address ? dropOff.address : {};
    const customerObject = customer && typeof customer === 'object' ? customer : {};
    const itemRows = collectItems(task).map(function (item) {
      const parsed = parseItemNameAndCode(item);
      const notes = [];
      optionLabels(firstValue(item.options, item.optionGroups, item.option_groups, item.selections), notes, 0);
      const comment = normalizeText(firstValue(item.comment, item.note, item.customerComment));
      if (comment) notes.push(comment);
      return {
        qty: normalizeText(firstValue(item.count, item.quantity, item.qty, 1)) || '1',
        code: parsed.code,
        name: parsed.name,
        note: joinUnique(notes, ', ')
      };
    }).filter(item => item.code || item.name);

    const pricing = firstValue(task.pricing, {});
    const totalValue = firstValue(pricing.total, task.orderPrice, task.order_price, task.totalPrice, task.total_price);
    const subtotalValue = firstValue(pricing.subtotal, task.subtotal, task.subTotal);
    let feeValue = firstValue(task.deliveryPrice, task.delivery_price, pricing.deliveryFee, pricing.delivery_fee, pricing.baseFee, pricing.fees);
    if (!hasMoneyValue(feeValue)) feeValue = zeroMoneyLike(totalValue);
    const targetTime = firstValue(
      task.preparationTargetTime,
      task.preparation_target_time,
      valueAt(task, 'deliveryInfo.deliveryTime'),
      valueAt(task, 'delivery_info.delivery_time'),
      task.pickupTime,
      task.deliveryTime
    );
    const createdAtMs = new Date(firstValue(task.createdAt, task.created_at, Date.now())).getTime();
    const targetTimeMs = targetTime ? new Date(targetTime).getTime() : 0;
    const isPreorder = isPreorderTask(task);

    let dateNote = normalizeText(firstValue(
      task.deliveryDateNote,
      task.delivery_date_note,
      task.scheduledDateNote,
      task.cardDateNote
    ));
    if (!dateNote && isPreorder && targetTimeMs && Number.isFinite(targetTimeMs)) {
      const targetDate = new Date(targetTimeMs);
      const createdDate = new Date(createdAtMs);
      if (targetDate.toDateString() !== createdDate.toDateString()) {
        dateNote = dateNoteText(targetTime);
      }
    }

    const dropNotes = Array.isArray(dropOff.notes) ? dropOff.notes : [dropOff.notes];
    const buildingName = normalizeText(firstValue(dropOff.buildingName, dropOff.building_name));
    const firmenName = normalizeText(firstValue(dropOff.companyName, dropOff.company_name, dropOff.firma));
    const apartment = normalizeText(firstValue(entrance.apartment, dropOff.apartment, addressObject.apartment, entrance.wohnung, dropOff.wohnung));
    const etage = normalizeText(firstValue(entrance.floor, dropOff.floor, entrance.etage, dropOff.etage));
    const codeHaus = normalizeText(firstValue(entrance.doorCode, entrance.door_code, dropOff.doorCode));
    const nameNummer = normalizeText(firstValue(
      entrance.nameOnDoor, entrance.name_on_door, entrance.intercomName, entrance.intercom_name,
      dropOff.nameOnDoor, dropOff.name_on_door, dropOff.intercomName
    ));
    const lieferanweisungen = joinUnique(dropNotes.concat([
      dropOff.deliveryInstructions,
      dropOff.delivery_instructions,
      dropOff.instructions
    ]));
    const additionalInfo = joinUnique([
      dropOff.addressDetails,
      dropOff.address_details,
      addressObject.additionalAddressInfo,
      addressObject.additional_address_info
    ]);
    const customerName = stringValue(firstValue(customerObject.name, customerObject.fullName, customerObject.full_name, customer));
    const payload = {
      source: 'wolt',
      capturedAt: new Date(opts.now || Date.now()).toISOString(),
      orderCode: formatOrderCode(orderNumberOf(task)),
      customerName,
      phone: normalizeText(firstValue(
        customerObject.phoneNumber,
        customerObject.phone_number,
        customerObject.phone,
        dropOff.phoneNumber,
        dropOff.phone_number,
        task.phoneNumber,
        task.phone
      )) || '01751559898',
      address: buildAddress(task),
      buildingName,
      firma: firmenName,
      eingang: eingangValue,
      floor: etage,
      apartment,
      hotel: '',
      codeHaus,
      nameNummer,
      additionalAddressInfo: additionalInfo,
      doorNote: lieferanweisungen,
      confirmationCode: normalizeText(firstValue(task.confirmationCode, task.confirmation_code)),
      paymentMethod: 'Online',
      deliveryTime: isPreorder && targetTime ? (dateTimeText(targetTime) || 'schnell wie möglich') : 'schnell wie möglich',
      additionalTime: '',
      acceptedAt: normalizeText(firstValue(task.createdAt, task.created_at)),
      customerNote: joinUnique([task.customerComment, task.customer_comment, customerObject.note]),
      postItemsNote: dateNote,
      deliveryDateNote: dateNote,
      cardDateNote: dateNote,
      scheduledDateNote: dateNote,
      subtotal: formatMoney(subtotalValue),
      deliveryFee: formatMoney(feeValue),
      total: formatMoney(totalValue),
      items: itemRows
    };
    return payload;
  }

  function validatePayload(payload) {
    const missing = [];
    if (!normalizeText(payload && payload.orderCode)) missing.push('mã đơn');
    if (!normalizeText(payload && payload.customerName)) missing.push('tên khách');
    if (!normalizeText(payload && payload.address)) missing.push('địa chỉ');
    if (!payload || !Array.isArray(payload.items) || !payload.items.length) missing.push('món ăn');
    if (!normalizeText(payload && payload.total)) missing.push('tổng tiền');
    return missing;
  }

  function normalizedStatus(task) {
    const raw = firstValue(task && task.status, task && task.state, valueAt(task, 'stateChangeInfo.status'));
    return normalizeText(stringValue(raw)).toLowerCase().replace(/[^a-z]/g, '');
  }

  function isIncomingTask(task) {
    const status = normalizedStatus(task);
    return status === 'waitingforapproval'
      || status === 'waitingforapprovalacknowledged';
  }

  function taskTimestamp(task) {
    const value = firstValue(task && task.createdAt, task && task.created_at, task && task.preparationTargetTime);
    const stamp = new Date(value).getTime();
    return Number.isFinite(stamp) ? stamp : 0;
  }

  function isPreorderTask(task) {
    const explicitFlag = firstValue(
      valueAt(task, 'preorder.isPreorder'),
      valueAt(task, 'preorder.is_preorder'),
      task && task.isPreorder,
      task && task.is_preorder,
      task && task.preOrder
    );
    if (explicitFlag !== '') {
      return explicitFlag === true || /^(?:true|1|yes)$/i.test(normalizeText(explicitFlag));
    }
    if (normalizedStatus(task) === 'confirmedpreorder') return true;

    const createdAtMs = new Date(firstValue(task && task.createdAt, task && task.created_at)).getTime();
    const targetTime = firstValue(
      task && task.preparationTargetTime,
      task && task.preparation_target_time,
      valueAt(task, 'deliveryInfo.deliveryTime'),
      valueAt(task, 'delivery_info.delivery_time'),
      task && task.pickupTime,
      task && task.deliveryTime
    );
    const targetTimeMs = new Date(targetTime).getTime();
    return Number.isFinite(createdAtMs)
      && Number.isFinite(targetTimeMs)
      && targetTimeMs - createdAtMs > 60 * 60 * 1000;
  }

  function isResumableWoltState(state) {
    return state === 'admin_confirmed' || state === 'accepted';
  }

  function start(win) {
    if (!win || !win.document || win.__thaiasiaWoltBridgeInstalled) return;
    win.__thaiasiaWoltBridgeInstalled = true;

    const tasksByIdentity = new Map();
    const pendingAdmin = new Map();
    const queuedIdentities = new Set();
    const stateCheckIdentities = new Set();
    const reconcileTimers = new Map();
    const lastProcessAt = new Map();
    const readyRetryAfter = new Map();
    let stateWriteQueue = Promise.resolve();
    let payloadSaveQueue = Promise.resolve();
    let statusElement = null;
    let manualBusy = false;
    let isSyntheticAction = false;

    const lastWoltBridgeState = {
      activeOrderNumber: '',
      activeTaskId: '',
      lastActionAttempted: '',
      lastActionStatus: '',
      lastError: '',
      updatedAt: ''
    };

    function updateBridgeState(patch) {
      Object.assign(lastWoltBridgeState, patch || {}, { updatedAt: new Date().toISOString() });
    }

    function getCssSelectorPath(el, maxDepth) {
      const limit = Number(maxDepth || 4);
      if (!el || !el.tagName) return '';
      const parts = [];
      let curr = el;
      let depth = 0;
      const rootDoc = el.ownerDocument || (typeof win !== 'undefined' ? win.document : null);
      while (curr && curr.tagName && (!rootDoc || curr !== rootDoc.documentElement) && depth < limit) {
        let desc = curr.tagName.toLowerCase();
        if (curr.id) {
          desc += `#${curr.id}`;
          parts.unshift(desc);
          break;
        }
        const role = curr.getAttribute && curr.getAttribute('role');
        if (role) {
          desc += `[role="${role}"]`;
        } else if (curr.classList && curr.classList.length) {
          const cls = Array.from(curr.classList).filter(c => !c.startsWith('flt-')).slice(0, 2).join('.');
          if (cls) desc += `.${cls}`;
        }
        parts.unshift(desc);
        curr = curr.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }

    function findNearestOrderMarker(el, records) {
      if (!el) return '';
      let curr = el;
      for (let depth = 0; depth < 5 && curr; depth++) {
        const text = normalizeText(curr.innerText || curr.textContent || '');
        const marker = extractOrderNumberMarker(text);
        if (marker) return marker;
        curr = curr.parentElement;
      }
      if (records && Array.isArray(records)) {
        const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (rect) {
          const clickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            const orderRows = records.filter(r => !!extractOrderNumberMarker(r.label));
          if (orderRows.length) {
            orderRows.sort((a, b) => {
              const aa = rowCenter(a);
              const bb = rowCenter(b);
              const da = Math.hypot(aa.x - clickCenter.x, aa.y - clickCenter.y);
              const db = Math.hypot(bb.x - clickCenter.x, bb.y - clickCenter.y);
              return da - db;
            });
            const best = orderRows[0];
            const marker = extractOrderNumberMarker(best.label);
            if (marker) return marker;
          }
        }
      }
      return '';
    }

    function installWoltManualActionTracker(targetWin) {
      const w = targetWin || win;
      if (!w || !w.document) return;
      const STORAGE_KEY = 'thaiasia_wolt_manual_actions';
      const MAX_STORED = 50;
      const POST_CLICK_DELAYS_MS = [300, 1200, 3000];
      let manualActionSequence = 0;

      function compactRect(rect) {
        if (!rect) return null;
        return {
          left: Math.round(Number(rect.left || 0)),
          top: Math.round(Number(rect.top || 0)),
          width: Math.round(Number(rect.width || 0)),
          height: Math.round(Number(rect.height || 0))
        };
      }

      function classifyManualAction(value) {
        const label = normalizeText(value);
        if (/^(?:Bestellung annehmen|Accept order|Annehmen)$/i.test(label)) return 'accept_order';
        if (/^(?:Best[aä]tigen|Confirm|Ja, best[aä]tigen|Yes, confirm)$/i.test(label)) return 'confirm';
        if (/^(?:Bereit|Ready|Als bereit markieren|Mark as ready)$/i.test(label)) return 'mark_ready';
        if (/^(?:Geliefert|Delivered)$/i.test(label)) return 'delivered';
        if (/^\d{1,3}\s*(?:Min\.?|Minuten?|Minutes?)$/i.test(label)) return 'delivery_time';
        return 'other';
      }

      function taskEvidenceForOrder(orderNumber) {
        const wanted = normalizeText(orderNumber);
        if (!wanted) return { found: false, status: '', identity: '' };
        for (const [identity, task] of tasksByIdentity.entries()) {
          if (!orderNumbersMatch(orderNumberOf(task), wanted)) continue;
          return {
            found: true,
            status: normalizedStatus(task),
            identity: normalizeText(identity).slice(0, 140)
          };
        }
        return { found: false, status: '', identity: '' };
      }

      function isUsefulEvidenceLabel(label, orderNumber) {
        const text = normalizeText(label);
        if (!text || text.length > 240) return false;
        if (classifyManualAction(text) !== 'other') return true;
        if (orderNumber && labelContainsOrderMarker(text, orderNumber)) return true;
        return /^(?:Neu|New|In Arbeit|In progress|Bereit|Ready|Wird geliefert|Being delivered)(?:\s*\(\d+\))?$/i.test(text);
      }

      function snapshotManualEvidence(orderNumber, clientX, clientY) {
        const records = semanticRecords();
        const visibleNumber = visibleOrderNumber(records);
        const resolvedOrderNumber = normalizeText(orderNumber || visibleNumber);
        const evidenceRows = records.filter(function (row) {
          if (isUsefulEvidenceLabel(row.label, resolvedOrderNumber)) return true;
          const rect = row && row.rect;
          if (!rect || !Number(rect.width) || !Number(rect.height)) return false;
          return clientX >= Number(rect.left) && clientX <= Number(rect.left) + Number(rect.width)
            && clientY >= Number(rect.top) && clientY <= Number(rect.top) + Number(rect.height)
            && normalizeText(row.label).length <= 240;
        }).sort(function (a, b) {
          const aa = Number(a.rect && a.rect.width || 0) * Number(a.rect && a.rect.height || 0);
          const bb = Number(b.rect && b.rect.width || 0) * Number(b.rect && b.rect.height || 0);
          return aa - bb || normalizeText(a.label).length - normalizeText(b.label).length;
        }).slice(0, 18).map(function (row) {
          return {
            label: normalizeText(row.label).slice(0, 240),
            actionKind: classifyManualAction(row.label),
            tagName: String(row.element && row.element.tagName || '').toLowerCase(),
            role: normalizeText(row.role),
            disabled: !!row.disabled,
            rect: compactRect(row.rect)
          };
        });
        const task = taskEvidenceForOrder(resolvedOrderNumber);
        return {
          visibleOrderNumber: visibleNumber,
          task,
          semanticActions: evidenceRows,
          semanticSignature: evidenceRows.map(function (row) {
            return `${row.actionKind}:${row.label}:${row.disabled ? 'disabled' : 'enabled'}`;
          }).join('|').slice(0, 1600),
          bridge: {
            activeOrderNumber: lastWoltBridgeState.activeOrderNumber || '',
            activeTaskId: lastWoltBridgeState.activeTaskId || '',
            lastActionAttempted: lastWoltBridgeState.lastActionAttempted || '',
            lastActionStatus: lastWoltBridgeState.lastActionStatus || '',
            lastError: normalizeText(lastWoltBridgeState.lastError).slice(0, 240)
          }
        };
      }

      function emitManualAction(actionData) {
        saveManualAction(actionData);
        console.warn('[ThaiAsiaDiag] ' + JSON.stringify(actionData));
        try {
          w.dispatchEvent(new CustomEvent('thaiasia-wolt-manual-action', { detail: actionData }));
        } catch (_) {}
      }

      function saveManualAction(actionEvent) {
        try {
          const raw = w.localStorage.getItem(STORAGE_KEY);
          const list = raw ? JSON.parse(raw) : [];
          list.push(actionEvent);
          if (list.length > MAX_STORED) list.splice(0, list.length - MAX_STORED);
          w.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
        } catch (_) {}
      }

      w.document.addEventListener('click', function onDocumentClick(e) {
        if (isSyntheticAction) return;
        try {
          const target = e.target;
          if (!target) return;

          // Bỏ qua click vào nút panel điều khiển
          if (target.closest && target.closest(`#${CONTROL_ID}`)) return;

          const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : {};
          const clientX = Math.round(Number(e.clientX || 0));
          const clientY = Math.round(Number(e.clientY || 0));
          const pageX = Math.round(Number(e.pageX || 0));
          const pageY = Math.round(Number(e.pageY || 0));
          const offsetX = Math.round(clientX - Number(rect.left || 0));
          const offsetY = Math.round(clientY - Number(rect.top || 0));

          const interactive = target.closest
            ? target.closest('button, [role="button"], flt-semantics[role="button"], a, input, [role="dialog"], [role="menuitem"]')
            : null;
          const interactiveRect = interactive && interactive.getBoundingClientRect ? interactive.getBoundingClientRect() : null;

          const records = semanticRecords();
          const nearestOrderNumber = findNearestOrderMarker(interactive || target, records);
          const timeDialogVisible = hasDeliveryTimeDialog(records);
          const visibleDialogs = records.filter(r => r.role === 'dialog' || /dialog|modal/i.test(r.role || '')).map(r => r.label.slice(0, 100));
          const targetText = normalizeText(
            interactive && (interactive.innerText || interactive.textContent)
            || target.innerText
            || target.textContent
            || target.getAttribute && target.getAttribute('aria-label')
            || ''
          );
          const actionKind = classifyManualAction(targetText);
          const manualActionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const actionSequence = ++manualActionSequence;
          const beforeEvidence = snapshotManualEvidence(nearestOrderNumber, clientX, clientY);

          const actionData = {
            v: 1,
            module: 'wolt',
            page: 'woltWin',
            eventType: 'wolt_manual_action',
            action: 'manual_click',
            manualActionId,
            actionSequence,
            actionKind,
            ts: new Date().toISOString(),
            pointer: {
              clientX,
              clientY,
              pageX,
              pageY,
              offsetX,
              offsetY,
              button: e.button
            },
            viewport: {
              innerWidth: Number(w.innerWidth || 0),
              innerHeight: Number(w.innerHeight || 0),
              scrollX: Math.round(Number(w.scrollX || 0)),
              scrollY: Math.round(Number(w.scrollY || 0))
            },
            target: {
              tagName: String(target.tagName || '').toLowerCase(),
              role: String(target.getAttribute && target.getAttribute('role') || ''),
              ariaLabel: String(target.getAttribute && target.getAttribute('aria-label') || '').slice(0, 160),
              className: String(target.className || '').slice(0, 160),
              id: String(target.id || ''),
              text: normalizeText(target.innerText || target.textContent || '').slice(0, 200),
              rect: {
                left: Math.round(Number(rect.left || 0)),
                top: Math.round(Number(rect.top || 0)),
                width: Math.round(Number(rect.width || 0)),
                height: Math.round(Number(rect.height || 0))
              },
              cssPath: getCssSelectorPath(target)
            },
            interactiveAncestor: interactive ? {
              tagName: String(interactive.tagName || '').toLowerCase(),
              role: String(interactive.getAttribute && interactive.getAttribute('role') || ''),
              ariaLabel: String(interactive.getAttribute && interactive.getAttribute('aria-label') || '').slice(0, 160),
              text: normalizeText(interactive.innerText || interactive.textContent || '').slice(0, 200),
              rect: interactiveRect ? {
                left: Math.round(Number(interactiveRect.left || 0)),
                top: Math.round(Number(interactiveRect.top || 0)),
                width: Math.round(Number(interactiveRect.width || 0)),
                height: Math.round(Number(interactiveRect.height || 0))
              } : null
            } : null,
            context: {
              nearestOrderNumber,
              activeOrderNumber: lastWoltBridgeState.activeOrderNumber || '',
              activeTaskId: lastWoltBridgeState.activeTaskId || '',
              lastActionAttempted: lastWoltBridgeState.lastActionAttempted || '',
              lastActionStatus: lastWoltBridgeState.lastActionStatus || '',
              timeDialogVisible,
              visibleDialogCount: visibleDialogs.length,
              visibleDialogs
            },
            before: beforeEvidence
          };

          emitManualAction(actionData);

          const targetDesc = actionData.interactiveAncestor?.text || actionData.target.text || actionData.target.ariaLabel || actionData.target.tagName || 'element';
          const orderSuffix = nearestOrderNumber ? ` (Đơn #${nearestOrderNumber})` : '';
          f12Log('WOLT_MANUAL', `👉 Klick thủ công [${targetDesc.slice(0, 40)}] tại (${clientX}, ${clientY})${orderSuffix}`, '#fff', '#8b5cf6');

          const afterStages = [];
          for (const delayMs of POST_CLICK_DELAYS_MS) {
            setTimeout(function capturePostClickEvidence() {
              try {
                const evidence = snapshotManualEvidence(nearestOrderNumber, clientX, clientY);
                afterStages.push({ delayMs, ...evidence });
                if (afterStages.length !== POST_CLICK_DELAYS_MS.length) return;
                afterStages.sort((a, b) => a.delayMs - b.delayMs);
                const finalEvidence = afterStages[afterStages.length - 1];
                const beforeTaskStatus = beforeEvidence.task && beforeEvidence.task.status || '';
                const finalTaskStatus = finalEvidence.task && finalEvidence.task.status || '';
                const targetStillVisible = finalEvidence.semanticActions.some(function (row) {
                  return actionKind !== 'other'
                    ? row.actionKind === actionKind
                    : normalizeText(row.label) === normalizeText(targetText);
                });
                emitManualAction({
                  v: 1,
                  module: 'wolt',
                  page: 'woltWin',
                  eventType: 'wolt_manual_action',
                  action: 'manual_click_result',
                  manualActionId,
                  actionSequence,
                  actionKind,
                  ts: new Date().toISOString(),
                  orderCode: nearestOrderNumber ? formatOrderCode(nearestOrderNumber) : '',
                  target: {
                    text: targetText.slice(0, 200),
                    tagName: actionData.target.tagName,
                    role: actionData.target.role,
                    ariaLabel: actionData.target.ariaLabel,
                    cssPath: actionData.target.cssPath
                  },
                  context: { nearestOrderNumber },
                  before: beforeEvidence,
                  after: afterStages,
                  outcomeEvidence: {
                    semanticChanged: beforeEvidence.semanticSignature !== finalEvidence.semanticSignature,
                    taskStatusChanged: beforeTaskStatus !== finalTaskStatus,
                    beforeTaskStatus,
                    finalTaskStatus,
                    targetStillVisible,
                    interveningManualClicks: Math.max(0, manualActionSequence - actionSequence)
                  }
                });
              } catch (_) {}
            }, delayMs);
          }
        } catch (err) {
          console.warn('[WoltBridge] Lỗi khi ghi nhận manual action:', err);
        }
      }, true);
    }

    function log(action, details) {
      try {
        console.log('[ThaiAsiaDiag]', JSON.stringify({
          v: 1,
          module: 'wolt',
          page: 'woltWin',
          eventType: 'order_activity',
          action,
          ts: new Date().toISOString(),
          ...(details || {})
        }));
      } catch (_) { }
    }

    function f12Log(tag, message, color = '#fff', bgColor = '#00838f') {
      try {
        const time = new Date().toLocaleTimeString();
        console.log(
          `%c ${tag} %c ${message} %c(${time})`,
          `background:${bgColor};color:${color};font-weight:bold;padding:2px 6px;border-radius:4px 0 0 4px;font-size:12px;`,
          `background:#1e293b;color:#f8fafc;font-weight:500;padding:2px 8px;font-size:12px;`,
          `background:#0f172a;color:#94a3b8;font-size:10px;padding:2px 6px;border-radius:0 4px 4px 0;`
        );
      } catch (_) { }
    }

    function setStatus(text, kind) {
      ensureControls();
      if (!statusElement) return;
      statusElement.textContent = String(text || '');
      statusElement.dataset.kind = kind || '';
    }

    function allRoots() {
      const roots = [];
      const seen = new Set();
      function visit(rootNode) {
        if (!rootNode || seen.has(rootNode)) return;
        seen.add(rootNode);
        roots.push(rootNode);
        let elements = [];
        try { elements = rootNode.querySelectorAll ? Array.from(rootNode.querySelectorAll('*')) : []; } catch (_) { }
        for (const element of elements) {
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      }
      visit(win.document);
      return roots;
    }

    function enableFlutterSemantics() {
      for (const rootNode of allRoots()) {
        let placeholders = [];
        try { placeholders = Array.from(rootNode.querySelectorAll('flt-semantics-placeholder')); } catch (_) { }
        for (const element of placeholders) {
          const previousSyntheticState = isSyntheticAction;
          isSyntheticAction = true;
          try { element.click(); } catch (_) { }
          finally { isSyntheticAction = previousSyntheticState; }
        }
      }
    }

    function semanticRecords() {
      try { enableFlutterSemantics(); } catch (_) { }
      const records = [];
      const seen = new Set();
      for (const rootNode of allRoots()) {
        let elements = [];
        try {
          elements = Array.from(rootNode.querySelectorAll('flt-semantics,[role],[aria-label],[aria-valuetext],button,h1,h2,h3,p'));
        } catch (_) { }
        for (const element of elements) {
          if (!element || element.closest && element.closest(`#${CONTROL_ID}`)) continue;
          const label = normalizeText(firstValue(
            element.getAttribute && element.getAttribute('aria-label'),
            element.getAttribute && element.getAttribute('aria-valuetext'),
            element.getAttribute && element.getAttribute('title'),
            element.textContent
          ));
          if (!label || label.length > 3000) continue;
          let rect = { left: 0, top: 0, width: 0, height: 0 };
          try { rect = element.getBoundingClientRect(); } catch (_) { }
          const key = `${label}\u0000${Math.round(rect.left || 0)}\u0000${Math.round(rect.top || 0)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          records.push({
            element,
            label,
            role: normalizeText(element.getAttribute && element.getAttribute('role')).toLowerCase(),
            disabled: !!(element.disabled || (element.getAttribute && element.getAttribute('aria-disabled') === 'true')),
            rect
          });
        }
      }
      return records;
    }

    function visibleOrderNumber(records) {
      const marker = records.some(row => /Adressangaben|Adressdetails|Address details|Zwischensumme|Subtotal|Anrufen|Call|Kundenservice|Customer service|Bestellung annehmen|Accept order|Beleg drucken|Print receipt|Name\s*\/\s*Nummer|Etage|Wohnung|In biên nhận|Tên\s*\/\s*Số|Sàn|Căn hộ|\bBereit\b|\bReady\b/i.test(row.label));
      if (!marker) return '';
      for (const row of records) {
        // Order number must contain at least one digit.
        // Match "Bestellnr. 123", "Bestellung Nr. 123", "Order no. 123", or standalone "#SIM-001" / "#123"
        const contextual = row.label.match(/(?:\bBestell(?:nr\.?|nummer)|\bBestellung\s+Nr\.?|\bOrder\s*(?:no\.?|number)?|\bTrật tự)\s*[:#.]?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/i);
        if (contextual) return normalizeText(contextual[1]).replace(/^WOLT-/i, '');
        const markerNumber = extractOrderNumberMarker(row.label);
        if (markerNumber) return markerNumber;
      }
      return '';
    }

    function ingestResponse(entry) {
      const body = entry && Object.prototype.hasOwnProperty.call(entry, 'body') ? entry.body : entry;
      const url = entry && entry.url ? entry.url : '';
      const tasks = extractTasks(body);
      const prevCount = tasksByIdentity.size;

      for (const task of tasks) {
        const identity = getTaskIdentity(task);
        if (!identity) continue;
        const isNew = !tasksByIdentity.has(identity);
        tasksByIdentity.set(identity, task);
        if (isIncomingTask(task)) {
          if (isNew) {
            const customerName = (task.customer && task.customer.name) || (task.consumer && task.consumer.name) || '';
            f12Log('WOLT', `📥 Phát hiện đơn mới: #${orderNumberOf(task)}${customerName ? ' (' + customerName + ')' : ''}`, '#000', '#00e5ff');
          }
          if (RUNTIME_POLICY.simulation) {
            setTimeout(function () {
              enqueue(task, { trigger: 'auto', force: true });
            }, 400);
          } else {
            enqueue(task, { trigger: 'auto' });
          }
        } else {
          // After an app update/restart, accepted orders are no longer
          // "incoming" in the Wolt API. Resume only when this exact task has
          // a persisted state proving that this app already created Admin.
          reconcilePersistedTask(task);
        }
      }
      if (tasks.length && tasksByIdentity.size !== prevCount) {
        setStatus(`Đã thấy ${tasksByIdentity.size} đơn Wolt`, 'ok');
        f12Log('WOLT', `📋 Cập nhật danh sách: ${tasksByIdentity.size} đơn Wolt trong hệ thống`, '#fff', '#0284c7');
        log('wolt_tasks_captured', { captured: tasks.length, cached: tasksByIdentity.size, url });
      }
    }

    async function readStates() {
      let rows = [];
      try { rows = await win.GM_getValue(WOLT_STATE_KEY, []); } catch (_) { }
      const now = Date.now();
      return (Array.isArray(rows) ? rows : []).filter(row => row && row.identity && now - Number(row.ts || 0) < STATE_TTL_MS);
    }

    function reconcilePersistedTask(task) {
      const identity = getTaskIdentity(task);
      if (!identity
        || stateCheckIdentities.has(identity)
        || queuedIdentities.has(identity)
        || reconcileTimers.has(identity)) return;
      stateCheckIdentities.add(identity);
      Promise.resolve().then(readStates).then(function (rows) {
        const prior = rows.find(row => row.identity === identity);
        if (!prior || !isResumableWoltState(prior.state)) return;
        log('wolt_persisted_state_resume_queued', {
          orderCode: formatOrderCode(orderNumberOf(task)),
          identity,
          state: prior.state
        });
        enqueue(task, { trigger: 'persisted_resume' });
      }).catch(function (error) {
        log('wolt_persisted_state_resume_failed', {
          identity,
          error: error && error.message ? error.message : String(error)
        });
      }).finally(function () {
        stateCheckIdentities.delete(identity);
      });
    }

    function writeState(identity, orderCode, state, details) {
      const operation = stateWriteQueue.then(async function () {
        const rows = await readStates();
        const next = rows.filter(row => row.identity !== identity);
        next.push({ identity, orderCode, state, ts: Date.now(), ...(details || {}) });
        await win.GM_setValue(WOLT_STATE_KEY, next.slice(-200));
      });
      stateWriteQueue = operation.catch(function () { });
      return operation;
    }

    function savePayload(payload, identity, policyOverride) {
      const operation = payloadSaveQueue.then(async function () {
        const safeCode = normalizeText(payload.orderCode).replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeIdentity = normalizeText(identity).replace(/[^a-zA-Z0-9_-]/g, '_').slice(-64);
        const storageKey = `${BRIDGE_STORAGE_KEY}_${safeCode}${safeIdentity ? `_${safeIdentity}` : ''}`;
        const finalPayload = buildStoredPayload(payload, identity, policyOverride || RUNTIME_POLICY, Date.now());
        await win.GM_setValue(storageKey, finalPayload);
        await win.GM_setValue(BRIDGE_ACTIVE_KEY, storageKey);
        let index = [];
        try { index = await win.GM_getValue(BRIDGE_INDEX_KEY, []); } catch (_) { }
        const nextIndex = (Array.isArray(index) ? index : [])
          .filter(row => row && row.key && row.key !== storageKey)
          .slice(0, 49);
        nextIndex.unshift({ key: storageKey, orderCode: payload.orderCode, updatedAt: Date.now() });
        await win.GM_setValue(BRIDGE_INDEX_KEY, nextIndex);
        return storageKey;
      });
      payloadSaveQueue = operation.catch(function () { });
      return operation;
    }

    function waitForAdmin(requestId, adminTab, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const timeoutMs = Math.max(1000, Number(opts.timeoutMs || ADMIN_TIMEOUT_MS));
      return new Promise(function (resolve) {
        const timeout = setTimeout(function () {
          pendingAdmin.delete(requestId);
          if (opts.closeOnTimeout !== false) {
            try { if (adminTab && typeof adminTab.close === 'function') adminTab.close(); } catch (_) { }
          }
          resolve({ ok: false, reason: 'timeout' });
        }, timeoutMs);
        pendingAdmin.set(requestId, function (result) {
          clearTimeout(timeout);
          pendingAdmin.delete(requestId);
          resolve(result || { ok: false, reason: 'empty_result' });
        });
      });
    }

    win.addEventListener('thaiasia-admin-submit-result', function (event) {
      const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
      const settle = pendingAdmin.get(String(detail.requestId || ''));
      if (settle) settle(detail);
    });

    function exactActionPattern(name) {
      if (name === 'accept') return /^(?:Bestellung annehmen|Accept order|Annehmen)(?:\s+\d+)?$/i;
      if (name === 'confirm') return /^(?:Bestätigen|Confirm|Ja, bestätigen|Yes, confirm)$/i;
      return /^(?:Bereit|Ready|Als bereit markieren|Mark as ready)$/i;
    }

    function isExplicitButtonRecord(row) {
      const tag = normalizeText(row && row.element && row.element.tagName).toLowerCase();
      return !!row && (row.role === 'button'
        || tag === 'button'
        || (row.element && row.element.getAttribute && row.element.getAttribute('role') === 'button')
        // Wolt Flutter exposes real action nodes such as "Bereit" only through
        // textContent. They have no role and no aria-label, but the manually
        // verified click target is still the compact FLT-SEMANTICS node itself.
        || isCompactFlutterSemanticRecord(row));
    }

    function rowCenter(row) {
      return {
        x: Number(row && row.rect && row.rect.left || 0) + Number(row && row.rect && row.rect.width || 0) / 2,
        y: Number(row && row.rect && row.rect.top || 0) + Number(row && row.rect && row.rect.height || 0) / 2
      };
    }

    function findActionRecord(records, name, orderNumber) {
      const pattern = exactActionPattern(name);

      // Never click a card/container merely because its text contains an action.
      // One Wolt card contains both the accept button and its three-dot menu.
      const candidates = records.filter(row => !row.disabled
        && isExplicitButtonRecord(row)
        && pattern.test(normalizeText(row.label)));
      if (!candidates.length) {
        if (name !== 'accept' && name !== 'ready') return null;

        // Flutter sometimes exposes the whole order card as one semantic node,
        // without a separate DOM node for "Bestellung annehmen" or "Bereit".
        // Use only the smallest card that contains this exact order marker and
        // ends with the requested action. Keep the click away from the
        // three-dot menu on the right.
        return selectEmbeddedActionRecord(
          records,
          orderNumber,
          name,
          Number(win.innerWidth || 0),
          Number(win.innerHeight || 0)
        );
      }
      if (candidates.length === 1) return candidates[0];

      // Prefer the exact button closest to the requested order card.
      const codeRows = records.filter(row => {
        const l = normalizeText(row.label);
        return l.length <= 600 && labelContainsOrderMarker(l, orderNumber);
      });
      const codeRow = codeRows.length ? codeRows.sort((a, b) => a.label.length - b.label.length)[0] : null;
      if (!codeRow) return candidates[0];
      const codeCenter = rowCenter(codeRow);
      return candidates.slice().sort((a, b) => {
        const aa = rowCenter(a); const bb = rowCenter(b);
        const da = Math.abs(aa.x - codeCenter.x) + Math.abs(aa.y - codeCenter.y);
        const db = Math.abs(bb.x - codeCenter.x) + Math.abs(bb.y - codeCenter.y);
        return da - db;
      })[0];
    }

    const DELIVERY_TIME_PREFERENCE = Object.freeze(['20', '25', '30', '15', '35', '40', '45', '60', '75', '10']);

    function actionTargetDetails(record) {
      const element = record && record.element;
      const rect = record && record.rect ? record.rect : {};
      return {
        label: normalizeText(record && record.label).slice(0, 160),
        role: normalizeText(record && record.role),
        tag: normalizeText(element && element.tagName).toLowerCase(),
        ariaLabel: normalizeText(element && element.getAttribute && element.getAttribute('aria-label')).slice(0, 160),
        center: clickPointForRecord(record, rect),
        rect: {
          left: Math.round(Number(rect.left || 0)),
          top: Math.round(Number(rect.top || 0)),
          width: Math.round(Number(rect.width || 0)),
          height: Math.round(Number(rect.height || 0))
        },
        embeddedCardAction: normalizeText(record && record.embeddedCardAction)
      };
    }

    function clickPointForRecord(record, rect) {
      const left = Number(rect && rect.left || 0);
      const top = Number(rect && rect.top || 0);
      const width = Number(rect && rect.width || 0);
      const height = Number(rect && rect.height || 0);
      if (record && record.embeddedCardAction) {
        return embeddedAcceptClickPoint(rect);
      }
      if (record && isCompactFlutterSemanticRecord(record)) {
        // Relative to the exact Flutter control, so zoom/card/window changes are safe.
        return {
          x: Math.round(left + width * 0.6),
          y: Math.round(top + height * 0.58)
        };
      }
      return {
        x: Math.round(left + width / 2),
        y: Math.round(top + height / 2)
      };
    }

    function hasDeliveryTimeDialog(records) {
      return records.some(function (row) {
        return /Wie lange brauchst du,? um die Bestellung vorzubereiten und zu liefern\?|Wie lange.*Bestellung.*vorzubereiten.*liefern|How long.*prepare.*deliver/i.test(normalizeText(row.label));
      }) || records.some(function (row) {
        return !row.disabled && isExplicitButtonRecord(row) && /^(10|15|20|25|30|35|40|45|60|75)\s*Min\.?$/i.test(normalizeText(row.label));
      });
    }

    function findDeliveryTimeOption(records) {
      if (!hasDeliveryTimeDialog(records)) return null;
      const options = records.filter(function (row) {
        return !row.disabled
          && isExplicitButtonRecord(row)
          && /^(10|15|20|25|30|35|40|45|60|75)\s*Min\.?$/i.test(normalizeText(row.label));
      });
      if (!options.length) return null;
      for (const minutes of DELIVERY_TIME_PREFERENCE) {
        const preferred = options.find(row => new RegExp(`^${minutes}\\s*Min\\.?$`, 'i').test(normalizeText(row.label)));
        if (preferred) return preferred;
      }
      return options[0];
    }

    function deliveryTimeOptionLabels(records) {
      return records.filter(row => !row.disabled
        && isExplicitButtonRecord(row)
        && /^\d{1,2}\s*Min\.?$/i.test(normalizeText(row.label)))
        .map(row => normalizeText(row.label))
        .slice(0, 12);
    }

    async function resolveDeliveryConfirmation(orderNumber, timeoutMs) {
      const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
      let selectedTime = false;
      let lastProbeKey = '';
      do {
        const records = semanticRecords();
        const timeDialogVisible = hasDeliveryTimeDialog(records);
        const confirm = findActionRecord(records, 'confirm', orderNumber);
        const timeOption = findDeliveryTimeOption(records);
        const options = deliveryTimeOptionLabels(records);
        const phase = confirm ? 'confirm_button' : timeOption ? 'time_selection' : timeDialogVisible ? 'time_dialog_unknown' : 'none';
        const probeKey = `${phase}|${options.join('|')}`;
        if (probeKey !== lastProbeKey) {
          lastProbeKey = probeKey;
          log('wolt_confirmation_probe', { orderNumber, phase, timeDialogVisible, options, confirmFound: !!confirm });
        }

        if (confirm) return { phase, confirm, timeDialogVisible, selectedTime };
        if (timeOption && !selectedTime) {
          const target = actionTargetDetails(timeOption);
          if (await clickRecord(timeOption, 'delivery_time_option')) {
            selectedTime = true;
            log('wolt_delivery_time_selected', { orderNumber, minutes: normalizeText(timeOption.label), target });
            await delay(800);
            continue;
          }
          return { phase: 'time_option_click_failed', timeDialogVisible, selectedTime };
        }
        if (Date.now() >= deadline) return { phase, timeDialogVisible, selectedTime };
        await delay(250);
      } while (true);
    }

    async function clickRecord(record, action, options) {
      if (!record || !record.element) return false;
      const clickOptions = options && typeof options === 'object' ? options : {};
      const element = record.element;
      const actionName = normalizeText(action || 'ui_control');
      const target = actionTargetDetails(record);
      log('wolt_click_attempt', { action: actionName, target });
      updateBridgeState({ lastActionAttempted: actionName, lastActionStatus: 'attempt' });
      isSyntheticAction = true;
      try {
        try { element.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }

        // Prefer the exact FLT-SEMANTICS node first. Some actions (Geliefert)
        // respond to its own click handler, while Bereit requires native click.
        if (!clickOptions.forceNative && shouldUseSemanticElementClick(record, actionName)) {
          element.click();
          log('wolt_click_dispatched', { action: actionName, method: 'semantic_element_click', target });
          updateBridgeState({ lastActionStatus: 'dispatched_semantic_element' });
          return true;
        }

        const rect = element.getBoundingClientRect();
        const point = clickPointForRecord(record, rect);
        const clientX = point.x;
        const clientY = point.y;

        // One click on the exact action control.
        if (typeof win.GM_simulateClick === 'function') {
          try {
            const nativeResult = await win.GM_simulateClick(clientX, clientY);
            const nativeOk = nativeResult === true || !!(nativeResult && nativeResult.ok === true);
            if (nativeOk) {
              const liveRect = element.getBoundingClientRect();
              log('wolt_click_dispatched', {
                action: actionName,
                method: 'native',
                target,
                nativeResult,
                actualPoint: { x: clientX, y: clientY },
                liveRect: {
                  left: Math.round(Number(liveRect.left || 0)),
                  top: Math.round(Number(liveRect.top || 0)),
                  width: Math.round(Number(liveRect.width || 0)),
                  height: Math.round(Number(liveRect.height || 0))
                }
              });
              updateBridgeState({ lastActionStatus: 'dispatched_native' });
              return true;
            }
            log('wolt_native_click_rejected', { action: actionName, target, nativeResult });
          } catch (error) {
            log('wolt_native_click_failed', {
              action: actionName,
              target,
              error: error && error.message ? error.message : String(error)
            });
          }
        }

        const eventInit = { bubbles: true, cancelable: true, view: win, clientX, clientY, pageX: clientX, pageY: clientY };
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          const EventCtor = type.startsWith('pointer') && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
          element.dispatchEvent(new EventCtor(type, eventInit));
        }
        try { element.click(); } catch (_) { }
        log('wolt_click_dispatched', { action: actionName, method: 'dom', target });
        updateBridgeState({ lastActionStatus: 'dispatched_dom' });
        return true;
      } catch (error) {
        try {
          element.click();
          log('wolt_click_dispatched', {
            action: actionName,
            method: 'dom_fallback',
            target,
            fallbackReason: error && error.message ? error.message : String(error)
          });
          updateBridgeState({ lastActionStatus: 'dispatched_dom_fallback' });
          return true;
        } catch (_) {
          log('wolt_click_failed', { action: actionName, target, error: error && error.message ? error.message : String(error) });
          updateBridgeState({ lastActionStatus: 'failed', lastError: String(error) });
          return false;
        }
      } finally {
        setTimeout(function () { isSyntheticAction = false; }, 120);
      }
    }

    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async function waitForTaskStatus(identity, predicate, timeoutMs) {
      const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
      do {
        const latest = tasksByIdentity.get(identity);
        const status = normalizedStatus(latest);
        if (status && predicate(status, latest)) return status;
        if (Date.now() >= deadline) break;
        await delay(300);
      } while (true);
      return '';
    }

    async function waitForAction(name, orderNumber, timeoutMs) {
      const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
      do {
        const records = semanticRecords();
        const record = findActionRecord(records, name, orderNumber);
        if (record) return record;
        if (Date.now() >= deadline) break;
        await delay(250);
      } while (true);
      return null;
    }

    async function waitForSemanticState(orderNumber, state, timeoutMs) {
      const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
      do {
        const records = semanticRecords();
        if (orderNumbersMatch(visibleOrderNumber(records), orderNumber)) {
          if (state === 'accepted' && findActionRecord(records, 'ready', orderNumber)) return true;
          if (state === 'ready' && records.some(function (row) {
            if (row.role === 'button') return false;
            return /Bereit zur Abholung|Abholbereit|Bereit seit|Ready for pickup|Marked ready/i.test(row.label);
          })) return true;
        }
        if (Date.now() >= deadline) break;
        await delay(300);
      } while (true);
      return false;
    }

    function readySemanticEvidence(records, orderNumber) {
      if (!orderNumbersMatch(visibleOrderNumber(records), orderNumber)) return '';
      const delivered = records.find(function (row) {
        return !row.disabled
          && isExplicitButtonRecord(row)
          && /^(?:Geliefert|Delivered)$/i.test(normalizeText(row.label));
      });
      if (delivered) return 'delivered_button';
      const readyState = records.find(function (row) {
        if (row.role === 'button') return false;
        return /Bereit zur Abholung|Abholbereit|Bereit seit|Ready for pickup|Marked ready/i.test(normalizeText(row.label));
      });
      return readyState ? 'ready_state_text' : '';
    }

    async function waitForReadyConfirmation(identity, orderNumber, timeoutMs) {
      const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
      do {
        const status = normalizedStatus(tasksByIdentity.get(identity));
        if (/^(completed|deliveryinprogress|delivered)$/.test(status)) {
          return { confirmed: true, source: 'api', status };
        }
        const semanticSource = readySemanticEvidence(semanticRecords(), orderNumber);
        if (semanticSource) return { confirmed: true, source: semanticSource, status };
        if (Date.now() >= deadline) break;
        await delay(300);
      } while (true);
      return { confirmed: false, source: '', status: normalizedStatus(tasksByIdentity.get(identity)) };
    }

    function findOrderDetailClose(records, orderNumber) {
      const detailRecord = records.find(function (row) {
        const label = normalizeText(row.label);
        const hasCode = labelContainsOrderMarker(label, orderNumber);
        return hasCode && /Kundenservice.*Bestellung|Customer service.*order|Adressangaben|Address details/i.test(label);
      });
      if (!detailRecord) return null;
      const closeButtons = records.filter(row => !row.disabled
        && isExplicitButtonRecord(row)
        && /^(?:×|Schließen|Close)$/i.test(normalizeText(row.label)));
      if (!closeButtons.length) return null;
      const detailCenter = rowCenter(detailRecord);
      return closeButtons.slice().sort((a, b) => {
        const aa = rowCenter(a); const bb = rowCenter(b);
        const da = Math.abs(aa.x - detailCenter.x) + Math.abs(aa.y - detailCenter.y);
        const db = Math.abs(bb.x - detailCenter.x) + Math.abs(bb.y - detailCenter.y);
        return da - db;
      })[0];
    }

    async function openOrderDetail(task) {
      const orderNumber = orderNumberOf(task);
      let records = semanticRecords();
      if (orderNumbersMatch(visibleOrderNumber(records), orderNumber)) return true;

      const codeRows = records.filter(row => {
        const l = normalizeText(row.label);
        return labelContainsOrderMarker(l, orderNumber);
      });
      if (!codeRows.length) return false;
      const codeRow = codeRows[0];
      let target = codeRows.find(row => row.role === 'button');
      if (!target) {
        try {
          const button = codeRow.element.closest('[role="button"],button');
          if (button) target = { ...codeRow, element: button, role: 'button' };
        } catch (_) { }
      }
      if (!target) {
        const viewButtons = records.filter(row => /^(Bestellung ansehen|View order)$/i.test(row.label) && !row.disabled);
        if (viewButtons.length) {
          const codeY = Number(codeRow.rect.top || 0) + Number(codeRow.rect.height || 0) / 2;
          target = viewButtons.slice().sort((a, b) => {
            const ay = Number(a.rect.top || 0) + Number(a.rect.height || 0) / 2;
            const by = Number(b.rect.top || 0) + Number(b.rect.height || 0) / 2;
            return Math.abs(ay - codeY) - Math.abs(by - codeY);
          })[0];
        }
      }
      if (!target) target = codeRow;
      if (!target || !clickRecord(target)) return false;
      await delay(900);
      records = semanticRecords();
      return orderNumbersMatch(visibleOrderNumber(records), orderNumber);
    }

    async function performActions(task, previousState) {
      if (!RUNTIME_POLICY.woltActions) return 'admin_preview';
      if (previousState === 'ready') return previousState;
      const identity = getTaskIdentity(task);
      const orderNumber = orderNumberOf(task);
      updateBridgeState({ activeOrderNumber: orderNumber, activeTaskId: identity, lastActionAttempted: 'perform_order_progression', lastActionStatus: 'started' });
      const initialStatus = normalizedStatus(tasksByIdentity.get(identity) || task);
      if (/^(rejected|cancelled|cancelledwaitingforacknowledgement)$/.test(initialStatus)) {
        setStatus(`${formatOrderCode(orderNumber)}: Wolt đã hủy/từ chối, không bấm thêm`, 'warn');
        return 'terminal';
      }
      const alreadyAcceptedByApi = /^(pending|started|collected|completed|confirmedpreorder|waitingforcourierpickupestimate|deliveryinprogress|delivered)$/.test(initialStatus);
      const alreadyReadyByApi = /^(completed|deliveryinprogress|delivered)$/.test(initialStatus);
      if (alreadyReadyByApi) return 'ready';

      let records = semanticRecords();

      // Only dismiss this order's details dialog. Do not close the delivery-time
      // confirmation dialog, which may also include a close icon.
      const detailClose = findOrderDetailClose(records, orderNumber);
      if (detailClose) {
        await clickRecord(detailClose, 'order_detail_close');
        log('wolt_order_detail_closed', { orderNumber });
        await delay(400);
        records = semanticRecords();
      }

      let acceptedNow = alreadyAcceptedByApi || previousState === 'accepted';
      let attemptedWoltAction = false;
      let confirmation = await resolveDeliveryConfirmation(orderNumber, 0);
      let confirm = confirmation.confirm;
      let accept = acceptedNow ? null : findActionRecord(records, 'accept', orderNumber);
      let focusToken = null;

      const finishAndRestore = async (nextState) => {
        if (focusToken && focusToken.prevWindowId && typeof win.GM_restoreWindowFocus === 'function') {
          try {
            await win.GM_restoreWindowFocus(focusToken);
            log('wolt_focus_restored', { orderNumber, prevWindowId: focusToken.prevWindowId });
          } catch (_) {}
          focusToken = null;
        }
        return nextState;
      };

      // Nếu đơn chưa nhận và chưa thấy nút (Flutter có thể đang ngủ trong nền):
      if (!acceptedNow && !accept && !confirm && !confirmation.timeDialogVisible) {
        // Bước 3: Đánh thức nhẹ (Gentle Wake) - không cướp bàn phím
        if (typeof win.GM_wakeWoltRenderer === 'function') {
          log('wolt_gentle_wake_triggered', { orderNumber });
          try { await win.GM_wakeWoltRenderer({ action: 'gentle_wake', orderNumber }); } catch (_) {}
        }
        try { enableFlutterSemantics(); } catch (_) {}
        await delay(800);
        records = semanticRecords();
        confirmation = await resolveDeliveryConfirmation(orderNumber, 0);
        confirm = confirmation.confirm;
        accept = findActionRecord(records, 'accept', orderNumber);

        // Bước 4: Nếu sau gentle wake vẫn chưa thấy nút và semantic tree quá ít phần tử (< 10)
        if (!accept && !confirm && !confirmation.timeDialogVisible && records.length < 10) {
          if (typeof win.GM_wakeWoltRenderer === 'function') {
            log('wolt_force_focus_triggered', { orderNumber, semanticCount: records.length });
            try {
              focusToken = await win.GM_wakeWoltRenderer({ action: 'force_focus', orderNumber });
            } catch (_) {}
            await delay(600);
            try { enableFlutterSemantics(); } catch (_) {}
            await delay(600);
            records = semanticRecords();
            confirmation = await resolveDeliveryConfirmation(orderNumber, 0);
            confirm = confirmation.confirm;
            accept = findActionRecord(records, 'accept', orderNumber);
          }
        }
      }

      log('wolt_action_probe', {
        orderNumber,
        previousState,
        alreadyAcceptedByApi,
        acceptFound: !!accept,
        confirmFound: !!confirm,
        confirmationPhase: confirmation.phase,
        semanticCount: records.length,
        candidateLabels: records.filter(r => r.role === 'button' || r.label.includes(orderNumber)).map(r => r.label).slice(0, 10)
      });

      // If a delivery-time dialog is already visible, resolve it with a timeout.
      if (!confirm && confirmation.timeDialogVisible) {
        confirmation = await resolveDeliveryConfirmation(orderNumber, 4000);
        confirm = confirmation.confirm;
        attemptedWoltAction = attemptedWoltAction || confirmation.selectedTime;
      }

      // A visible confirmation belongs to a prior Accept. Confirm it first;
      // never click the card again while that dialog is open.
      if (confirm) {
        f12Log('WOLT', `⏱️ Xác nhận thời gian Wolt (${confirm.label}) cho đơn #${orderNumber}`, '#fff', '#d97706');
        if (await clickRecord(confirm, 'delivery_time_confirm')) {
          attemptedWoltAction = true;
          log('wolt_confirm_clicked', { orderNumber, label: confirm.label });
          await delay(800);
        }
      } else if (!confirmation.timeDialogVisible && accept) {
        f12Log('WOLT', `🖱️ Bấm nút "Bestellung annehmen" trên thẻ #${orderNumber}`, '#fff', '#0284c7');
        const clicked = await clickRecord(accept, 'accept_order');
        if (clicked) {
          attemptedWoltAction = true;
          log('wolt_accept_clicked', { orderNumber, label: accept.label });
          await delay(800);
          confirmation = await resolveDeliveryConfirmation(orderNumber, 4000);
          confirm = confirmation.confirm;
          attemptedWoltAction = attemptedWoltAction || confirmation.selectedTime;
          if (confirm && await clickRecord(confirm, 'delivery_time_confirm')) {
            log('wolt_confirm_clicked', { orderNumber, label: confirm.label });
            await delay(800);
          } else if (!confirm) {
            log('wolt_confirmation_unresolved', {
              orderNumber,
              phase: confirmation.phase,
              timeDialogVisible: confirmation.timeDialogVisible,
              selectedTime: confirmation.selectedTime
            });
          }
        }
      } else if (confirmation.timeDialogVisible) {
        log('wolt_confirmation_unresolved', {
          orderNumber,
          phase: confirmation.phase,
          timeDialogVisible: true,
          selectedTime: confirmation.selectedTime
        });
      }

      if (attemptedWoltAction && !acceptedNow) {
        const acceptedStatus = await waitForTaskStatus(identity, function (status) {
          return /^(pending|started|collected|completed|confirmedpreorder|waitingforcourierpickupestimate|deliveryinprogress|delivered)$/.test(status);
        }, 6500);
        acceptedNow = !!acceptedStatus || await waitForSemanticState(orderNumber, 'accepted', 1500);
      }

      if (!acceptedNow) {
        setStatus(`${formatOrderCode(orderNumber)}: chưa xác minh Wolt đã nhận đơn, sẽ thử lại`, 'warn');
        log('wolt_accept_unconfirmed', { orderNumber, attemptedWoltAction, acceptFound: !!accept, confirmFound: !!confirm });
        return finishAndRestore('admin_confirmed');
      }

      const isPreorder = isPreorderTask(task);

      // Pre-orders do not show Bereit upon creation. Mark as accepted only when confirmed.
      if (isPreorder && acceptedNow) {
        setStatus(`${formatOrderCode(orderNumber)}: Đã gửi Admin & Wolt đã nhận đơn đặt trước`, 'ok');
        f12Log('WOLT', `🎉 Nhận đơn đặt trước thành công: #${orderNumber}`, '#fff', '#059669');
        return finishAndRestore('accepted');
      }

      const ready = await waitForAction('ready', orderNumber, acceptedNow ? 5000 : 1000);
      const readyCandidates = ready ? [] : semanticRecords().filter(function (row) {
        return isEmbeddedActionLabel(row.label, orderNumber, 'ready');
      }).map(function (row) {
        return {
          ...actionTargetDetails(row),
          disabled: !!row.disabled,
          explicitButton: isExplicitButtonRecord(row)
        };
      }).slice(0, 6);
      log('wolt_ready_probe', {
        orderNumber,
        found: !!ready,
        target: ready ? actionTargetDetails(ready) : null,
        candidates: readyCandidates
      });
      if (ready) {
        const retryAt = Number(readyRetryAfter.get(identity) || 0);
        if (Date.now() < retryAt) {
          setStatus(`${formatOrderCode(orderNumber)}: Wolt đã nhận đơn; chờ lần thử Bereit an toàn tiếp theo`, 'warn');
          return finishAndRestore('accepted');
        }
        // Do not repeat a failed UI dispatch on every reconciliation cycle.
        readyRetryAfter.set(identity, Date.now() + 30000);
        f12Log('WOLT', `🍽️ Bấm nút "Bereit" cho đơn #${orderNumber}`, '#fff', '#ea580c');
        const readyClicked = await clickRecord(ready, 'mark_ready');
        if (readyClicked) {
          let confirmation = await waitForReadyConfirmation(identity, orderNumber, 1400);

          // Live order #090 proved that element.click() can be dispatched on
          // the exact Bereit node while Flutter ignores it. Retry once with
          // trusted Electron input, but only while the same action still exists.
          if (!confirmation.confirmed) {
            const currentReady = findActionRecord(semanticRecords(), 'ready', orderNumber);
            if (currentReady && typeof win.GM_simulateClick === 'function') {
              log('wolt_ready_native_fallback', {
                orderNumber,
                reason: 'semantic_click_unconfirmed',
                target: actionTargetDetails(currentReady)
              });
              await clickRecord(currentReady, 'mark_ready_native_fallback', { forceNative: true });
              confirmation = await waitForReadyConfirmation(identity, orderNumber, 6500);
            }
          }

          log('wolt_ready_confirmation', {
            orderNumber,
            confirmed: confirmation.confirmed,
            source: confirmation.source,
            status: confirmation.status
          });
          if (confirmation.confirmed) {
            readyRetryAfter.delete(identity);
            setStatus(`${formatOrderCode(orderNumber)}: Admin xong, Wolt đã xác nhận Bereit`, 'ok');
            f12Log('WOLT', `🎉 Hoàn tất đơn #${orderNumber} (xác nhận Bereit thành công)`, '#fff', '#059669');
            return finishAndRestore('ready');
          }
          setStatus(`${formatOrderCode(orderNumber)}: chưa xác minh được nút Bereit, sẽ thử lại`, 'warn');
          return finishAndRestore('accepted');
        }
      }

      if (acceptedNow) {
        setStatus(`${formatOrderCode(orderNumber)}: Wolt đã nhận đơn; đang chờ Bereit`, 'ok');
        f12Log('WOLT', `🎉 Nhận đơn #${orderNumber} thành công!`, '#fff', '#059669');
        return finishAndRestore('accepted');
      }

      setStatus(`Đã gửi ${formatOrderCode(orderNumber)} vào Admin`, 'ok');
      return finishAndRestore('admin_confirmed');
    }

    async function processOrder(task, options) {
      const opts = options || {};
      const identity = getTaskIdentity(task);
      const orderCode = formatOrderCode(orderNumberOf(task));

      const states = await readStates();
      const prior = states.find(row => row.identity === identity);
      if (prior && (prior.state === 'ready' || prior.state === 'terminal')) {
        return { ok: true, duplicate: true, state: prior.state };
      }

      // Retry Wolt-only work after Admin succeeded. This covers renderer reloads,
      // missed confirmations, and a delayed Bereit button without re-opening Admin.
      if (prior && isResumableWoltState(prior.state)) {
        const nextState = await performActions(task, prior.state);
        await writeState(identity, orderCode, nextState, { storageKey: prior.storageKey || '' });
        if (nextState !== 'ready' && nextState !== 'terminal') scheduleReconcile(identity);
        log('wolt_order_reconciled', {
          orderCode,
          identity,
          fromState: prior.state,
          state: nextState,
          isPreorder: isPreorderTask(task),
          trigger: opts.trigger || 'auto'
        });
        return { ok: true, state: nextState, resumed: true };
      }

      // If task is already accepted on Wolt and has no matching Admin state,
      // never open Admin for it.
      if (!opts.force && !isIncomingTask(task)) {
        log('wolt_task_already_accepted_skip_admin', { orderCode, status: normalizedStatus(task) });
        return { ok: true, skipped: true };
      }

      const startTime = Date.now();
      const payload = buildPayloadFromTask(task);
      const missing = validatePayload(payload);
      if (missing.length) {
        const message = `${orderCode || 'Đơn Wolt'} thiếu: ${missing.join(', ')}`;
        setStatus(message, 'error');
        f12Log('ERROR', `❌ ${message}`, '#fff', '#dc2626');
        log('wolt_payload_invalid', { orderCode, missing, rawTask: task });
        throw new Error(message);
      }

      win.__thaiasiaOrderProcessing = true;
      const isManual = opts.trigger === 'manual';
      const manualPolicy = isManual ? { ...RUNTIME_POLICY, autoFill: true, autoSubmit: false } : RUNTIME_POLICY;
      setStatus(isManual ? `Đang mở Admin điền đơn ${orderCode} (chế độ thủ công)…` : `Đang mở Admin điền đơn ${orderCode}…`, 'busy');
      f12Log('ADMIN', isManual ? `🚀 Đang mở Admin nổi điền đơn: ${orderCode} (dừng ở Submit)` : `🚀 Đang mở tab Admin để điền đơn: ${orderCode}`, '#fff', '#2563eb');
      const storageKey = await savePayload(payload, identity, manualPolicy);

      if (isManual) {
        win.GM_openInTab(ADMIN_URL, {
          storageKey,
          show: true
        });
        setStatus(`Đã mở Admin điền đơn ${orderCode} (chế độ thủ công - dừng ở Submit)`, 'ok');
        win.__thaiasiaOrderProcessing = false;
        return { ok: true, state: 'admin_preview', manual: true };
      }

      if (RUNTIME_POLICY.waitForAdminAck) {
        await writeState(identity, orderCode, 'admin_pending', { storageKey });
      }
      const opened = win.GM_openInTab(ADMIN_URL, {
        storageKey,
        show: false
      });
      const requestId = opened && opened.requestId ? String(opened.requestId) : '';
      let adminResult = { ok: false, reason: 'skipped_wait' };
      if (RUNTIME_POLICY.waitForAdminAck) {
        adminResult = await waitForAdmin(requestId, opened, { timeoutMs: ADMIN_TIMEOUT_MS });
        log('wolt_admin_ack', {
          orderCode,
          identity,
          requestId,
          adminResult,
          durationMs: Date.now() - startTime
        });
        if (!adminResult || !adminResult.ok) {
          const reason = (adminResult && adminResult.reason) || 'unknown';
          const message = reason === 'timeout'
            ? `${orderCode}: Chờ Admin xác nhận quá lâu, vui lòng kiểm tra tab Admin.`
            : `${orderCode}: Admin submit chưa thành công (${reason}).`;
          await writeState(identity, orderCode, 'admin_failed', { storageKey, failureReason: reason });
          setStatus(message, 'warn');
          f12Log('ADMIN', `❌ ${message}`, '#fff', '#dc2626');
          win.__thaiasiaOrderProcessing = false;
          return { ok: false, state: 'admin_failed', reason };
        }
      }

      await writeState(identity, orderCode, 'admin_confirmed', { storageKey });
      f12Log('ADMIN', `✅ Admin đã Submit thành công đơn: ${orderCode}`, '#fff', '#16a34a');
      setStatus(`Admin đã xong ${orderCode}, đang bấm nhận trên Wolt…`, 'busy');
      const nextState = await performActions(task, 'admin_confirmed');
      await writeState(identity, orderCode, nextState, { storageKey });
      if (nextState !== 'ready' && nextState !== 'terminal') scheduleReconcile(identity);
      const durationMs = Date.now() - startTime;
      log('wolt_order_processed', {
        orderCode,
        identity,
        state: nextState,
        isPreorder: isPreorderTask(task),
        trigger: opts.trigger || 'auto',
        durationMs
      });
      win.__thaiasiaOrderProcessing = false;
      return { ok: true, state: nextState };
    }

    function scheduleReconcile(identity) {
      if (!identity || reconcileTimers.has(identity)) return;
      const timer = setTimeout(function () {
        reconcileTimers.delete(identity);
        const latest = tasksByIdentity.get(identity);
        if (latest) enqueue(latest, { trigger: 'reconcile' });
      }, 6000);
      reconcileTimers.set(identity, timer);
    }

    function enqueue(task, options) {
      const identity = getTaskIdentity(task);
      const opts = options || {};
      if (!identity || queuedIdentities.has(identity)) return;
      const now = Date.now();
      if (!opts.force && (opts.trigger === 'auto' || opts.trigger === 'reconcile' || opts.trigger === 'persisted_resume')
        && now - Number(lastProcessAt.get(identity) || 0) < 5000) return;
      const pendingReconcile = reconcileTimers.get(identity);
      if (pendingReconcile) {
        clearTimeout(pendingReconcile);
        reconcileTimers.delete(identity);
      }
      lastProcessAt.set(identity, now);
      queuedIdentities.add(identity);
      Promise.resolve().then(function () {
        return processOrder(task, opts);
      }).catch(function (error) {
        setStatus(error && error.message ? error.message : String(error), 'error');
        log('wolt_process_error', { identity, error: error && error.message ? error.message : String(error) });
      }).finally(function () {
        queuedIdentities.delete(identity);
        win.__thaiasiaOrderProcessing = queuedIdentities.size > 0;
      });
    }

    function chooseManualTask(records) {
      const visibleNumber = visibleOrderNumber(records);
      if (visibleNumber) {
        for (const task of tasksByIdentity.values()) {
          if (orderNumbersMatch(orderNumberOf(task), visibleNumber)) return task;
        }
      }
      const incoming = Array.from(tasksByIdentity.values()).filter(isIncomingTask).sort((a, b) => taskTimestamp(b) - taskTimestamp(a));
      for (const task of incoming) {
        const num = orderNumberOf(task);
        if (!num) continue;
        const cleanNum = num.replace(/^0+/, '');
        const matched = records.some(row => {
          const l = normalizeText(row.label);
          return l === `#${num}` || l === num || (cleanNum && (l === `#${cleanNum}` || l === cleanNum)) || l.includes(`#${num}`);
        });
        if (matched) return task;
      }
      if (incoming.length === 1) return incoming[0];
      if (RUNTIME_POLICY.simulation && incoming.length > 0) return incoming[0];
      return null;
    }

    async function manualCapture(event) {
      if (manualBusy) return;
      manualBusy = true;
      try {
        enableFlutterSemantics();
        await delay(250);
        const network = win.__thaiasiaWoltNetwork;
        if (network && typeof network.refreshTasks === 'function') {
          const refreshed = await network.refreshTasks();
          if (!refreshed.ok && refreshed.status === 401) {
            setStatus('Phiên đăng nhập Wolt đã hết hạn; hãy đăng nhập lại.', 'error');
            return;
          }
        }
        if (network && typeof network.getResponses === 'function') {
          for (const response of network.getResponses()) ingestResponse(response);
        }
        let records = semanticRecords();
        let task = chooseManualTask(records);

        // Retry logic: when order detail is visible but no API data found yet,
        // wait and retry up to 3 times to let API responses arrive.
        if (!task) {
          const visibleNumber = visibleOrderNumber(records);
          if (visibleNumber) {
            const retryDelays = [800, 1500, 2500];
            for (let attempt = 0; attempt < retryDelays.length; attempt++) {
              setStatus(`Đang chờ dữ liệu API cho đơn #${visibleNumber}… (${attempt + 1}/${retryDelays.length})`, 'busy');
              await delay(retryDelays[attempt]);
              if (network && typeof network.refreshTasks === 'function') {
                await network.refreshTasks();
              }
              if (network && typeof network.getResponses === 'function') {
                for (const response of network.getResponses()) ingestResponse(response);
              }
              records = semanticRecords();
              task = chooseManualTask(records);
              if (task) break;
            }
          }
        }

        if (!task) {
          const hasVisible = !!visibleOrderNumber(records);
          setStatus(hasVisible
            ? 'Không tìm được dữ liệu API cho đơn này. Thử tải lại trang Wolt rồi mở lại đơn.'
            : 'Hãy mở chi tiết một đơn Wolt rồi bấm "Lấy đơn Wolt".', 'warn');
          log('wolt_manual_capture_no_task', {
            hasVisible,
            visibleNumber: visibleOrderNumber(records),
            cachedTasks: tasksByIdentity.size,
            cachedTaskNumbers: Array.from(tasksByIdentity.values()).map(orderNumberOf).filter(Boolean).join(',')
          });
          return;
        }
        enqueue(task, { trigger: 'manual', force: true });
      } finally {
        manualBusy = false;
      }
    }

    function ensureControls() {
      const existing = win.document.getElementById(CONTROL_ID);
      if (existing) {
        statusElement = existing.querySelector('[data-wolt-status]');
        return existing;
      }
      const host = win.document.createElement('div');
      host.id = CONTROL_ID;
      host.title = 'Bấm giữ chuột vào khoảng trắng để kéo di chuyển panel';
      const buttonLabel = '📋 Lấy đơn Wolt';
      const initialStatus = 'Đang chờ dữ liệu đơn…';
      host.innerHTML = `<button type="button" data-wolt-manual>${buttonLabel}</button><span data-wolt-status>${initialStatus}</span>`;
      const style = win.document.createElement('style');
      style.textContent = `
        #${CONTROL_ID}{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:9px;max-width:min(520px,calc(100vw - 36px));padding:8px 12px;background:#fff;border:1px solid #d8e1ea;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.24);font:600 13px/1.35 Arial,sans-serif;color:#182230;cursor:grab;user-select:none;touch-action:none}
        #${CONTROL_ID}:active{cursor:grabbing}
        #${CONTROL_ID} button{appearance:none;border:0;border-radius:9px;padding:9px 13px;background:#00c2e8;color:#002c3b;font:700 13px Arial,sans-serif;cursor:pointer;white-space:nowrap}
        #${CONTROL_ID} button:hover{background:#19d2f2}
        #${CONTROL_ID} [data-wolt-status]{font-weight:600;overflow:hidden;text-overflow:ellipsis}
        #${CONTROL_ID} [data-wolt-status][data-kind="error"]{color:#b42318}
        #${CONTROL_ID} [data-wolt-status][data-kind="warn"]{color:#9a6700}
        #${CONTROL_ID} [data-wolt-status][data-kind="ok"]{color:#087443}
        @media(max-width:720px){#${CONTROL_ID}{left:10px;right:10px;bottom:10px;max-width:none;flex-wrap:wrap}#${CONTROL_ID} [data-wolt-status]{flex:1 1 100%}}
      `;
      host.appendChild(style);
      const parent = win.document.body || win.document.documentElement;
      if (!parent) return null;
      parent.appendChild(host);
      statusElement = host.querySelector('[data-wolt-status]');
      host.querySelector('[data-wolt-manual]').addEventListener('click', manualCapture);

      // Kéo thả panel tự do trên màn hình
      let isDragging = false;
      let startX = 0, startY = 0;
      let initialLeft = 0, initialTop = 0;

      host.addEventListener('mousedown', function (e) {
        if (e.target.tagName === 'BUTTON' || (e.target.closest && e.target.closest('button'))) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = host.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        host.style.bottom = 'auto';
        host.style.right = 'auto';
        host.style.left = initialLeft + 'px';
        host.style.top = initialTop + 'px';
      });

      win.document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const newLeft = Math.max(8, Math.min(win.innerWidth - host.offsetWidth - 8, initialLeft + dx));
        const newTop = Math.max(8, Math.min(win.innerHeight - host.offsetHeight - 8, initialTop + dy));
        host.style.left = newLeft + 'px';
        host.style.top = newTop + 'px';
      });

      win.document.addEventListener('mouseup', function () {
        isDragging = false;
      });

      return host;
    }

    const network = win.__thaiasiaWoltNetwork;
    if (network && typeof network.getResponses === 'function') {
      for (const response of network.getResponses()) ingestResponse(response);
    }
    if (network && typeof network.subscribe === 'function') {
      network.subscribe(ingestResponse);
    } else {
      win.addEventListener('thaiasia-wolt-api-response', function (event) { ingestResponse(event.detail); });
    }

    if (win.document.readyState === 'loading') {
      win.document.addEventListener('DOMContentLoaded', ensureControls, { once: true });
    } else {
      ensureControls();
    }
    try {
      let controlRepairTimer = null;
      new MutationObserver(function () {
        if (controlRepairTimer) return;
        controlRepairTimer = setTimeout(function () {
          controlRepairTimer = null;
          ensureControls();
        }, 250);
      }).observe(win.document.documentElement, { childList: true, subtree: true });
    } catch (_) { }
    setInterval(ensureControls, 2000);
    setTimeout(enableFlutterSemantics, 1200);
    installWoltManualActionTracker(win);
    installWoltAutoLogin(win);
    f12Log('WOLT-BRIDGE', '🚀 ThaiAsia Wolt Bridge đã khởi động và sẵn sàng!', '#000', '#00e5ff');
    log('wolt_web_bridge_started', { href: String(win.location && win.location.href || '') });
  }

  function installWoltAutoLogin(win) {
    const USERNAME = 'thaiss';
    const PASSWORD = 'z35x9hwkyb';
    const doc = win.document;

    function triggerSemantics() {
      try {
        const placeholders = doc.querySelectorAll('flt-semantics-placeholder');
        for (let i = 0; i < placeholders.length; i++) placeholders[i].click();
      } catch (_) {}
    }

    function setFieldValue(input, val) {
      if (!input || val === undefined || val === null) return;
      try {
        input.focus();
        input.value = val;
        if (input._valueTracker) {
          try { input._valueTracker.setValue(''); } catch (_) {}
        }
        try {
          const proto = input instanceof HTMLInputElement ? win.HTMLInputElement.prototype : Object.getPrototypeOf(input);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(input, val);
        } catch (_) {}

        try {
          input.select();
          doc.execCommand('selectAll', false, null);
          doc.execCommand('insertText', false, val);
        } catch (_) {}

        input.value = val;
        if (input._valueTracker) {
          try { input._valueTracker.setValue(val); } catch (_) {}
        }

        input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: val, bubbles: true, composed: true }));
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: val, bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } catch (_) {}
    }

    let lastActionAt = 0;

    function tryAutoLogin() {
      triggerSemantics();

      const userInput = doc.querySelector('input[aria-label="Benutzername"]')
        || Array.from(doc.querySelectorAll('input, flt-semantics')).find(el => (el.getAttribute('aria-label') || '').trim() === 'Benutzername');

      const passInput = doc.querySelector('input[aria-label="Passwort"]')
        || Array.from(doc.querySelectorAll('input, flt-semantics')).find(el => (el.getAttribute('aria-label') || '').trim() === 'Passwort');

      const submitBtn = Array.from(doc.querySelectorAll('flt-semantics, button, [role="button"], input[type="submit"]')).find(el => {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase().trim();
        const txt = (el.textContent || el.innerText || '').toLowerCase().trim();
        return aria === 'einloggen' || txt === 'einloggen' || aria.includes('einloggen') || txt.includes('einloggen');
      }) || (passInput && passInput.parentElement ? passInput.parentElement.nextElementSibling : null);

      if (userInput && passInput) {
        setFieldValue(userInput, USERNAME);
        setFieldValue(passInput, PASSWORD);
      }
    }

    setTimeout(tryAutoLogin, 2500);
  }

  return {
    normalizeText,
    extractTasks,
    getTaskIdentity,
    getOrderDedupKey,
    orderNumberOf,
    orderNumbersMatch,
    labelContainsOrderMarker,
    isEmbeddedAcceptLabel,
    isEmbeddedActionLabel,
    isCompactFlutterSemanticRecord,
    shouldUseSemanticElementClick,
    extractOrderNumberMarker,
    embeddedAcceptClickPoint,
    selectEmbeddedActionRecord,
    isPreorderTask,
    isResumableWoltState,
    formatOrderCode,
    moneyToNumber,
    formatMoney,
    collectItems,
    buildPayloadFromTask,
    validatePayload,
    normalizedStatus,
    isIncomingTask,
    RUNTIME_POLICY,
    buildStoredPayload,
    start
  };
});
