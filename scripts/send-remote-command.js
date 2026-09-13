'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const DEFAULT_REPO = 'x247hl/thaiasia-releases';
const REPORT_BRANCH = 'reports';

function findToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const guidePath = path.join(root, 'AUTO-UPDATE-HUONG-DAN.md');
  if (fs.existsSync(guidePath)) {
    const text = fs.readFileSync(guidePath, 'utf8');
    const match = text.match(/github_pat_[A-Za-z0-9_]+/);
    if (match) return match[0].trim();
  }
  return '';
}

function githubApiRequest(urlStr, method, token, bodyData) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    if (method === 'GET') {
      url.searchParams.set('_t', String(Date.now()));
    }
    const postBytes = bodyData ? Buffer.from(JSON.stringify(bodyData), 'utf8') : null;
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ThaiAsia-RemoteControl/1',
      'X-GitHub-Api-Version': '2022-11-28',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache'
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (postBytes) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = postBytes.length;
    }

    const req = https.request(url, { method, headers, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { data = raw; }
        resolve({ statusCode: res.statusCode, headers: res.headers, data });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub timeout')));
    req.on('error', reject);
    if (postBytes) req.write(postBytes);
    req.end();
  });
}

async function sendCommand(repo, token, target, action, params = {}) {
  target = String(target || 'all').trim();
  target = target.toLowerCase() === 'all' ? 'all' : target.replace(/[^a-zA-Z0-9_-]/g, '_');
  const commandId = String(Date.now());
  const cmdPayload = {
    id: commandId,
    target: target || 'all',
    action,
    params,
    createdAt: new Date().toISOString()
  };

  const filePath = `commands/command-${target || 'all'}.json`;
  const getUrl = `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${REPORT_BRANCH}`;
  const existing = await githubApiRequest(getUrl, 'GET', token, null);
  let existingSha = undefined;
  if (existing.statusCode === 200 && existing.data && existing.data.sha) {
    existingSha = existing.data.sha;
  }

  const putUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const payload = {
    message: `Send command ${action} (${commandId}) to ${target} [skip ci]`,
    content: Buffer.from(JSON.stringify(cmdPayload, null, 2), 'utf8').toString('base64'),
    branch: REPORT_BRANCH
  };
  if (existingSha) payload.sha = existingSha;

  const res = await githubApiRequest(putUrl, 'PUT', token, payload);
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    throw new Error(`GitHub PUT ${filePath} returned HTTP ${res.statusCode}: ${JSON.stringify(res.data)}`);
  }

  return { commandId, filePath, data: res.data };
}

async function waitForAck(repo, token, commandId, target, timeoutSeconds = 75) {
  console.log(`\n------------------------------------------------------------`);
  console.log(`[DANG THEO DOI] Cho may [${target}] nhan va thuc thi (Toi da ${timeoutSeconds}s)...`);
  console.log(`------------------------------------------------------------`);

  const startAt = Date.now();
  const receivedList = [];
  const receivedSet = new Set();
  const isTargetAll = String(target).toLowerCase() === 'all';
  let pollCount = 0;

  while (Date.now() - startAt < timeoutSeconds * 1000) {
    await new Promise((r) => setTimeout(r, 3000));
    pollCount++;
    const elapsedSec = Math.floor((Date.now() - startAt) / 1000);
    const remainSec = Math.max(0, timeoutSeconds - elapsedSec);

    process.stdout.write(`\r[BO DEM: ${elapsedSec}s / ${timeoutSeconds}s] Dang kiem tra phan hoi lan ${pollCount} (Con ${remainSec}s)...   `);

    try {
      const listUrl = `https://api.github.com/repos/${repo}/contents/commands?ref=${REPORT_BRANCH}`;
      const listRes = await githubApiRequest(listUrl, 'GET', token, null);
      if (listRes.statusCode === 200 && Array.isArray(listRes.data)) {
        for (const item of listRes.data) {
          if (item && item.name && item.name.startsWith('ack-') && item.name.endsWith('.json')) {
            const ackUrl = `https://api.github.com/repos/${repo}/contents/${item.path}?ref=${REPORT_BRANCH}`;
            const ackRes = await githubApiRequest(ackUrl, 'GET', token, null);
            if (ackRes.statusCode === 200 && ackRes.data && ackRes.data.content) {
              const raw = Buffer.from(ackRes.data.content, 'base64').toString('utf8');
              const ack = JSON.parse(raw);
              if (ack && String(ack.commandId) === String(commandId)) {
                const mName = ack.machineName || 'Unknown';
                if (!receivedSet.has(mName)) {
                  receivedSet.add(mName);
                  receivedList.push(ack);
                  process.stdout.write('\n\x07'); // Ring terminal bell
                  formatAckResult(ack);
                  if (!isTargetAll) {
                    return receivedList;
                  }
                }
              }
            }
          }
        }
      }
    } catch (_) {}
  }
  process.stdout.write('\n');
  return receivedList;
}

