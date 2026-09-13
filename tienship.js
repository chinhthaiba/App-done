// ==UserScript==
// @name         Thai Asia - Daily Completed Orders Report
// @namespace    thaiasia-tools
// @version      1.0.0
// @description  Theo dõi đơn hoàn thành và gửi báo cáo email lúc 21:00 mỗi ngày
// @author       OpenAI
// @match        https://www.api.thaiasiasushibar.de/admin/orders*
// @grant        GM_xmlhttpRequest
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // main.js inject script sau mỗi dom-ready. Guard đặt trên window để cùng một
  // document không thể vô tình tạo nhiều bộ timer/listener gửi báo cáo.
  const SCRIPT_INSTANCE_KEY = '__thaiasiaDailyReportV2';
  if (window[SCRIPT_INSTANCE_KEY]) {
    console.warn('[ThaiAsia Daily Report] Bỏ qua lần inject trùng trong cùng document');
    return;
  }
  window[SCRIPT_INSTANCE_KEY] = {
    loadedAt: new Date().toISOString(),
  };

  const CONFIG = {
    REPORT_HOUR: 19,
    REPORT_MINUTE: 47,
    DEADLINE_HOUR: 23,
    DEADLINE_MINUTE: 55,
    SCAN_INTERVAL_MS: 60 * 1000,
    SEND_CHECK_INTERVAL_MS: 60 * 1000,
    STORAGE_KEY: 'thaiasia_completed_orders_history_v1',
    LAST_SENT_KEY: 'thaiasia_completed_orders_last_sent_date_v1',
    RELOAD_FLAG_KEY: 'thaiasia_reload_before_send_v1',
    SEND_STATE_KEY: 'thaiasia_daily_report_send_state_v2',
    SEND_LOG_KEY: 'thaiasia_daily_report_send_log_v2',
    SEND_TIMEOUT_MS: 90 * 1000,
    MAX_SEND_LOG_ENTRIES: 30,
    FULL_PAGE_URL: 'https://www.api.thaiasiasushibar.de/admin/orders?per_page=9999',
    WEBHOOK_URL: 'https://script.google.com/macros/s/AKfycbw9s3gtCP7xe9SLwJ_ARYr_aMx2W7FghE7bttd4kzachxwBpzC0ujHo39CSgvMDESOQ/exec',
    REPORT_EMAIL: 'chinthaiba2@gmail.com',
    DEBUG: true,
  };

  // ====== BACKGROUND-SAFE TIMER (Web Worker) ======
  // Tạo Web Worker inline để timer không bị throttle khi tab ở background
  function createWorkerTimer(callbackFn, intervalMs) {
    const blob = new Blob([
      `let tid; onmessage = function(e) { if (e.data === 'start') { tid = setInterval(() => postMessage('tick'), ${intervalMs}); } else if (e.data === 'stop') { clearInterval(tid); } };`
    ], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      const worker = new Worker(url);
      worker.onmessage = () => callbackFn();
      worker.postMessage('start');
      return worker;
    } catch (e) {
      // Fallback nếu Worker không được hỗ trợ (CSP chặn)
      console.warn('[ThaiAsia] Web Worker không khả dụng, dùng setInterval fallback');
      setInterval(callbackFn, intervalMs);
      return null;
    }
  }

  function log(...args) {
    if (CONFIG.DEBUG) {
      console.log('[ThaiAsia Daily Report]', ...args);
    }
  }

  function emitDiag(action, payload) {
    try {
      const row = {
        v: 1,
        module: 'tienship',
        page: 'tienShipWin',
        eventType: 'order_activity',
        action,
        ts: new Date().toISOString(),
        ...(payload || {})
      };
      console.warn('[ThaiAsiaDiag] ' + JSON.stringify(row));
    } catch (_) {}
  }

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeName(text) {
    const v = normalizeText(text);
    return v || 'No Name';
  }

  function parseMoney(text) {
    const raw = normalizeText(text).replace(',', '.');
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : 0;
  }

  function getTodayLocalDateString(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseDateFromCell(text) {
    // Expected like: 2026-03-26 19:06:36
    const cleaned = normalizeText(text);
    if (!cleaned) return null;

    const parts = cleaned.split(' ');
    if (parts.length < 1) return null;

    const datePart = parts[0];
    const timePart = parts[1] || '00:00:00';

    const iso = `${datePart}T${timePart}`;
    const dt = new Date(iso);

    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }

  function getTable() {
    return document.querySelector('.table-responsive table, .box-body table, table');
  }

  function getHeaderMap(table) {
    const map = {};
    const headerCells = table.querySelectorAll('thead th');
    headerCells.forEach((th, index) => {
      const txt = normalizeText(th.innerText);
      map[txt] = index;
    });
    return map;
  }

  function findHeaderIndex(headerMap, candidates) {
    for (const candidate of candidates) {
      for (const key of Object.keys(headerMap)) {
        if (normalizeText(key).toLowerCase().includes(candidate.toLowerCase())) {
          return headerMap[key];
        }
      }
    }
    return -1;
  }

  function extractOrdersFromTable() {
    const table = getTable();
    if (!table) {
      log('Không tìm thấy table');
      return [];
    }

    const headerMap = getHeaderMap(table);

    const codeIdx = findHeaderIndex(headerMap, ['Code']);
    const shippingMethodIdx = findHeaderIndex(headerMap, ['Shipping method']);
    const totalIdx = findHeaderIndex(headerMap, ['Total']);
    const shippingFeeIdx = findHeaderIndex(headerMap, ['Shipping fee', 'Phí ship', 'Phi ship']);
    const statusIdx = findHeaderIndex(headerMap, ['Trạng thái', 'Trang thai']);
    const completedByIdx = findHeaderIndex(headerMap, ['Hoàn thành bởi', 'Hoan thanh boi']);
    const completedTimeIdx = findHeaderIndex(headerMap, ['Thời gian HT', 'Thoi gian HT']);
    const createdDateIdx = findHeaderIndex(headerMap, ['Ngày tạo', 'Ngay tao']);

    const required = [codeIdx, shippingMethodIdx, totalIdx, statusIdx];
    if (required.some(i => i < 0)) {
      log('Thiếu cột cần thiết', {
        codeIdx,
        shippingMethodIdx,
        totalIdx,
        statusIdx,
        completedByIdx,
        completedTimeIdx,
        createdDateIdx,
        headerMap,
      });
      return [];
    }

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const orders = [];

    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (!cells || !cells.length) continue;

      const code = normalizeText(cells[codeIdx]?.innerText);
      const shippingMethod = normalizeText(cells[shippingMethodIdx]?.innerText);
      const totalText = normalizeText(cells[totalIdx]?.innerText);
      const status = normalizeText(cells[statusIdx]?.innerText);
      const shippingFeeText = shippingFeeIdx >= 0 ? normalizeText(cells[shippingFeeIdx]?.innerText) : '';
      const completedBy = completedByIdx >= 0 ? normalizeName(cells[completedByIdx]?.innerText) : 'No Name';
      const completedTimeText = completedTimeIdx >= 0 ? normalizeText(cells[completedTimeIdx]?.innerText) : '';
      const createdDateText = createdDateIdx >= 0 ? normalizeText(cells[createdDateIdx]?.innerText) : '';

      if (!code) continue;

      orders.push({
        code,
        shippingMethod,
        total: parseMoney(totalText),
        totalText,
        shippingFee: parseMoney(shippingFeeText),
        shippingFeeText,
        status,
        completedBy,
        completedTimeText,
        createdDateText,
      });
    }

    return orders;
  }

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '{}');
    } catch (e) {
      log('loadHistory error', e);
      return {};
    }
  }

  function saveHistory(history) {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(history));
  }

  function isCompletedOrder(order) {
    const status = normalizeText(order.status).toLowerCase();
    return status.includes('hoàn thành') || status.includes('hoan thanh');
  }

  // Đơn hoàn thành hoặc hủy đều được coi là "done"
  function isDoneOrder(order) {
    const status = normalizeText(order.status).toLowerCase();
    return status.includes('hoàn thành') || status.includes('hoan thanh') || status.includes('hủy') || status.includes('huy');
  }

  function isDoneFull(orders) {
    // 0/0 = done full, 10/10 = done full, 8/9 = NOT done full
    if (orders.length === 0) return true;
    return orders.every(o => isDoneOrder(o));
  }

  function mergeOrdersIntoHistory(orders) {
    const history = loadHistory();
    let changed = false;

    for (const order of orders) {
      // Xác định ngày: ưu tiên completedTimeText, sau đó createdDateText, cuối cùng là hôm nay
      let orderDateStr;
      if (order.completedTimeText) {
        const dt = parseDateFromCell(order.completedTimeText);
        orderDateStr = dt ? getTodayLocalDateString(dt) : null;
      }
      if (!orderDateStr && order.createdDateText) {
        const dt = parseDateFromCell(order.createdDateText);
        orderDateStr = dt ? getTodayLocalDateString(dt) : null;
      }
      if (!orderDateStr) {
        orderDateStr = getTodayLocalDateString();
      }

      const uniqueKey = `${orderDateStr}__${order.code}`;

      const existing = history[uniqueKey];
      const nextData = {
        code: order.code,
        shippingMethod: order.shippingMethod,
        total: order.total,
        totalText: order.totalText,
        shippingFee: order.shippingFee || 0,
        shippingFeeText: order.shippingFeeText || '',
        status: order.status,
        completedBy: order.completedBy || 'No Name',
        completedTimeText: order.completedTimeText,
        createdDateText: order.createdDateText || '',
        completedDateStr: orderDateStr,
        updatedAt: new Date().toISOString(),
      };

      if (JSON.stringify(existing) !== JSON.stringify(nextData)) {
        history[uniqueKey] = nextData;
        changed = true;
      }
    }

    if (changed) {
      saveHistory(history);
      log('Đã cập nhật history', history);
    }
  }

  function getOrdersFromHistory(targetDate) {
    const history = loadHistory();
    return Object.values(history).filter(item => item.completedDateStr === targetDate);
  }

  function getLatestDateFromHistory() {
    const history = loadHistory();
    const dates = Object.values(history).map(item => item.completedDateStr).filter(Boolean);
    if (!dates.length) return null;
    return dates.sort().reverse()[0];
  }

  function getLatestOrdersFromHistory() {
    const today = getTodayLocalDateString();
    const todayOrders = getOrdersFromHistory(today);
    if (todayOrders.length > 0) return { date: today, orders: todayOrders };

    // Nếu hôm nay chưa có đơn, lấy ngày gần nhất có dữ liệu
    const latestDate = getLatestDateFromHistory();
    if (!latestDate) return { date: today, orders: [] };

    return { date: latestDate, orders: getOrdersFromHistory(latestDate) };
  }

  function groupByCompletedBy(orders) {
    const grouped = {};

    for (const order of orders) {
      const name = normalizeName(order.completedBy);
      if (!grouped[name]) {
        grouped[name] = {
          completedBy: name,
          orders: [],
          totalAmount: 0,
        };
      }

      grouped[name].orders.push(order);
      grouped[name].totalAmount += Number(order.total || 0);
    }

    return grouped;
  }

  function isTableLoading() {
    // Kiểm tra bảng đang loading (spinner hoặc 0 entries)
    const loadingEl = document.querySelector('.loading, .spinner, .dataTables_processing');
    if (loadingEl && loadingEl.offsetParent !== null) return true;
    // Kiểm tra "Showing to of 0 entries"
    const infoEl = document.querySelector('.dataTables_info, .showing-info');
    if (infoEl && /showing.*0\s*entries/i.test(infoEl.textContent)) return true;
    // Kiểm tra có tbody nhưng không có row nào
    const table = getTable();
    if (table) {
      const rows = table.querySelectorAll('tbody tr');
      if (rows.length === 0) return true;
      // Kiểm tra tất cả row đều trống (chỉ có loading indicator)
      const hasData = Array.from(rows).some(r => r.querySelectorAll('td').length > 1);
      if (!hasData) return true;
    }
    return false;
  }

  function buildPayload() {
    // CHỈ lấy từ bảng trên trang — KHÔNG fallback sang history/cache
    const orders = extractOrdersFromTable();
    const reportDate = getTodayLocalDateString();

    const completedOrders = orders.filter(o => isCompletedOrder(o));
    const pendingOrders = orders.filter(o => !isCompletedOrder(o));
    const grouped = groupByCompletedBy(completedOrders);
    const htmlBody = buildEmailHtml(reportDate, orders, completedOrders, pendingOrders, grouped);

    return {
      reportDate,
      email: CONFIG.REPORT_EMAIL,
      generatedAt: new Date().toISOString(),
      totalOrders: orders.length,
      completedCount: completedOrders.length,
      pendingCount: pendingOrders.length,
      grouped,
      orders,
      completedOrders,
      pendingOrders,
      htmlBody,
    };
  }

  function buildEmailHtml(reportDate, allOrders, completedOrders, pendingOrders, grouped) {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cellStyle = 'border:1px solid #ccc;padding:6px 10px;text-align:left;';
    const headerStyle = cellStyle + 'background:#f0f0f0;font-weight:bold;';
    const doneLabel = `Done ${completedOrders.length}/${allOrders.length}`;

    const formatZeit = (raw) => {
      const dt = parseDateFromCell(raw);
      if (!dt) return raw || '-';
      const hh = String(dt.getHours()).padStart(2, '0');
      const mm = String(dt.getMinutes()).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      const mo = String(dt.getMonth() + 1).padStart(2, '0');
      const yy = dt.getFullYear();
      return `${hh}:${mm}, ${dd}.${mo}.${yy}`;
    };

    let html = '<div style="font-family:Arial,sans-serif;font-size:14px;">';
    const dateDisplay = reportDate.split('-').reverse().join('.');
    html += `<h2>Bestellbericht vom ${esc(dateDisplay)}</h2>`;
    html += `<p style="font-size:18px;"><b>${doneLabel}</b></p>`;
    html += `<p>Erledigt: <b>${completedOrders.length}</b> | Offen: <b>${pendingOrders.length}</b> | Gesamt: <b>${allOrders.length}</b></p>`;

    // --- Bảng theo từng người (chỉ đơn hoàn thành) ---
    const sortedNames = Object.keys(grouped).sort((a, b) => {
      if (a === 'No Name' || a === 'Không xác định') return 1;
      if (b === 'No Name' || b === 'Không xác định') return -1;
      return a.localeCompare(b);
    });

    for (const name of sortedNames) {
      const group = grouped[name];
      const displayName = (name === 'No Name') ? 'Không xác định' : name;
      const totalAmount = group.totalAmount.toFixed(2);
      const isUnknown = (name === 'No Name' || name === 'Không xác định');
      const unknownHeaderBg = isUnknown ? 'background:#ff8a65;color:#fff;padding:6px 12px;border-radius:4px;display:inline-block;' : '';
      const unknownRowBg = isUnknown ? 'background:#fff3e0;' : '';
      html += isUnknown
        ? `<h3 style="${unknownHeaderBg}">⚠️ ${esc(displayName)} - ${group.orders.length} Bestellung - Summe: ${totalAmount}</h3>`
        : `<h3>${esc(displayName)} - ${group.orders.length} Bestellung - Summe: ${totalAmount}</h3>`;
      html += '<table style="border-collapse:collapse;width:100%;margin-bottom:16px;">';
      html += '<tr>';
      html += `<th style="${headerStyle}">Code</th>`;
      html += `<th style="${headerStyle}">Total</th>`;
      html += `<th style="${headerStyle}">Shipping method</th>`;
      html += `<th style="${headerStyle}">Status</th>`;
      html += `<th style="${headerStyle}">Zeit</th>`;
      html += '</tr>';
      for (const o of group.orders) {
        html += `<tr style="${unknownRowBg}">`;
        html += `<td style="${cellStyle}${isUnknown ? 'color:#d84315;font-weight:bold;' : ''}">${esc(o.code)}</td>`;
        html += `<td style="${cellStyle}">${esc(o.totalText || o.total)}</td>`;
        html += `<td style="${cellStyle}">${esc(o.shippingMethod)}</td>`;
        html += `<td style="${cellStyle}">${esc(o.status)}</td>`;
        html += `<td style="${cellStyle}">${esc(formatZeit(o.completedTimeText))}</td>`;
        html += '</tr>';
      }
      html += '</table>';

      // --- Tiền ship từng đơn ---
      const shipLines = group.orders.map(o => `${esc(o.code)} . ${esc(o.totalText || o.total)}`);
      const totalShip = group.orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
      html += `<p style="margin:4px 0 16px 0;font-size:13px;color:#555;">`;
      html += `<b>${esc(displayName)} ${dateDisplay}</b><br>`;
      html += shipLines.join('<br>');
      html += `<br><b>Summe: ${totalShip.toFixed(2)}</b>`;
      html += `</p>`;
    }

    // --- Đơn chưa hoàn thành ---
    if (pendingOrders.length > 0) {
      html += `<h3 style="background:#d32f2f;color:#fff;padding:6px 12px;border-radius:4px;display:inline-block;">🔴 Offen - ${pendingOrders.length} Bestellung</h3>`;
      html += '<table style="border-collapse:collapse;width:100%;margin-bottom:16px;">';
      html += '<tr>';
      html += `<th style="${headerStyle}">Code</th>`;
      html += `<th style="${headerStyle}">Total</th>`;
      html += `<th style="${headerStyle}">Shipping method</th>`;
      html += `<th style="${headerStyle}">Status</th>`;
      html += `<th style="${headerStyle}">Erstellt am</th>`;
      html += '</tr>';
      for (const o of pendingOrders) {
        html += '<tr style="background:#ffcdd2;">';
        html += `<td style="${cellStyle}font-weight:bold;">${esc(o.code)}</td>`;
        html += `<td style="${cellStyle}">${esc(o.totalText || o.total)}</td>`;
        html += `<td style="${cellStyle}">${esc(o.shippingMethod)}</td>`;
        html += `<td style="${cellStyle}color:#d32f2f;font-weight:bold;">${esc(o.status)}</td>`;
        html += `<td style="${cellStyle}">${esc(o.createdDateText || '')}</td>`;
        html += '</tr>';
      }
      html += '</table>';
    }

    // --- Bảng tổng hợp toàn bộ ---
    html += `<h3>Alle Bestellungen (${doneLabel})</h3>`;
    html += '<table style="border-collapse:collapse;width:100%;margin-bottom:16px;">';
    html += '<tr>';
    html += `<th style="${headerStyle}">Code</th>`;
    html += `<th style="${headerStyle}">Shipping method</th>`;
    html += `<th style="${headerStyle}">Total</th>`;
    html += `<th style="${headerStyle}">Status</th>`;
    html += `<th style="${headerStyle}">Erledigt von</th>`;
    html += `<th style="${headerStyle}">Zeit</th>`;
    html += '</tr>';
    const sortedOrders = [...allOrders].sort((a, b) => {
      const codeA = parseInt(a.code, 10) || 0;
      const codeB = parseInt(b.code, 10) || 0;
      return codeA - codeB;
    });
    for (const o of sortedOrders) {
      const isCompleted = isCompletedOrder(o);
      const completedByDisplay = (o.completedBy === 'No Name') ? 'Không xác định' : (o.completedBy || 'Không xác định');
      const isUnknownCompleter = isCompleted && (o.completedBy === 'No Name' || !o.completedBy || o.completedBy === 'Không xác định');
      const zeitRaw = o.completedTimeText || o.createdDateText || '';
      let rowStyle = '';
      if (!isCompleted) {
        rowStyle = ' style="background:#ffcdd2;"';
      } else if (isUnknownCompleter) {
        rowStyle = ' style="background:#fff3e0;"';
      }
      html += `<tr${rowStyle}>`;
      html += `<td style="${cellStyle}">${esc(o.code)}</td>`;
      html += `<td style="${cellStyle}">${esc(o.shippingMethod)}</td>`;
      html += `<td style="${cellStyle}">${esc(o.totalText || o.total)}</td>`;
      if (!isCompleted) {
        html += `<td style="${cellStyle}color:#d32f2f;font-weight:bold;">${esc(o.status)}</td>`;
      } else {
        html += `<td style="${cellStyle}">${esc(o.status)}</td>`;
      }
      if (isUnknownCompleter) {
        html += `<td style="${cellStyle}color:#d84315;font-weight:bold;">${esc(completedByDisplay)}</td>`;
      } else {
        html += `<td style="${cellStyle}">${esc(isCompleted ? completedByDisplay : '-')}</td>`;
      }
      html += `<td style="${cellStyle}">${esc(formatZeit(zeitRaw))}</td>`;
      html += '</tr>';
    }
    html += '</table>';
    html += '</div>';

    return html;
  }

  function getReportId(reportDate) {
    return `thaiasia-daily-report:${reportDate}`;
  }

  function loadSendState() {
    try {
      const raw = localStorage.getItem(CONFIG.SEND_STATE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (error) {
      console.error('[ThaiAsia Daily Report] Send state bị lỗi:', error);
      // Không tự gửi khi trạng thái bị hỏng: lần trước có thể đã gửi thành công.
      return {
        reportDate: getTodayLocalDateString(),
        status: 'unknown',
        error: 'Invalid local send state',
      };
    }
  }

  function saveSendState(state) {
    try {
      localStorage.setItem(CONFIG.SEND_STATE_KEY, JSON.stringify(state));
    } catch (error) {
      console.error('[ThaiAsia Daily Report] Không lưu được send state:', error);
    }
  }

  function appendSendLog(event, details = {}) {
    try {
      const current = JSON.parse(localStorage.getItem(CONFIG.SEND_LOG_KEY) || '[]');
      const entries = Array.isArray(current) ? current : [];
      entries.push({
        time: new Date().toISOString(),
        event,
        ...details,
      });
      localStorage.setItem(
        CONFIG.SEND_LOG_KEY,
        JSON.stringify(entries.slice(-CONFIG.MAX_SEND_LOG_ENTRIES))
      );
    } catch (error) {
      console.error('[ThaiAsia Daily Report] Không lưu được send log:', error);
    }
  }

  function getTodaySendState() {
    const state = loadSendState();
    if (!state || state.reportDate !== getTodayLocalDateString()) return null;
    return state;
  }

  function isAutoSendBlockedToday() {
    const state = getTodaySendState();
    if (!state) return false;
    return ['sending', 'sent', 'unknown'].includes(String(state.status || ''));
  }

  let sendInFlight = false;

  function requestReport(payload) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settleOnce = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      GM_xmlhttpRequest({
        method: 'POST',
        url: CONFIG.WEBHOOK_URL,
        headers: {
          'Content-Type': 'application/json',
        },
        data: JSON.stringify(payload),
        timeout: CONFIG.SEND_TIMEOUT_MS,
        onload: function (response) {
          const status = Number(response && response.status) || 0;
          const responseText = String(response && response.responseText || '');
          log('Send report response', status, responseText);

          if (status < 200 || status >= 300) {
            settleOnce(reject, new Error(`HTTP ${status}: ${responseText}`));
            return;
          }

          let result;
          try {
            result = JSON.parse(responseText);
          } catch (_) {
            settleOnce(reject, new Error('Webhook trả về dữ liệu không phải JSON hợp lệ'));
            return;
          }

          if (!result || result.success !== true) {
            const message = result && result.error
              ? String(result.error)
              : 'Webhook báo gửi không thành công';
            const error = new Error(message);
            error.serverResult = result || null;
            settleOnce(reject, error);
            return;
          }

          settleOnce(resolve, result);
        },
        onerror: function (error) {
          log('Send report error', error);
          const message = error && (error.message || error.error)
            ? String(error.message || error.error)
            : String(error || 'Network error');
          settleOnce(reject, new Error(message));
        },
        ontimeout: function () {
          settleOnce(reject, new Error(`Webhook timeout sau ${CONFIG.SEND_TIMEOUT_MS}ms`));
        },
        onabort: function () {
          settleOnce(reject, new Error('Webhook request đã bị hủy'));
        },
      });
    });
  }

  async function sendReport(payload, source = 'auto') {
    if (sendInFlight) {
      throw new Error('Một lượt gửi báo cáo đang chạy — bỏ qua lượt gọi trùng');
    }

    const isManual = typeof source === 'string' && source.startsWith('manual');
    const reportDate = String(payload && payload.reportDate || getTodayLocalDateString());
    const baseReportId = getReportId(reportDate);
    const reportId = isManual ? `${baseReportId}-manual-${Date.now()}` : baseReportId;
    const attemptId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const requestPayload = {
      ...payload,
      reportId,
      force: isManual
    };

    sendInFlight = true;
    saveSendState({
      reportDate,
      reportId,
      attemptId,
      source,
      status: 'sending',
      startedAt: new Date().toISOString(),
    });
    appendSendLog('request-started', { reportDate, reportId, attemptId, source });
    emitDiag('tienship_report_started', {
      reportDate,
      source,
      orderCount: Array.isArray(payload && payload.orders) ? payload.orders.length : (payload && payload.totalOrders) || 0,
      totalMoney: payload && payload.totalMoney || 0,
      targetEmail: CONFIG.REPORT_EMAIL
    });

    try {
      const result = await requestReport(requestPayload);
      const finishedAt = new Date().toISOString();
      saveSendState({
        reportDate,
        reportId,
        attemptId,
        source,
        status: 'sent',
        duplicate: result.duplicate === true,
        sentAt: result.sentAt || finishedAt,
        confirmedAt: finishedAt,
      });
      localStorage.setItem(CONFIG.LAST_SENT_KEY, reportDate);
      appendSendLog('request-confirmed', {
        reportDate,
        reportId,
        attemptId,
        source,
        duplicate: result.duplicate === true,
      });
      emitDiag('tienship_report_sent', {
        reportDate,
        source,
        doneFull: payload && payload.doneFull === true,
        triggerReason: (payload && payload.triggerReason) || (isManual ? 'manual' : 'auto'),
        duplicate: result.duplicate === true,
        sentAt: result.sentAt || finishedAt,
        orderCount: Array.isArray(payload && payload.orders) ? payload.orders.length : (payload && payload.totalOrders) || 0,
        totalMoney: payload && payload.totalMoney || 0,
        targetEmail: CONFIG.REPORT_EMAIL
      });
      try {
        if (typeof window !== 'undefined' && window.ThaiAsiaHost && typeof window.ThaiAsiaHost.onReportSent === 'function') {
          window.ThaiAsiaHost.onReportSent({
            reportDate,
            source,
            doneFull: payload && payload.doneFull === true,
            triggerReason: (payload && payload.triggerReason) || (isManual ? 'manual' : 'auto'),
            duplicate: result.duplicate === true,
            orderCount: Array.isArray(payload && payload.orders) ? payload.orders.length : (payload && payload.totalOrders) || 0,
            totalMoney: payload && payload.totalMoney || 0
          });
        }
      } catch (_) {}
      return result;
    } catch (error) {
      const failedAt = new Date().toISOString();
      const serverResult = error && error.serverResult ? error.serverResult : null;
      saveSendState({
        reportDate,
        reportId,
        attemptId,
        source,
        status: 'unknown',
        needsManualCheck: true,
        error: String(error && error.message || error),
        serverState: serverResult && serverResult.state ? serverResult.state : '',
        failedAt,
      });
      appendSendLog('request-unknown', {
        reportDate,
        reportId,
        attemptId,
        source,
        error: String(error && error.message || error),
      });
      emitDiag('tienship_report_failed', {
        reportDate,
        source,
        error: String(error && error.message || error),
        targetEmail: CONFIG.REPORT_EMAIL
      });
      throw error;
    } finally {
      sendInFlight = false;
    }
  }

  function isAlreadySentToday() {
    const lastSentDate = localStorage.getItem(CONFIG.LAST_SENT_KEY);
    const today = getTodayLocalDateString();
    return lastSentDate === today;
  }

  function isInReportWindow() {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = CONFIG.REPORT_HOUR * 60 + CONFIG.REPORT_MINUTE;
    return currentMinutes >= startMinutes;
  }

  function isPastDeadline() {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const deadlineMinutes = CONFIG.DEADLINE_HOUR * 60 + CONFIG.DEADLINE_MINUTE;
    return currentMinutes >= deadlineMinutes;
  }

  function shouldSendNow() {
    if (isAlreadySentToday()) return false;
    if (isAutoSendBlockedToday()) return false;
    return isInReportWindow();
  }

  async function trySendDailyReport() {
    if (!shouldSendNow()) return;

    // Chống reload lặp vô hạn - không reload nếu đã reload trong 5 phút gần đây
    const lastReloadTime = localStorage.getItem(CONFIG.RELOAD_FLAG_KEY);
    if (lastReloadTime && (Date.now() - parseInt(lastReloadTime, 10)) < 5 * 60 * 1000) {
      return;
    }

    // Auto reload để lấy đủ dữ liệu trước khi kiểm tra
    localStorage.setItem(CONFIG.RELOAD_FLAG_KEY, String(Date.now()));
    log('Chuyển đến trang per_page=9999 để lấy đủ dữ liệu trước khi kiểm tra...');
    window.location.href = CONFIG.FULL_PAGE_URL;
  }

  function cleanupOldHistory(daysToKeep = 7) {
    const history = loadHistory();
    const now = new Date();
    const nextHistory = {};

    for (const [key, value] of Object.entries(history)) {
      // Ưu tiên completedTimeText, fallback createdDateText, rồi completedDateStr
      const dt = parseDateFromCell(value.completedTimeText)
        || parseDateFromCell(value.createdDateText)
        || parseDateFromCell(value.completedDateStr);
      if (!dt) continue;

      const diffMs = now - dt;
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays <= daysToKeep) {
        nextHistory[key] = value;
      }
    }

    saveHistory(nextHistory);
  }

  function scanAndStore() {
    try {
      const orders = extractOrdersFromTable();
      if (!orders.length) return;
      mergeOrdersIntoHistory(orders);
      cleanupOldHistory();
    } catch (error) {
      console.error('[ThaiAsia Daily Report] Scan error:', error);
    }
  }

  async function start() {
    log('Script started');

    const reloadTimestamp = localStorage.getItem(CONFIG.RELOAD_FLAG_KEY);
    const isManualPostReload = Boolean(reloadTimestamp && reloadTimestamp.startsWith('manual_'));
    const isPostReload = reloadTimestamp && (
      isManualPostReload ||
      (Date.now() - parseInt(reloadTimestamp, 10)) < 5 * 60 * 1000
    );

    if (isPostReload) {
      // Vừa reload xong — chờ bảng load xong rồi kiểm tra
      localStorage.removeItem(CONFIG.RELOAD_FLAG_KEY);
      log('Đã reload, chờ bảng load dữ liệu...');

      // Chờ tối đa 30s cho bảng ổn định (có thể 0 đơn thật)
      let waitAttempts = 0;
      const maxWait = 30;
      while (waitAttempts < maxWait) {
        if (!isTableLoading()) break;
        await new Promise(r => setTimeout(r, 1000));
        waitAttempts++;
      }

      scanAndStore();
      const orders = extractOrdersFromTable();
      const doneFull = isDoneFull(orders);
      const pastDeadline = isPastDeadline();

      log(`Sau reload: ${orders.length} đơn, done full: ${doneFull}, quá deadline: ${pastDeadline}`);

      const sendState = getTodaySendState();
      const stateStatus = sendState && String(sendState.status || '');

      if (isAlreadySentToday() || stateStatus === 'sent') {
        log('Hôm nay đã gửi rồi — bỏ qua');
      } else if (!isManualPostReload && isAutoSendBlockedToday()) {
        log(`Không tự gửi lại vì trạng thái hôm nay là "${stateStatus || 'unknown'}" — cần kiểm tra hộp thư`);
      } else if (doneFull || pastDeadline) {
        // Done full (kể cả 0/0) hoặc quá 21h → gửi ngay
        const completed = orders.filter(o => isCompletedOrder(o)).length;
        const cancelled = orders.filter(o => isDoneOrder(o) && !isCompletedOrder(o)).length;
        log(`Gửi báo cáo: Done ${completed}, Hủy ${cancelled} / ${orders.length}` + (pastDeadline ? ' (quá deadline 21h)' : ' (done full)'));

        const payload = buildPayload();
        payload.doneFull = doneFull;
        payload.triggerReason = isManualPostReload ? 'manual' : (doneFull ? 'done_full' : 'deadline');
        log('Gửi payload sau khi reload', payload);

        try {
          const result = await sendReport(payload, isManualPostReload ? 'manual-reload' : 'auto');
          if (result.duplicate === true) {
            log('Server xác nhận báo cáo ngày này đã được gửi trước đó — không gửi email mới');
          }
          log('Đã gửi báo cáo thành công');
        } catch (error) {
          console.error('[ThaiAsia Daily Report] Kết quả gửi không rõ; đã dừng tự retry để tránh email trùng:', error);
        }
      } else {
        // Chưa done full và chưa quá deadline → chờ lần check tiếp theo
        const completed = orders.filter(o => isCompletedOrder(o)).length;
        const cancelled = orders.filter(o => isDoneOrder(o) && !isCompletedOrder(o)).length;
        log(`Chưa done full (Done ${completed}, Hủy ${cancelled} / ${orders.length}), chưa quá 21h → chờ lần check tiếp`);
      }
    } else {
      // Khởi động bình thường
      if (reloadTimestamp) localStorage.removeItem(CONFIG.RELOAD_FLAG_KEY);
      scanAndStore();
      trySendDailyReport();
    }

    // Dùng Web Worker timer để không bị throttle khi tab ở background
    createWorkerTimer(scanAndStore, CONFIG.SCAN_INTERVAL_MS);
    createWorkerTimer(trySendDailyReport, CONFIG.SEND_CHECK_INTERVAL_MS);

    // Khi tab trở lại foreground → kiểm tra ngay lập tức
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        log('Tab vừa active lại, kiểm tra ngay...');
        scanAndStore();
        trySendDailyReport();
      }
    });

    createManualPanel();
  }

  // ====== PANEL THỦ CÔNG ======

  function createManualPanel() {
    if (document.getElementById('thaiasia-manual-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'thaiasia-manual-panel';
    panel.innerHTML = `
      <style>
        #thaiasia-manual-panel {
          position: fixed;
          bottom: 20px;
          left: 20px;
          z-index: 99999;
          font-family: Arial, sans-serif;
          font-size: 13px;
        }
        #thaiasia-manual-panel .ta-toggle-btn {
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: #1976d2;
          color: #fff;
          border: none;
          cursor: pointer;
          font-size: 22px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: auto;
        }
        #thaiasia-manual-panel .ta-toggle-btn:hover {
          background: #1565c0;
        }
        #thaiasia-manual-panel .ta-panel-body {
          display: none;
          background: #fff;
          border: 1px solid #ccc;
          border-radius: 8px;
          padding: 14px;
          margin-bottom: 8px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.18);
          min-width: 260px;
        }
        #thaiasia-manual-panel .ta-panel-body.open {
          display: block;
        }
        #thaiasia-manual-panel .ta-panel-title {
          font-weight: bold;
          font-size: 14px;
          margin-bottom: 10px;
          color: #1976d2;
        }
        #thaiasia-manual-panel .ta-btn {
          display: block;
          width: 100%;
          padding: 8px 0;
          margin-bottom: 6px;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          color: #fff;
        }
        #thaiasia-manual-panel .ta-btn-reload {
          background: #ff9800;
        }
        #thaiasia-manual-panel .ta-btn-reload:hover {
          background: #f57c00;
        }
        #thaiasia-manual-panel .ta-btn-send {
          background: #4caf50;
        }
        #thaiasia-manual-panel .ta-btn-send:hover {
          background: #388e3c;
        }
        #thaiasia-manual-panel .ta-btn-both {
          background: #1976d2;
        }
        #thaiasia-manual-panel .ta-btn-both:hover {
          background: #1565c0;
        }
        #thaiasia-manual-panel .ta-status {
          margin-top: 8px;
          padding: 6px;
          border-radius: 4px;
          font-size: 12px;
          display: none;
        }
        #thaiasia-manual-panel .ta-info {
          font-size: 11px;
          color: #888;
          margin-top: 6px;
        }
      </style>
      <div class="ta-panel-body" id="ta-panel-body">
        <div class="ta-panel-title">📊 Thai Asia Report</div>
        <button class="ta-btn ta-btn-reload" id="ta-btn-reload">🔄 Reload & Quét dữ liệu</button>
        <button class="ta-btn ta-btn-send" id="ta-btn-send">📧 Gửi báo cáo ngay</button>
        <button class="ta-btn ta-btn-both" id="ta-btn-both">⚡ Reload + Gửi báo cáo</button>
        <div class="ta-status" id="ta-status"></div>
        <div class="ta-info" id="ta-info"></div>
      </div>
      <button class="ta-toggle-btn" id="ta-toggle-btn" title="Thai Asia Report">📊</button>
    `;
    document.body.appendChild(panel);

    const toggleBtn = document.getElementById('ta-toggle-btn');
    const panelBody = document.getElementById('ta-panel-body');
    const btnReload = document.getElementById('ta-btn-reload');
    const btnSend = document.getElementById('ta-btn-send');
    const btnBoth = document.getElementById('ta-btn-both');
    const statusEl = document.getElementById('ta-status');
    const infoEl = document.getElementById('ta-info');

    toggleBtn.addEventListener('click', () => {
      panelBody.classList.toggle('open');
      if (panelBody.classList.contains('open')) {
        updatePanelInfo();
      }
    });

    function showStatus(msg, color) {
      statusEl.style.display = 'block';
      statusEl.style.background = color || '#e3f2fd';
      statusEl.style.color = '#333';
      statusEl.textContent = msg;
    }

    function updatePanelInfo() {
      const tableOrders = extractOrdersFromTable();
      const loading = isTableLoading();
      const completed = tableOrders.filter(o => isCompletedOrder(o)).length;
      const cancelled = tableOrders.filter(o => isDoneOrder(o) && !isCompletedOrder(o)).length;
      const lastSent = localStorage.getItem(CONFIG.LAST_SENT_KEY) || 'Chưa gửi';
      const doneFull = isDoneFull(tableOrders);
      const sendState = getTodaySendState();
      const stateStatus = sendState && String(sendState.status || '');
      const sentToday = isAlreadySentToday() || stateStatus === 'sent';

      let statusLine = '';
      if (loading) {
        statusLine = `⏳ <b>Bảng đang loading...</b>`;
      } else {
        statusLine = `Trang hiện tại: <b>${tableOrders.length}</b> đơn — Done <b>${completed}</b> | Hủy <b>${cancelled}</b> / ${tableOrders.length}`;
        if (doneFull) statusLine += ' ✅';
      }
      if (sentToday) statusLine += '<br>📨 <b>Đã gửi báo cáo hôm nay</b>';
      if (!sentToday && stateStatus === 'sending') {
        statusLine += '<br>⏳ <b>Đang chờ phản hồi gửi báo cáo</b>';
      }
      if (!sentToday && stateStatus === 'unknown') {
        statusLine += '<br>⚠️ <b>Kết quả gửi chưa rõ — hãy kiểm tra hộp thư trước khi thử lại</b>';
      }

      infoEl.innerHTML = statusLine + `<br>Ngày gửi gần nhất: <b>${lastSent}</b>`;
      const sendingDisabled = sendInFlight;
      btnSend.disabled = sendingDisabled;
      btnBoth.disabled = sendingDisabled;
      btnSend.style.opacity = sendingDisabled ? '0.55' : '1';
      btnBoth.style.opacity = sendingDisabled ? '0.55' : '1';
    }

    // Nút 1: Reload trang để lấy dữ liệu mới
    btnReload.addEventListener('click', () => {
      showStatus('Đang reload trang...', '#fff3e0');
      setTimeout(() => location.reload(), 300);
    });

    // Nút 2: Gửi báo cáo ngay (không reload, dùng dữ liệu hiện tại — kể cả 0/0)
    btnSend.addEventListener('click', async () => {
      if (sendInFlight) {
        showStatus('⏳ Một lượt gửi đang chờ phản hồi.', '#fff3e0');
        return;
      }
      const currentState = getTodaySendState();
      if (currentState && ['sending'].includes(String(currentState.status || ''))) {
        const confirmed = window.confirm(
          'Một lượt gửi trước đang được xử lý.\n\nBạn vẫn muốn gửi thêm một báo cáo mới ngay bây giờ?'
        );
        if (!confirmed) return;
      }

      showStatus('Đang quét & gửi báo cáo...', '#e8f5e9');
      btnSend.disabled = true;
      try {
        scanAndStore();
        const payload = buildPayload();
        payload.doneFull = isDoneFull(extractOrdersFromTable());
        payload.triggerReason = 'manual';
        log('Gửi thủ công payload', payload);
        const result = await sendReport(payload, 'manual-direct');
        showStatus('✅ Gửi báo cáo thành công!', '#c8e6c9');
        log('Gửi thủ công thành công');
      } catch (error) {
        showStatus('⚠️ Kết quả chưa rõ; hãy kiểm tra email. ' + error.message, '#fff3e0');
        console.error('[ThaiAsia Manual] Gửi thất bại:', error);
      }
      updatePanelInfo();
    });

    // Nút 3: Chuyển đến per_page=9999 rồi gửi (dùng flag giống auto)
    btnBoth.addEventListener('click', () => {
      if (sendInFlight) {
        showStatus('⏳ Một lượt gửi đang chờ phản hồi.', '#fff3e0');
        return;
      }

      showStatus('Đang chuyển đến trang đầy đủ để lấy dữ liệu...', '#e3f2fd');
      localStorage.setItem(CONFIG.RELOAD_FLAG_KEY, 'manual_' + Date.now());
      setTimeout(() => { window.location.href = CONFIG.FULL_PAGE_URL; }, 300);
    });

    updatePanelInfo();
  }

  let started = false;
  function scheduleStart() {
    if (started) return;
    started = true;
    setTimeout(() => {
      Promise.resolve(start()).catch((error) => {
        console.error('[ThaiAsia Daily Report] Start failed:', error);
      });
    }, 2000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    scheduleStart();
  } else {
    window.addEventListener('load', scheduleStart, { once: true });
    document.addEventListener('DOMContentLoaded', scheduleStart, { once: true });
  }

  setTimeout(scheduleStart, 5000);
})();
