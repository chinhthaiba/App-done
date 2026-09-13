'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const releaseFiles = require('../updater/release-files');
const {
  SCHEMA_VERSION,
  MANIFEST_ASSET_NAME,
  SIGNATURE_ASSET_NAME,
  normalizeVersion,
  sha256,
  normalizeReleasePath
} = require('../updater/release-format');

const root = path.resolve(__dirname, '..');
const privateKeyPath = path.join(root, '.release-secrets', 'update-private-key.pem');
const packagePath = path.join(root, 'package.json');
const packageLockPath = path.join(root, 'package-lock.json');
const requestedVersion = normalizeVersion(process.argv[2]);

if (!requestedVersion || requestedVersion.includes('-')) {
  console.error('Usage: node scripts/prepare-update-release.js <major.minor.patch>');
  process.exit(1);
}
if (!fs.existsSync(privateKeyPath)) {
  console.error('[release] Missing signing key. Run: npm run update:keygen');
  process.exit(1);
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = requestedVersion;
writeJson(packagePath, pkg);

if (fs.existsSync(packageLockPath)) {
  const lock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  lock.version = requestedVersion;
  if (lock.packages && lock.packages['']) lock.packages[''].version = requestedVersion;
  writeJson(packageLockPath, lock);
}

const files = releaseFiles.map((relativePath) => {
  const safePath = normalizeReleasePath(relativePath);
  const absolutePath = path.join(root, ...safePath.split('/'));
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`Required release file is missing: ${safePath}`);
  }
  const data = fs.readFileSync(absolutePath);
  return {
    path: safePath,
    size: data.length,
    sha256: sha256(data),
    data: data.toString('base64')
  };
});

const bundle = {
  schemaVersion: SCHEMA_VERSION,
  version: requestedVersion,
  createdAt: new Date().toISOString(),
  files
};
const bundleName = `thaiasia-app-v${requestedVersion}.bundle.json.gz`;
const bundleBytes = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'), { level: 9 });
const manifest = {
  schemaVersion: SCHEMA_VERSION,
  version: requestedVersion,
  channel: 'stable',
  publishedAt: new Date().toISOString(),
  minimumElectron: '22.3.27',
  bundle: {
    name: bundleName,
    size: bundleBytes.length,
    sha256: sha256(bundleBytes)
  }
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
const signature = crypto.sign(null, manifestBytes, privateKey).toString('base64');
const outputDir = path.join(root, 'release-output', `v${requestedVersion}`);

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, bundleName), bundleBytes);
fs.writeFileSync(path.join(outputDir, MANIFEST_ASSET_NAME), manifestBytes);
fs.writeFileSync(path.join(outputDir, SIGNATURE_ASSET_NAME), `${signature}\n`, 'utf8');
writeJson(path.join(outputDir, 'release-info.json'), {
  tag: `v${requestedVersion}`,
  title: `ThaiAsia v${requestedVersion}`,
  assets: [bundleName, MANIFEST_ASSET_NAME, SIGNATURE_ASSET_NAME]
});

console.log('[release] Prepared:', outputDir);
console.log('[release] Version :', requestedVersion);
console.log('[release] Files   :', files.length);
console.log('[release] Bundle  :', `${(bundleBytes.length / 1024).toFixed(1)} KiB`);
console.log('[release] Ready for automatic GitHub publishing.');