const ACTIONS = [
  { key: 'force_update', title: 'Ep kiem tra va cap nhat app ngay (Force Update)' },
  { key: 'force_sync_report', title: 'Ep xuat va dong bo bao cao 24h ngay' },
  { key: 'reload_wolt', title: 'Tai lai tab Wolt' },
  { key: 'reload_uber', title: 'Tai lai tab Uber Eats' },
  { key: 'reload_takeaway', title: 'Tai lai tab Takeaway (Live Orders)' },
  { key: 'reload_fertig', title: 'Tai lai tab Tu dong Fertig' },
  { key: 'reload_tienship', title: 'Tai lai tab Tien Ship' },
  { key: 'reload_all_tabs', title: 'Tai lai TOAN BO cac tab' },
  { key: 'ping', title: 'Kiem tra trang thai may (Ping / Status)' },
  { key: 'restart_app', title: 'Khoi dong lai ung dung (Restart App)' },
  { key: 'quit_app', title: 'Dong ung dung (Quit App)' },
  { key: 'wipe_app', title: 'XOA SACH APP VA TOAN BO DU LIEU TU XA (Emergency Wipe / Tu huy)' }
];

async function discoverMachines(repo, token) {
  const machines = new Set();
  try {
    const repRes = await githubApiRequest(`https://api.github.com/repos/${repo}/contents/reports?ref=${REPORT_BRANCH}`, 'GET', token, null);
    if (repRes.statusCode === 200 && Array.isArray(repRes.data)) {
      for (const item of repRes.data) {
        const m = item.name.match(/ThaiAsia-24h-report(?:-bundle)?-([a-zA-Z0-9_-]+)\.txt/);
        if (m && m[1] && m[1] !== 'bundle') machines.add(m[1]);
      }
    }
    const cmdRes = await githubApiRequest(`https://api.github.com/repos/${repo}/contents/commands?ref=${REPORT_BRANCH}`, 'GET', token, null);
    if (cmdRes.statusCode === 200 && Array.isArray(cmdRes.data)) {
      for (const item of cmdRes.data) {
        const m = item.name.match(/ack-([a-zA-Z0-9_-]+)\.json/);
        if (m && m[1]) machines.add(m[1]);
      }
    }
  } catch (_) {}
  return Array.from(machines);
}

function formatAckResult(ack) {
  const completedOk = ack.ok !== false;
  console.log(`\n============================================================`);
  console.log(completedOk
    ? `>>> [DONE - DA THUC THI XONG THANH CONG] <<<`
    : `>>> [FAILED - MAY DA NHAN NHUNG THUC THI LOI] <<<`);
  console.log(`   - May thuc thi   : ${ack.machineName || 'Unknown'}`);
  
  if (ack.action === 'ping' && typeof ack.result === 'object' && ack.result !== null) {
    const r = ack.result;
    if (r.version) console.log(`   - Phien ban app  : ${r.version}`);
    if (r.uptime || r.uptimeSeconds) {
      let upStr = r.uptime;
      if (!upStr && r.uptimeSeconds) {
        const sec = r.uptimeSeconds;
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        upStr = h > 0 ? `${h} gio ${m} phut` : (m > 0 ? `${m} phut ${s} giay` : `${s} giay`);
      }
      console.log(`   - Da chay lien tuc: ${upStr}`);
    }
    if (r.ram || r.memoryMb) console.log(`   - Bo nho RAM     : ${r.ram || `${r.memoryMb} MB`}`);
  } else {
    console.log(`   - Lenh           : ${ack.action}`);
    console.log(`   - Ket qua        : ${typeof ack.result === 'object' ? JSON.stringify(ack.result) : ack.result}`);
  }

  if (!completedOk && ack.error) console.log(`   - Loi            : ${ack.error}`);

  const execTime = ack.executedAt ? new Date(ack.executedAt).toLocaleTimeString() : 'Vua xong';
  console.log(`   - Thoi gian      : ${execTime}`);
  console.log(`============================================================\n`);
}

