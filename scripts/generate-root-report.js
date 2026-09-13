const fs = require('fs');
const path = require('path');

const bundlePath = path.join(process.cwd(), 'dist', 'ThaiAsiaApp-win32-x64', 'reports', 'ThaiAsia-24h-report-bundle.txt');
const raw = fs.readFileSync(bundlePath, 'utf8');

const sectionMarker = '------------- IMPORTANT EVENTS (NDJSON) --------';
const endMarker = '================ END OF BUNDLE =================';
const ndjsonPart = raw.substring(raw.indexOf(sectionMarker) + sectionMarker.length, raw.indexOf(endMarker)).trim();
const events = ndjsonPart.split('\n').filter(Boolean).map(l => JSON.parse(l));

function formatLocalReportTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch (_) {
    return isoString;
  }
}

function formatLocalReportDate(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  } catch (_) {
    return isoString;
  }
}

function translateReloadReason(rawReason) {
  const r = String(rawReason || '').toLowerCase();
  if (r.includes('online_recovery_reload')) return 'Mạng vừa kết nối lại; Uber tải lại an toàn khi không có đơn đang xử lý';
  if (r.includes('canary') || r.includes('auth')) return 'Tự động kết nối lại do mất xác thực canary/phiên';
  if (r.includes('stale') || r.includes('freeze') || r.includes('unresponsive')) return 'Tải lại do trang bị đơ / không phản hồi';
  if (r.includes('dead-websocket') || r.includes('websocket')) return 'Tải lại do mất kết nối WebSocket nhận đơn';
  if (r.includes('render-process-gone') || r.includes('crash')) return 'Tải lại do tiến trình hiển thị bị gián đoạn / crash';
  if (r.includes('did-fail-load') || r.includes('network') || r.includes('dns')) return 'Tải lại do lỗi mạng / tải trang thất bại';
  if (r.includes('menu-reload') || r.includes('f5') || r.includes('user-requested')) return 'Người dùng chủ động bấm tải lại';
  if (r.includes('locale') || r.includes('lang')) return 'Tải lại do chuyển ngôn ngữ';
  return rawReason || 'Tải lại định kỳ giữ kết nối';
}

function getTabDisplayName(pageOrModule) {
  const s = String(pageOrModule || '').toLowerCase();
  if (s.includes('liveorder')) return 'Takeaway (Live Orders)';
  if (s.includes('fertig')) return 'Tự động Fertig';
  if (s.includes('uber')) return 'Uber Eats';
  if (s.includes('wolt')) return 'Wolt';
  if (s.includes('tienship') || s.includes('ship')) return 'Tiền Ship';
  if (s.includes('admin')) return 'Admin';
  return pageOrModule || 'Ứng dụng';
}

function inferReloadEventDetails(event) {
  const normalized = { ...(event || {}) };
  const message = String(normalized.message || '');
  if (!normalized.page) {
    const pageMatch = message.match(/\[(?:Reload|ReloadKey)\]\s+([a-zA-Z0-9_-]+)/i);
    if (pageMatch) normalized.page = pageMatch[1];
  }
  if (!normalized.reason) {
    const reasonMatch = message.match(/\breason=([^\s]+)/i);
    if (reasonMatch) normalized.reason = reasonMatch[1];
    else if (/F5|Ctrl\+R|reloaded manually/i.test(message)) normalized.reason = 'manual-f5';
  }
  if (!normalized.action) {
    const actionMatch = message.match(/->\s+(reload(?:IgnoringCache)?\(\))/i);
    if (actionMatch) normalized.action = actionMatch[1];
  }
  if (!Number.isFinite(normalized.tsMs)) normalized.tsMs = Date.parse(String(normalized.ts || ''));
  return normalized;
}

