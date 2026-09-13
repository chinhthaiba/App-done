'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { normalizeVersion } = require('../updater/release-format');

const root = path.resolve(__dirname, '..');
const DEFAULT_REPOSITORY = 'chinhthaiba/chinhthaiba-thaiasia-releases';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 60 * 1000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP_GITHUB_RELEASES = 3;
const DEFAULT_KEEP_LOCAL_RELEASES = 3;

function fail(message) {
  throw new Error(message);
}

function tokenFromText(value) {
  const text = String(value || '');
  const match = text.match(/(?:github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]+)/);
  return match ? match[0] : '';
}

function loadToken() {
  const fromEnvironment = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (fromEnvironment) return fromEnvironment;

  const candidates = [
    path.join(root, '.release-secrets', 'github-release-token.txt'),
    path.join(root, 'AUTO-UPDATE-HUONG-DAN.md')
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const token = tokenFromText(fs.readFileSync(candidate, 'utf8'));
    if (token) return token;
  }
  return '';
}

function parseRepository(value) {
  const repository = String(value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  const match = repository.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) fail(`Repository khong hop le: ${repository || '(trong)'}`);
  return { fullName: `${match[1]}/${match[2]}`, owner: match[1], name: match[2] };
}

function apiPath(repository, suffix) {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
}

function githubRequest({ hostname = 'api.github.com', requestPath, method = 'GET', token, body = null, contentType = 'application/json' }) {
  return new Promise((resolve, reject) => {
    const bytes = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8'));
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'ThaiAsia-Release-Publisher',
      'X-GitHub-Api-Version': API_VERSION
    };
    if (bytes) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = bytes.length;
    }

    const request = https.request({ hostname, path: requestPath, method, headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error('GitHub response qua lon'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        if (raw) {
          try { data = JSON.parse(raw); } catch (_) { data = raw; }
        }
        resolve({ statusCode: response.statusCode || 0, headers: response.headers, data, raw });
      });
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('GitHub request timeout')));
    request.on('error', reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}

function responseSummary(response) {
  const message = response && response.data && typeof response.data === 'object'
    ? response.data.message
    : String(response && response.raw || '').slice(0, 300);
  return `HTTP ${response && response.statusCode || 0}${message ? `: ${message}` : ''}`;
}

function requireStatus(response, allowed, action) {
  if (!allowed.includes(response.statusCode)) {
    fail(`${action} that bai (${responseSummary(response)})`);
  }
  return response.data;
}