async function interactiveMenu(repo, token) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  while (true) {
    console.log('\n============================================================');
    console.log('         THAIASIA - DIEU KHIEN APP TU XA (REMOTE CONTROL)   ');
    console.log('============================================================\n');

    const knownMachines = await discoverMachines(repo, token);

    console.log('1. Chon may muon gui lenh:');
    console.log('   [0] Tat ca cac may (all)');
    knownMachines.forEach((m, idx) => {
      console.log(`   [${idx + 1}] May: ${m}`);
    });
    console.log(`   [${knownMachines.length + 1}] Nhap ten may khac thu cong...`);
    console.log('   [q] Thoat chuong trinh');

    const targetChoice = (await ask(`\nNhap lua chon [0-${knownMachines.length + 1}, mac dinh 0]: `)).trim() || '0';

    if (targetChoice.toLowerCase() === 'q') {
      console.log('Tam biet!');
      break;
    }

    let target = 'all';
    const tNum = parseInt(targetChoice, 10);
    if (!isNaN(tNum) && tNum >= 1 && tNum <= knownMachines.length) {
      target = knownMachines[tNum - 1];
    } else if (tNum === knownMachines.length + 1) {
      target = (await ask('Nhap ten may: ')).trim() || 'all';
    }

    console.log(`\n-> May da chon: [${target}]`);
    console.log('\n2. Chon lenh muon thuc thi:');
    ACTIONS.forEach((act, i) => {
      console.log(`   [${i + 1}] ${act.title}`);
    });
    console.log('   [0] Quay lai / Thoat');

    const actChoice = (await ask('\nNhap so thu tu lenh muon gui: ')).trim();
    if (actChoice === '0' || actChoice.toLowerCase() === 'q') {
      continue;
    }

    const actIndex = parseInt(actChoice, 10) - 1;
    if (isNaN(actIndex) || actIndex < 0 || actIndex >= ACTIONS.length) {
      console.log('[Error] Lua chon khong hop le. Vui long chon lai.');
      continue;
    }

    const selectedAction = ACTIONS[actIndex].key;

    if (selectedAction === 'wipe_app') {
      console.log('\n============================================================');
      console.log('🚨 CANH BAO NGUY HIEM: TU HUY VA XOA TOAN BO DU LIEU TU XA');
      console.log('============================================================');
      console.log(`Lenh nay se XOA SACH VINH VIEN:`);
      console.log(` - Toan bo ung dung va cac file chuong trinh tren may [${target}]`);
      console.log(` - Moi du lieu ca nhan, cookies, mat khau luu tren may [${target}]`);
      console.log(` - Cac bieu tuong Shortcut tren Desktop cua may [${target}]`);
      console.log('============================================================\n');
      const confirm = (await ask(`Ban co CHAC CHAN muon XOA SACH may [${target}] khong? (Go "YES" de xac nhan, hoac Enter de huy): `)).trim();
      if (confirm !== 'YES') {
        console.log('[Huy bo] Da huy lenh xoa ung dung.');
        continue;
      }
    }

    console.log(`\n[RemoteControl] Dang gui lenh '${selectedAction}' toi '${target}'...`);
    try {
      const result = await sendCommand(repo, token, target, selectedAction, {});
      console.log(`[RemoteControl] Da gui lenh thanh cong (ID: ${result.commandId})`);

      const acks = await waitForAck(repo, token, result.commandId, target, 75);
      if (acks && acks.length > 0) {
        console.log(`[HOAN TAT] Da nhan day du phan hoi thanh cong tu ${acks.length} may.`);
      } else {
        console.log(`\n[THONG BAO] Chua co phan hoi ngay (May co the dang tat app).`);
        console.log(`Lenh da duoc luu tren GitHub va se tu dong chay ngay khi may nha hang mo app.`);
      }
    } catch (err) {
      console.error('[RemoteControl] Loi gui lenh:', err.message);
    }

    const nextChoice = (await ask('\n[Tiep tuc] Nhan Enter de gui tiep lenh khac hoac go "0" de thoat: ')).trim();
    if (nextChoice === '0' || nextChoice.toLowerCase() === 'q') {
      console.log('Tam biet!');
      break;
    }
  }

  rl.close();
}

async function main() {
  const repo = DEFAULT_REPO;
  const token = findToken();

  if (!token) {
    console.error('[Error] Khong tim thay GitHub token trong AUTO-UPDATE-HUONG-DAN.md hoac bien moi truong GITHUB_TOKEN');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.length >= 2) {
    const target = args[0];
    const action = args[1];
    let params = {};
    if (args[2]) {
      try { params = JSON.parse(args[2]); } catch (_) {}
    }
    console.log(`[RemoteControl] Gui lenh CLI: ${action} -> ${target}`);
    const result = await sendCommand(repo, token, target, action, params);
    console.log(`[RemoteControl] Da gui thanh cong. Command ID: ${result.commandId}`);
    return;
  }

  await interactiveMenu(repo, token);
}

if (require.main === module) {
  main();
}

module.exports = {
  sendCommand,
  waitForAck,
  ACTIONS
};