function dedupeReloadEvents(events) {
  const result = [];
  const rows = (events || [])
    .map(inferReloadEventDetails)
    .sort((a, b) => Number(a.tsMs || 0) - Number(b.tsMs || 0));
  for (const event of rows) {
    const eventAt = Number(event.tsMs || Date.parse(String(event.ts || '')) || 0);
    const duplicateIndex = result.findIndex((previous) => {
      const previousAt = Number(previous.tsMs || Date.parse(String(previous.ts || '')) || 0);
      return String(previous.page || '') === String(event.page || '')
        && String(previous.reason || '') === String(event.reason || '')
        && Math.abs(eventAt - previousAt) <= 2000;
    });
    if (duplicateIndex < 0) result.push(event);
    else if (event.category === 'diag_reload' && result[duplicateIndex].category !== 'diag_reload') {
      result[duplicateIndex] = event;
    }
  }
  return result;
}

function getAppVersionInfo() {
  let version = '1.2.12';
  let updatedAtIso = '';
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.version) version = pkg.version;
      const stat = fs.statSync(pkgPath);
      updatedAtIso = stat.mtime ? stat.mtime.toISOString() : '';
    }
  } catch (_) {}
  return { version, updatedAtIso };
}

function buildVietnameseHumanReport(events, generatedAtIso, windowDescription) {
  const { version: appVer, updatedAtIso: appUpdatedIso } = getAppVersionInfo();
  const updatedDateStr = appUpdatedIso ? formatLocalReportDate(appUpdatedIso) : '';
  const versionHeader = updatedDateStr
    ? `Phiên bản app: v${appVer} (Cập nhật lúc: ${updatedDateStr})`
    : `Phiên bản app: v${appVer}`;

  const orderEvents = events.filter((evt) => evt.category === 'diag_order_activity');
  const manualWoltEvents = events.filter((evt) =>
    evt.category === 'diag_wolt_manual_action'
    && evt.action === 'manual_click'
    && evt.meta
    && ['accept_order', 'confirm', 'delivery_time', 'mark_ready'].includes(evt.meta.actionKind)
  );
  const ordersMap = new Map();

  for (const evt of orderEvents) {
    const code = String(evt.orderCode || (evt.meta && evt.meta.orderCode) || '').trim();
    if (!code) continue;
    if (!ordersMap.has(code)) ordersMap.set(code, []);
    ordersMap.get(code).push(evt);
  }

  for (const evt of manualWoltEvents) {
    const meta = evt.meta || {};
    const activeNumber = String(
      (meta.context && meta.context.activeOrderNumber)
      || (meta.before && meta.before.bridge && meta.before.bridge.activeOrderNumber)
      || evt.orderCode
      || ''
    ).replace(/^WOLT-/i, '').match(/^\d{1,10}/)?.[0] || '';
    if (!activeNumber) continue;
    const code = [...ordersMap.keys()].find(key => {
      const normalized = String(key).replace(/^WOLT-/i, '').replace(/^0+/, '') || '0';
      return normalized === (activeNumber.replace(/^0+/, '') || '0');
    }) || `WOLT-${activeNumber}`;
    if (!ordersMap.has(code)) ordersMap.set(code, []);
    ordersMap.get(code).push(evt);
  }

  let takeawayCount = 0;
  let uberCount = 0;
  let woltCount = 0;
  let takeawaySuccess = 0;
  let uberSuccess = 0;
  let woltSuccess = 0;
  let takeawayManual = 0;
  let takeawayAuto = 0;
  let uberManual = 0;
  let uberAuto = 0;
  let woltManual = 0;
  let woltAuto = 0;

  const quickRows = [];
  const treeBlocks = [];
  let orderIndex = 1;

  for (const [code, evts] of ordersMap.entries()) {
    evts.sort((a, b) => Number(a.tsMs || Date.parse(a.ts) || 0) - Number(b.tsMs || Date.parse(b.ts) || 0));
    const isUber = evts.some(e => e.module === 'ubereats' || (e.page && String(e.page).includes('uber')));
    const isWolt = evts.some(e => e.module === 'wolt' || (e.page && String(e.page).includes('wolt')));
    const isTakeaway = !isUber && !isWolt;

    let platformName = 'Takeaway (Live Orders)';
    let shortPlatform = 'Takeaway';
    if (isUber) { platformName = 'Uber Eats'; shortPlatform = 'Uber Eats'; }
    else if (isWolt) { platformName = 'Wolt'; shortPlatform = 'Wolt'; }

    const hasWoltManualIntervention = evts.some(e =>
      e.category === 'diag_wolt_manual_action'
      && e.action === 'manual_click'
      && e.meta
      && ['accept_order', 'confirm', 'delivery_time', 'mark_ready'].includes(e.meta.actionKind)
    );
    const isManual = hasWoltManualIntervention || evts.some(e =>
      (e.meta && (e.meta.trigger === 'manual' || e.meta.manual === true || e.meta.source === 'dock_button' || e.meta.source === 'manual_click' || e.meta.source === 'capture_header')) ||
      e.action === 'uber_dock_manual_clicked' ||
      e.action === 'wolt_manual_clicked'
    ) || (isTakeaway && !evts.some(e => e.action === 'cycle_start'));

    const modeLabel = hasWoltManualIntervention ? '[Có bấm tay]' : (isManual ? '[Thủ công]' : '[Tự động]');

    const hasAdminConfirmed = evts.some(e => e.action === 'admin_submit_confirmed');
    const hasAdminFill = evts.some(e => e.action === 'admin_fill_succeeded');
    const hasDuplicateSubmit = evts.filter(e => e.action === 'admin_submit_started').length > 1;
    const hasUberCompleted = evts.some(e => e.action === 'uber_start_delivery_clicked' || e.action === 'uber_scheduled_marked_admin_sent');
    const hasWoltCompleted = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'ready' || (e.meta.state === 'accepted' && e.meta.isPreorder === true))
    );
    const hasWoltAccepted = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'accepted' || e.meta.state === 'ready')
    );
    const hasError = evts.some(e => e.action === 'uber_capture_error' || e.action === 'uber_post_accept_failed' || e.action === 'uber_capture_incomplete' || e.action === 'order_failed' || (e.severity === 'error'));

    let isSuccess = false;
    let statusTag = '⚠️ CẦN KIỂM TRA';

    if (hasDuplicateSubmit) {
      statusTag = '⚠️ ĐƠN BỊ TẠO LẶP TRÊN ADMIN';
    } else if (isUber && hasAdminConfirmed && hasUberCompleted) {
      statusTag = isManual ? '✅ THÀNH CÔNG (Bấm tay)' : '✅ THÀNH CÔNG (Tự động)';
      isSuccess = true;
    } else if (isUber && hasAdminConfirmed) {
      statusTag = '⚠️ ADMIN ĐÃ TẠO - UBER CHƯA HOÀN TẤT';
    } else if (isUber && hasUberCompleted) {
      statusTag = '⚠️ UBER ĐÃ XONG - ADMIN CHƯA XÁC NHẬN';
    } else if (isUber && hasAdminFill) {
      statusTag = '⚠️ ĐÃ ĐIỀN ADMIN - UBER CHƯA HOÀN TẤT';
    } else if (isWolt && hasAdminConfirmed && hasWoltCompleted) {
      statusTag = hasWoltManualIntervention ? '✅ THÀNH CÔNG (Có can thiệp tay)' : (isManual ? '✅ THÀNH CÔNG (Bấm tay)' : '✅ THÀNH CÔNG (Tự động)');
      isSuccess = true;
    } else if (isWolt && hasAdminConfirmed && hasWoltAccepted) {
      statusTag = '⚠️ WOLT ĐÃ NHẬN - CHƯA BẤM BEREIT';
    } else if (isWolt && hasAdminConfirmed) {
      statusTag = '⚠️ ADMIN ĐÃ TẠO - WOLT CHƯA NHẬN ĐƠN';
    } else if (isWolt && hasWoltCompleted) {
      statusTag = '⚠️ WOLT ĐÃ NHẬN - ADMIN CHƯA XÁC NHẬN';
    } else if (isWolt && hasAdminFill) {
      statusTag = '⚠️ ĐÃ ĐIỀN ADMIN - WOLT CHƯA NHẬN ĐƠN';
    } else if (isTakeaway && hasAdminConfirmed) {
      statusTag = isManual ? '✅ THÀNH CÔNG (Bấm tay)' : '✅ THÀNH CÔNG (Tự động)';
      isSuccess = true;
    } else if (isTakeaway && hasAdminFill) {
      statusTag = '⚠️ ĐÃ ĐIỀN FORM - CHƯA XÁC NHẬN TẠO ĐƠN';
    } else if (hasError) {
      statusTag = '⚠️ CẦN KIỂM TRA';
      isSuccess = false;
    }

    if (isUber) {
      uberCount++;
      if (isManual) uberManual++; else uberAuto++;
      if (isSuccess) uberSuccess++;
    } else if (isWolt) {
      woltCount++;
      if (isManual) woltManual++; else woltAuto++;
      if (isSuccess) woltSuccess++;
    } else {
      takeawayCount++;
      if (isManual) takeawayManual++; else takeawayAuto++;
      if (isSuccess) takeawaySuccess++;
    }

    const firstTime = evts.length ? formatLocalReportTime(evts[0].ts) : '';

    let itemCountStr = '';
    let durationStr = '';
    for (const e of evts) {
      const meta = e.meta || {};
      if (meta.itemCount) itemCountStr = `${meta.itemCount} món`;
      if (meta.durationMs) durationStr = `${(meta.durationMs / 1000).toFixed(1)}s`;
    }
    if (isWolt && evts.length > 1) {
      const firstMs = Number(evts[0].tsMs || Date.parse(evts[0].ts) || 0);
      const lastMs = Number(evts[evts.length - 1].tsMs || Date.parse(evts[evts.length - 1].ts) || 0);
      if (firstMs > 0 && lastMs >= firstMs) durationStr = `${((lastMs - firstMs) / 1000).toFixed(1)}s`;
    }

    const quickDetail = [itemCountStr, durationStr].filter(Boolean).join(' | ') || (isSuccess ? 'Đã xử lý' : 'Chưa hoàn tất');
    quickRows.push(`   ${orderIndex}. ${firstTime} | ${shortPlatform.padEnd(10, ' ')} | ${modeLabel.padEnd(10, ' ')} | Đơn #${code} | ${quickDetail} | ${statusTag}`);
    orderIndex++;

    const rawNodes = [];
    let lastNodeText = '';
    for (const e of evts) {
      const timeStr = formatLocalReportTime(e.ts);
      const action = e.action || '';
      const meta = e.meta || {};
      let node = '';

      switch (action) {
        case 'uber_order_seen_first_time':
          node = `👁️ [${timeStr}] Phát hiện: Thẻ đơn mới #${code} xuất hiện trên Uber Eats`;
          break;
        case 'uber_capture_start':
          node = `🔍 [${timeStr}] Đọc thông tin: Bắt đầu quét chi tiết đơn hàng #${code}`;
          break;
        case 'uber_delivery_details_captured': {
          const phoneInfo = meta.phonePresent ? 'Có SĐT khách' : 'Không có SĐT';
          node = `📍 [${timeStr}] Địa chỉ & SĐT: Lấy xong địa chỉ giao hàng và ${phoneInfo}`;
          break;
        }
        case 'uber_payload_saved': {
          const count = meta.itemCount ? `${meta.itemCount} món` : 'danh sách món';
          node = `💾 [${timeStr}] Dữ liệu: Trích xuất thành công ${count} & lưu bộ nhớ tạm`;
          break;
        }
        case 'uber_accept_clicked':
          node = `⚡ [${timeStr}] Nhận đơn: Bấm nút chấp nhận đơn trên Uber Eats`;
          break;
        case 'uber_ready_clicked':
          node = `🛎️ [${timeStr}] Sẵn sàng: Bấm nút "Đã sẵn sàng" (Bereit) trên Uber Eats`;
          break;
        case 'uber_start_delivery_clicked':
          node = `🚚 [${timeStr}] Giao hàng: Đã bấm "Bắt đầu giao hàng" (Lieferung beginnen) trên Uber Eats`;
          break;
        case 'uber_scheduled_marked_admin_sent':
          node = `🗓️ [${timeStr}] Đơn đặt trước: Đã ghi nhận hoàn tất phần xử lý Uber Eats`;
          break;
        case 'uber_post_accept_failed':
          node = `⚠️ [${timeStr}] Uber chưa hoàn tất sau khi nhận đơn: ${meta.error || 'Không tìm thấy nút xử lý tiếp theo'}`;
          break;
        case 'uber_capture_incomplete':
          node = `⚠️ [${timeStr}] Quy trình Uber dừng giữa chừng tại bước ${meta.completionStage || 'không xác định'}${meta.error ? `: ${meta.error}` : ''}`;
          break;
        case 'uber_capture_done': {
          const dur = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : '';
          node = `🏁 [${timeStr}] Hoàn tất: Xử lý xong toàn bộ đơn Uber Eats ${dur ? `(trong ${dur})` : ''}`;
          break;
        }
        case 'cycle_start':
          node = `👁️ [${timeStr}] Phát hiện: Đơn mới #${code} xuất hiện trên Takeaway Live Orders`;
          break;
        case 'cycle_blocked_missing_order_identity':
          node = `🛑 [${timeStr}] Dừng an toàn: Không đọc được mã của nút nhận đơn; chưa mở Admin và chưa nhận đơn`;
          break;
        case 'cycle_blocked_panel_identity_mismatch':
          node = `🛑 [${timeStr}] Dừng an toàn: Panel chi tiết chưa chuyển đúng sang đơn #${meta.expectedOrderCode || code}`;
          break;
        case 'send_identity_mismatch':
          node = `🛑 [${timeStr}] Dừng an toàn: Mã payload #${code} không khớp đơn đang chờ #${meta.expectedOrderCode || 'không xác định'}`;
          break;
        case 'accept_attempt':
        case 'accept_clicked':
          node = `⚡ [${timeStr}] Nhận đơn: Bấm nút nhận đơn trên Takeaway`;
          break;
        case 'cycle_done': {
          const dur = meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : '';
          node = `🏁 [${timeStr}] Hoàn tất: Xử lý xong toàn bộ đơn Takeaway ${dur ? `(trong ${dur})` : ''}`;
          break;
        }
        case 'admin_window_opened':
          node = `🌐 [${timeStr}] Tab Admin: Mở tab Admin ngầm và nạp thông tin đơn`;
          break;
        case 'admin_payload_loaded':
          node = `📥 [${timeStr}] Nạp dữ liệu: Tab Admin đã nhận đầy đủ thông tin đơn`;
          break;
        case 'admin_fill_succeeded': {
          const mCount = meta.matchedCount ? `${meta.matchedCount} trường` : 'các trường';
          node = `✍️ [${timeStr}] Điền form: Tự động điền xong ${mCount} vào form Admin`;
          break;
        }
        case 'admin_submit_started':
          node = `📤 [${timeStr}] Gửi đơn: Bấm Submit tạo đơn trên Admin`;
          break;
        case 'admin_submit_confirmed': {
          const dur = meta.durationMs ? `(mất ${meta.durationMs}ms)` : '';
          node = `✅ [${timeStr}] Admin xác nhận: Tạo đơn thành công ${dur} -> Đóng tab Admin`;
          break;
        }
        case 'admin_timeout_retry':
          node = `🔄 [${timeStr}] Tab Admin treo (30s): Hủy tab kẹt và thử lại lần ${meta.nextAttempt || (meta.attempt + 1)}/${meta.maxAttempts || 3}`;
          break;
        case 'admin_timeout_exhausted':
          node = `⚠️ [${timeStr}] Tab Admin lỗi sau 3 lần (90s): Nổi tab Admin và tab sàn để xử lý thủ công`;
          break;
        case 'admin_load_failed_retry':
          node = `🔄 [${timeStr}] Tab Admin lỗi mạng (${meta.errorCode || 'error'}): Hủy tab kẹt và thử lại lần ${meta.nextAttempt || (meta.attempt + 1)}/${meta.maxAttempts || 3}`;
          break;
        case 'wolt_tasks_captured':
          node = `👁️ [${timeStr}] Phát hiện: Bắt được đơn mới #${code} từ Wolt`;
          break;
        case 'wolt_accept_clicked':
          node = `⚡ [${timeStr}] Nhận đơn: Bấm nút xác nhận đơn trên Wolt`;
          break;
        case 'wolt_delivery_time_selected':
          node = `⏰ [${timeStr}] Thời gian: Bấm chọn thời gian giao ${meta.minutes ? meta.minutes + ' phút' : ''} trên Wolt`;
          break;
        case 'wolt_confirm_clicked':
          node = `📤 [${timeStr}] Xác nhận: Gửi xác nhận thời gian nhận đơn cho Wolt`;
          break;
        case 'wolt_accept_unconfirmed':
          node = `⚠️ [${timeStr}] Wolt chưa hoàn tất: Chưa xác minh được Wolt đã nhận đơn; app sẽ thử lại và không tạo lại đơn Admin`;
          break;
        case 'wolt_order_processed':
        case 'wolt_order_reconciled':
          if (meta.state === 'ready' || (meta.state === 'accepted' && meta.isPreorder === true)) {
            node = `✅ [${timeStr}] Wolt xác nhận: ${meta.state === 'ready' ? 'Đơn đã được nhận và bấm Bereit thành công' : 'Đơn đặt trước đã được Wolt nhận'}`;
          } else if (meta.state === 'accepted') {
            node = `⏳ [${timeStr}] Wolt đã nhận đơn: Đang chờ app bấm Bereit`;
          }
          break;
        case 'mark_ready':
          node = `🛎️ [${timeStr}] Sẵn sàng: Bấm "Bereit" (Sẵn sàng) trên Wolt`;
          break;
        case 'fertig_clicked':
          node = `🛎️ [${timeStr}] Tự động Fertig: Đã bấm hoàn tất đơn (Fertig) trên Übergabe${meta.orderMinutes != null ? ' (còn ' + meta.orderMinutes + ' phút)' : ''}`;
          break;
        default:
          break;
      }

      if (node && node !== lastNodeText) {
        rawNodes.push(node);
        lastNodeText = node;
      }
    }

    const treeLines = [];
    treeLines.push(`📦 [${platformName.toUpperCase()}] ĐƠN #${code} (Bắt đầu lúc ${firstTime}) -> ${modeLabel} -> ${statusTag} ${durationStr ? `(${durationStr})` : ''}`);
    for (let i = 0; i < rawNodes.length; i++) {
      const isLast = (i === rawNodes.length - 1);
      const prefix = isLast ? '└── ' : '├── ';
      treeLines.push(prefix + rawNodes[i]);
    }

    treeBlocks.push(treeLines.join('\n'));
  }

  // 4. Activity log for Auto Fertig and Tiền Ship
  const auxEvents = events.filter((evt) =>
    (evt.category === 'diag_order_activity' || evt.category === 'diag_live_push') &&
    (evt.module === 'autofertig' || evt.page === 'fertigWin' || evt.module === 'tienship' || evt.page === 'tienShipWin')
  );

  const auxLogLines = [];
  for (const e of auxEvents) {
    const timeStr = formatLocalReportTime(e.ts);
    const action = e.action || '';
    const meta = e.meta || {};

    if (action === 'fertig_clicked') {
      const minsStr = meta.orderMinutes != null ? ` (còn ${meta.orderMinutes} phút)` : '';
      auxLogLines.push(`   - 🛎️ [${timeStr}] Tự động Fertig: Đã bấm hoàn tất (Fertig) đơn #${meta.orderCode || 'đơn'}${minsStr}`);
    } else if (action === 'tienship_report_sent') {
      auxLogLines.push(`   - 🚚 [${timeStr}] Tiền Ship: Đã gửi báo cáo ngày ${meta.reportDate || ''}`);
    } else if (action === 'tienship_report_failed') {
      auxLogLines.push(`   - ❌ [${timeStr}] Tiền Ship: Gửi báo cáo ngày ${meta.reportDate || ''} thất bại (Lỗi: ${meta.error || 'Unknown'})`);
    }
  }

  // 5. Reload statistics per tab
  const reloadEvents = dedupeReloadEvents(events.filter((evt) =>
    evt.category === 'diag_reload' ||
    evt.category === 'window_reload' ||
    evt.category === 'stale_reload' ||
    evt.category === 'cross_tab_reload'
  ));

  const tabReloads = new Map([
    ['Takeaway (Live Orders)', []],
    ['Uber Eats', []],
    ['Wolt', []],
    ['Tự động Fertig', []],
    ['Tiền Ship', []]
  ]);

  for (const evt of reloadEvents) {
    const tabName = getTabDisplayName(evt.page || evt.module);
    if (!tabReloads.has(tabName)) tabReloads.set(tabName, []);
    tabReloads.get(tabName).push(evt);
  }

  const reloadSectionLines = [];
  for (const [tabName, evts] of tabReloads.entries()) {
    if (evts.length === 0) {
      reloadSectionLines.push(`   - Tab ${tabName}: 0 lần (Hoạt động liên tục, không reload)`);
    } else {
      reloadSectionLines.push(`   - Tab ${tabName}: ${evts.length} lần`);
      const recentEvts = evts.slice(-10);
      for (const e of recentEvts) {
        const timeStr = formatLocalReportTime(e.ts);
        const reasonText = translateReloadReason(e.reason || e.action || e.category || (e.meta && e.meta.reason));
        reloadSectionLines.push(`     + ${timeStr} | ${reasonText}`);
      }
      if (evts.length > 10) {
        reloadSectionLines.push(`     + ... và ${evts.length - 10} lần reload trước đó`);
      }
    }
  }

  // 6. Warnings
  const warnings = [];
  const isIgnoredWarning = (e) => {
    const msg = String(e.message || '').toLowerCase();
    return msg.includes('fakestoreapi.com');
  };
  const errorEvents = events.filter(e => e.severity === 'error' && !isIgnoredWarning(e));
  if (errorEvents.length > 0) {
    warnings.push(`   - Phát hiện ${errorEvents.length} cảnh báo trong quá trình chạy (chi tiết lưu trong file bundle).`);
  }
  const incompleteUberOrders = new Set();
  for (const [code, evts] of ordersMap.entries()) {
    const isUberOrder = evts.some(e => e.module === 'ubereats' || String(e.action || '').startsWith('uber_'));
    const hasUberCompletion = evts.some(e => e.action === 'uber_start_delivery_clicked' || e.action === 'uber_scheduled_marked_admin_sent');
    const hasIncompleteEvidence = evts.some(e => e.action === 'uber_post_accept_failed' || e.action === 'uber_capture_incomplete' || e.action === 'admin_submit_confirmed');
    if (isUberOrder && !hasUberCompletion && hasIncompleteEvidence) incompleteUberOrders.add(code);
  }
  if (incompleteUberOrders.size > 0) {
    warnings.push(`   - Có ${incompleteUberOrders.size} đơn Uber Eats chưa hoàn tất bước cuối; hãy kiểm tra các đơn có ký hiệu ⚠️ ở mục 2 và 3.`);
  }
  const woltAwaitingAccept = new Set();
  const woltAwaitingReady = new Set();
  for (const [code, evts] of ordersMap.entries()) {
    const isWoltOrder = evts.some(e => e.module === 'wolt' || String(e.action || '').startsWith('wolt_'));
    const hasAdminConfirmation = evts.some(e => e.action === 'admin_submit_confirmed');
    const hasWoltCompletion = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'ready' || (e.meta.state === 'accepted' && e.meta.isPreorder === true))
    );
    const hasWoltAcceptance = evts.some(e =>
      (e.action === 'wolt_order_processed' || e.action === 'wolt_order_reconciled')
      && e.meta && (e.meta.state === 'accepted' || e.meta.state === 'ready')
    );
    if (isWoltOrder && hasAdminConfirmation && !hasWoltCompletion) {
      if (hasWoltAcceptance) woltAwaitingReady.add(code);
      else woltAwaitingAccept.add(code);
    }
  }
  if (woltAwaitingAccept.size > 0) {
    warnings.push(`   - Có ${woltAwaitingAccept.size} đơn đã tạo trên Admin nhưng Wolt chưa xác nhận nhận đơn: ${[...woltAwaitingAccept].map(code => `#${code}`).join(', ')}.`);
  }
  if (woltAwaitingReady.size > 0) {
    warnings.push(`   - Có ${woltAwaitingReady.size} đơn Wolt đã nhận nhưng chưa hoàn tất nút Bereit: ${[...woltAwaitingReady].map(code => `#${code}`).join(', ')}.`);
  }
  const duplicateAdminOrders = [...ordersMap.entries()]
    .filter(([, evts]) => evts.filter(e => e.action === 'admin_submit_started').length > 1)
    .map(([code]) => code);
  if (duplicateAdminOrders.length > 0) {
    warnings.push(`   - Có ${duplicateAdminOrders.length} mã đơn bị tạo lặp trên Admin: ${duplicateAdminOrders.map(code => `#${code}`).join(', ')}.`);
  }

  const lines = [
    '======================================================================',
    '                   BÁO CÁO HOẠT ĐỘNG THAIASIA (24H QUA)               ',
    '======================================================================',
    versionHeader,
    `Thời gian xuất báo cáo: ${formatLocalReportDate(generatedAtIso)}`,
    `Khoảng thời gian theo dõi: ${windowDescription || '24 giờ qua'}`,
    '',
    '📊 1. TỔNG KẾT ĐƠN HÀNG TRONG NGÀY:',
    `   - Takeaway (Live Orders):  ${takeawayCount} đơn [${takeawayManual} Thủ công, ${takeawayAuto} Tự động] (Thành công: ${takeawaySuccess}/${takeawayCount})`,
    `   - Uber Eats:               ${uberCount} đơn [${uberManual} Thủ công, ${uberAuto} Tự động] (Thành công: ${uberSuccess}/${uberCount})`,
    `   - Wolt:                    ${woltCount} đơn [${woltManual} Thủ công, ${woltAuto} Tự động] (Thành công: ${woltSuccess}/${woltCount})`,
    `   -> TỔNG CỘNG:              ${takeawayCount + uberCount + woltCount} đơn được ghi nhận trong report`,
    '',
    '📋 2. DANH SÁCH ĐƠN HÀNG (LƯỚT NHANH):',
    quickRows.length > 0
      ? quickRows.join('\n')
      : '   (Chưa có đơn hàng nào trong khoảng thời gian này)',
    '',
    '🌳 3. CHI TIẾT TỪNG ĐƠN THEO NHÁNH HÀNH ĐỘNG:',
    treeBlocks.length > 0
      ? treeBlocks.join('\n\n----------------------------------------------------------------------\n\n')
      : '   (Chưa có dữ liệu chi tiết)',
    '',
    '📬 4. NHẬT KÝ TỰ ĐỘNG FERTIG & GỬI BÁO CÁO TIỀN SHIP:',
    auxLogLines.length > 0
      ? auxLogLines.join('\n')
      : '   (Chưa có lượt bấm Fertig hay gửi báo cáo tiền ship nào trong 24h qua)',
    '',
    '🔄 5. THỐNG KÊ TẢI LẠI TRANG (RELOAD) THEO TỪNG TAB:',
    reloadSectionLines.join('\n'),
    '',
    '⚠️ 6. TÌNH TRẠNG KẾT NỐI & HỆ THỐNG:',
    warnings.length > 0
      ? warnings.join('\n')
      : '   - Tất cả các sàn (Takeaway, Uber Eats, Wolt, Admin) hoạt động ổn định, không có đơn hàng nào bị kẹt.',
    '======================================================================'
  ];

  return lines.join('\n');
}
const report = buildVietnameseHumanReport(events, new Date().toISOString(), '24 giờ qua');
const rootTxt = path.join(process.cwd(), 'ThaiAsia-24h-report.txt');
const distTxt = path.join(process.cwd(), 'dist', 'ThaiAsiaApp-win32-x64', 'reports', 'ThaiAsia-24h-report.txt');

fs.writeFileSync(rootTxt, report, 'utf8');
if (fs.existsSync(path.dirname(distTxt))) {
  fs.writeFileSync(distTxt, report, 'utf8');
}

console.log('Successfully generated ThaiAsia-24h-report.txt');