function compareVersions(left, right) {
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function readKeepCount(envName, fallback) {
  const value = Number(process.env[envName] || '');
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function validatePreparedRelease(version) {
  const outputDir = path.join(root, 'release-output', `v${version}`);
  const infoPath = path.join(outputDir, 'release-info.json');
  if (!fs.existsSync(infoPath)) fail(`Khong tim thay ${infoPath}`);

  const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  if (info.tag !== `v${version}`) fail(`release-info.json sai tag: ${info.tag || '(trong)'}`);
  if (!Array.isArray(info.assets) || info.assets.length !== 3) fail('release-info.json phai co dung 3 assets');

  const uniqueNames = new Set(info.assets);
  if (uniqueNames.size !== info.assets.length) fail('release-info.json co asset trung ten');
  const assets = info.assets.map((name) => {
    if (typeof name !== 'string' || path.basename(name) !== name) fail(`Ten asset khong an toan: ${name}`);
    const filePath = path.join(outputDir, name);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`Thieu asset: ${name}`);
    const size = fs.statSync(filePath).size;
    if (size <= 0) fail(`Asset rong: ${name}`);
    return { name, filePath, size };
  });

  const packageVersion = normalizeVersion(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
  if (packageVersion !== version) fail(`package.json dang la ${packageVersion}, khong phai ${version}`);
  return { outputDir, info, assets };
}

function contentTypeFor(name) {
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.gz$/i.test(name)) return 'application/gzip';
  return 'text/plain; charset=utf-8';
}

async function listReleases(repository, token) {
  const response = await githubRequest({
    requestPath: apiPath(repository, '/releases?per_page=100'),
    token
  });
  const releases = requireStatus(response, [200], 'Doc danh sach GitHub Releases');
  if (!Array.isArray(releases)) fail('GitHub tra ve danh sach release khong hop le');
  return releases;
}

function validatePublishedAssets(release, localAssets) {
  const remoteAssets = (Array.isArray(release.assets) ? release.assets : [])
    .filter((asset) => asset && asset.state === 'uploaded');
  if (remoteAssets.length !== localAssets.length) {
    fail(`Release ${release.tag_name || ''} da public nhung khong co dung ${localAssets.length} assets. Khong tu dong ghi de.`);
  }
  for (const local of localAssets) {
    const matches = remoteAssets.filter((asset) => asset && asset.name === local.name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || Number(matches[0].size) !== local.size) {
      fail(`Release v${release.tag_name || ''} da public nhung asset ${local.name} khong khop. Khong tu dong ghi de.`);
    }
  }
}

async function createDraft(repository, token, version, info) {
  const response = await githubRequest({
    requestPath: apiPath(repository, '/releases'),
    method: 'POST',
    token,
    body: {
      tag_name: `v${version}`,
      name: info.title || `ThaiAsia v${version}`,
      body: `ThaiAsia automatic update v${version}`,
      draft: true,
      prerelease: false,
      generate_release_notes: false
    }
  });
  return requireStatus(response, [201], 'Tao GitHub Release nhap');
}

async function deleteDraftAsset(repository, token, asset) {
  const response = await githubRequest({
    requestPath: apiPath(repository, `/releases/assets/${asset.id}`),
    method: 'DELETE',
    token
  });
  requireStatus(response, [204], `Xoa asset nhap cu ${asset.name}`);
}

async function uploadAsset(repository, token, releaseId, asset) {
  const requestPath = apiPath(repository, `/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`);
  const response = await githubRequest({
    hostname: 'uploads.github.com',
    requestPath,
    method: 'POST',
    token,
    body: fs.readFileSync(asset.filePath),
    contentType: contentTypeFor(asset.name)
  });
  const uploaded = requireStatus(response, [201], `Upload ${asset.name}`);
  if (!uploaded || uploaded.state !== 'uploaded' || Number(uploaded.size) !== asset.size) {
    fail(`GitHub da nhan ${asset.name} nhung kich thuoc/trang thai khong khop`);
  }
  return uploaded;
}

async function verifyDraftAssets(repository, token, releaseId, localAssets) {
  const response = await githubRequest({
    requestPath: apiPath(repository, `/releases/${releaseId}/assets?per_page=100`),
    token
  });
  const remoteAssets = requireStatus(response, [200], 'Kiem tra assets vua upload');
  if (!Array.isArray(remoteAssets) || remoteAssets.length !== localAssets.length) {
    fail(`Release nhap khong co dung ${localAssets.length} assets sau khi upload`);
  }
  for (const local of localAssets) {
    const matches = remoteAssets.filter((asset) => asset && asset.name === local.name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || Number(matches[0].size) !== local.size) {
      fail(`Kiem tra that bai: ${local.name} tren GitHub khong khop file local`);
    }
  }
}

async function publishDraft(repository, token, release, version, info) {
  const response = await githubRequest({
    requestPath: apiPath(repository, `/releases/${release.id}`),
    method: 'PATCH',
    token,
    body: {
      tag_name: `v${version}`,
      name: info.title || `ThaiAsia v${version}`,
      draft: false,
      prerelease: false,
      make_latest: 'true'
    }
  });
  const published = requireStatus(response, [200], 'Public GitHub Release');
  if (!published || published.draft || published.prerelease) fail('GitHub Release chua o trang thai stable/public');
  return published;
}

async function deleteRelease(repository, token, release) {
  const response = await githubRequest({
    requestPath: apiPath(repository, `/releases/${release.id}`),
    method: 'DELETE',
    token
  });
  requireStatus(response, [204], `Xoa GitHub Release ${release.tag_name || release.id}`);
}

async function cleanupGitHubReleases(repository, token, currentVersion) {
  const keepCount = readKeepCount('THAIASIA_KEEP_GITHUB_RELEASES', DEFAULT_KEEP_GITHUB_RELEASES);
  const releases = await listReleases(repository, token);
  const stable = releases
    .filter((item) => item && !item.draft && !item.prerelease && normalizeVersion(item.tag_name))
    .sort((a, b) => compareVersions(normalizeVersion(b.tag_name), normalizeVersion(a.tag_name)));
  const keepIds = new Set(stable.slice(0, keepCount).map((item) => Number(item.id)));
  const oldStable = stable.filter((item) => !keepIds.has(Number(item.id)));
  const staleDrafts = releases.filter((item) => {
    const version = item && normalizeVersion(item.tag_name);
    return item && item.draft && version && version !== currentVersion;
  });

  if (!oldStable.length && !staleDrafts.length) {
    console.log(`[cleanup] GitHub: khong co release cu can xoa (giu ${keepCount} stable gan nhat).`);
    return;
  }

  for (const release of [...oldStable, ...staleDrafts]) {
    console.log(`[cleanup] GitHub xoa ${release.draft ? 'draft' : 'stable cu'} ${release.tag_name || release.id}...`);
    await deleteRelease(repository, token, release);
  }
  console.log(`[cleanup] GitHub: da giu ${keepCount} stable gan nhat va xoa ${oldStable.length + staleDrafts.length} release cu/nhap.`);
}

function cleanupLocalReleaseOutput(currentVersion) {
  const keepCount = readKeepCount('THAIASIA_KEEP_LOCAL_RELEASES', DEFAULT_KEEP_LOCAL_RELEASES);
  const outputRoot = path.join(root, 'release-output');
  if (!fs.existsSync(outputRoot)) return;
  const entries = fs.readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const version = normalizeVersion(entry.name);
      if (!version) return null;
      return {
        name: entry.name,
        version,
        fullPath: path.join(outputRoot, entry.name)
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version));

  const keepNames = new Set(entries.slice(0, keepCount).map((entry) => entry.name));
  keepNames.add(`v${currentVersion}`);
  const toDelete = entries.filter((entry) => !keepNames.has(entry.name));
  if (!toDelete.length) {
    console.log(`[cleanup] Local: khong co folder release-output cu can xoa (giu ${keepCount} ban gan nhat).`);
    return;
  }

  const outputRootResolved = path.resolve(outputRoot);
  for (const entry of toDelete) {
    const resolved = path.resolve(entry.fullPath);
    if (path.dirname(resolved) !== outputRootResolved || !/^v\d+\.\d+\.\d+$/.test(entry.name)) {
      fail(`Tu choi xoa duong dan release-output khong an toan: ${entry.fullPath}`);
    }
    console.log(`[cleanup] Local xoa ${entry.name}...`);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  console.log(`[cleanup] Local: da giu ${keepCount} folder gan nhat va xoa ${toDelete.length} folder cu.`);
}

async function main() {
  const version = normalizeVersion(process.argv[2]);
  const dryRun = process.argv.includes('--dry-run');
  if (!version || version.includes('-')) {
    console.error('Usage: node scripts/publish-update-release.js <major.minor.patch> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const prepared = validatePreparedRelease(version);
  const repository = parseRepository(process.env.THAIASIA_GITHUB_REPOSITORY || DEFAULT_REPOSITORY);
  console.log(`[publish] Da kiem tra goi v${version}: ${prepared.assets.length} files`);
  if (dryRun) {
    console.log('[publish] Dry-run OK. Khong thay doi GitHub.');
    return;
  }

  const token = loadToken();
  if (!token) {
    fail('Khong tim thay GitHub token. Dat GITHUB_TOKEN hoac tao .release-secrets\\github-release-token.txt');
  }

  console.log(`[publish] Repository: ${repository.fullName}`);
  const releases = await listReleases(repository, token);
  let release = releases.find((item) => item && item.tag_name === `v${version}`);

  if (release && !release.draft) {
    if (release.prerelease) fail(`v${version} da ton tai nhung dang la pre-release`);
    validatePublishedAssets(release, prepared.assets);
    console.log(`[publish] v${version} da duoc public day du. Khong can upload lai.`);
    console.log(`[publish] ${release.html_url || ''}`);
    await cleanupGitHubReleases(repository, token, version);
    cleanupLocalReleaseOutput(version);
    return;
  }

  const stableVersions = releases
    .filter((item) => item && !item.draft && !item.prerelease)
    .map((item) => normalizeVersion(item.tag_name))
    .filter((item) => item && !item.includes('-'));
  const newestVersion = stableVersions.sort(compareVersions).at(-1);
  if (newestVersion && compareVersions(version, newestVersion) <= 0) {
    fail(`Version ${version} phai lon hon ban stable hien tai ${newestVersion}`);
  }

  if (!release) {
    console.log(`[publish] Tao Release nhap v${version}...`);
    release = await createDraft(repository, token, version, prepared.info);
  } else {
    console.log(`[publish] Tiep tuc Release nhap v${version} da co...`);
  }
  if (!release || !Number.isInteger(Number(release.id))) fail('GitHub Release khong co ID hop le');

  const expectedNames = new Set(prepared.assets.map((asset) => asset.name));
  const existingAssets = Array.isArray(release.assets) ? release.assets : [];
  const unexpectedAssets = existingAssets.filter((asset) => asset && !expectedNames.has(asset.name));
  if (unexpectedAssets.length) {
    fail(`Release nhap co asset la: ${unexpectedAssets.map((asset) => asset.name).join(', ')}. Hay xoa thu cong roi chay lai.`);
  }
  for (const asset of existingAssets) {
    if (asset && expectedNames.has(asset.name)) {
      console.log(`[publish] Xoa asset nhap cu: ${asset.name}`);
      await deleteDraftAsset(repository, token, asset);
    }
  }

  for (const asset of prepared.assets) {
    console.log(`[publish] Upload ${asset.name} (${asset.size} bytes)...`);
    await uploadAsset(repository, token, Number(release.id), asset);
  }
  await verifyDraftAssets(repository, token, Number(release.id), prepared.assets);

  console.log('[publish] Da upload va kiem tra du 3 files. Dang public...');
  const published = await publishDraft(repository, token, release, version, prepared.info);
  console.log(`[publish] THANH CONG: v${version} da len GitHub.`);
  console.log(`[publish] ${published.html_url || ''}`);
  await cleanupGitHubReleases(repository, token, version);
  cleanupLocalReleaseOutput(version);
}

main().catch((error) => {
  console.error(`[publish] THAT BAI: ${error && error.message ? error.message : String(error)}`);
  console.error('[publish] Neu Release nhap da duoc tao, no van giu o Draft va app se khong tai ban loi.');
  process.exitCode = 1;
});
