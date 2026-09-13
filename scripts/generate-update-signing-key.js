'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const secretDir = path.join(root, '.release-secrets');
const privateKeyPath = path.join(secretDir, 'update-private-key.pem');
const publicKeyPath = path.join(root, 'updater', 'update-public-key.pem');

if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
  console.error('[signing-key] Refusing to overwrite an existing signing key.');
  console.error('[signing-key] Private:', privateKeyPath);
  console.error('[signing-key] Public :', publicKeyPath);
  process.exit(1);
}

fs.mkdirSync(secretDir, { recursive: true });
fs.mkdirSync(path.dirname(publicKeyPath), { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { encoding: 'utf8', mode: 0o600 });
fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }), 'utf8');

console.log('[signing-key] Created private key:', privateKeyPath);
console.log('[signing-key] Created public key :', publicKeyPath);
console.log('[signing-key] Back up the private key securely. Never upload or share it.');

