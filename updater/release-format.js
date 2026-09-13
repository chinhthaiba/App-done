'use strict';

const crypto = require('crypto');
const path = require('path');

const SCHEMA_VERSION = 1;
const MANIFEST_ASSET_NAME = 'thaiasia-update-manifest.json';
const SIGNATURE_ASSET_NAME = 'thaiasia-update-manifest.sig';
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_SIGNATURE_BYTES = 16 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

function parseVersion(input) {
  const match = String(input || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || ''
  };
}

function normalizeVersion(input) {
  const parsed = parseVersion(input);
  if (!parsed) return '';
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ''}`;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid semantic version comparison: ${left} / ${right}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeReleasePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.includes('\0')) {
    throw new Error(`Unsafe release path: ${raw || '<empty>'}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Unsafe release path: ${raw}`);
  }
  return normalized;
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Update manifest is not an object');
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported manifest schema: ${manifest.schemaVersion}`);
  const version = normalizeVersion(manifest.version);
  if (!version || version !== manifest.version) throw new Error(`Invalid manifest version: ${manifest.version}`);
  if (!manifest.bundle || typeof manifest.bundle !== 'object') throw new Error('Manifest bundle is missing');
  const name = String(manifest.bundle.name || '');
  if (!/^thaiasia-app-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.bundle\.json\.gz$/.test(name)) {
    throw new Error(`Unexpected bundle name: ${name}`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(manifest.bundle.sha256 || ''))) throw new Error('Invalid bundle SHA-256');
  const size = Number(manifest.bundle.size);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BUNDLE_BYTES) throw new Error(`Invalid bundle size: ${size}`);
  return { ...manifest, version, bundle: { ...manifest.bundle, name, size } };
}

module.exports = {
  SCHEMA_VERSION,
  MANIFEST_ASSET_NAME,
  SIGNATURE_ASSET_NAME,
  MAX_MANIFEST_BYTES,
  MAX_SIGNATURE_BYTES,
  MAX_BUNDLE_BYTES,
  parseVersion,
  normalizeVersion,
  compareVersions,
  sha256,
  normalizeReleasePath,
  validateManifest
};

