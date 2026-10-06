#!/usr/bin/env node
// Generates development secrets: Ed25519 JWT keys, service auth secrets, and producer HMAC keys.
// It creates .env from .env.example and refuses to replace an existing file. Never use these keys
// in production.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const envPath = new URL('../../.env', import.meta.url);
const examplePath = new URL('../../.env.example', import.meta.url);
if (existsSync(envPath)) {
  throw new Error('.env already exists; refusing to overwrite local configuration or secrets.');
}
copyFileSync(examplePath, envPath);

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const oneLine = (pem) => pem.trim().replace(/\n/g, '\\n');
const values = {
  AUTH_JWT_PRIVATE_KEY: `"${oneLine(privateKey)}"`,
  AUTH_JWT_PUBLIC_KEY: `"${oneLine(publicKey)}"`,
  INTERNAL_AUTH_SECRET: randomBytes(32).toString('base64url'),
  STORAGE_SIGNING_SECRET: randomBytes(32).toString('base64url'),
};
for (const producer of [
  'identity-service',
  'learning-service',
  'media-service',
  'assessment-service',
  'ai-coaching-service',
  'certification-service',
  'notification-service',
  'analytics-service',
  'audit-service',
  'gateway',
]) {
  values[`EVENT_SIGNING_SECRET_${producer.toUpperCase().replace(/-/g, '_')}`] =
    randomBytes(32).toString('base64url');
}

let content = readFileSync(envPath, 'utf8');
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
}
writeFileSync(envPath, content);
console.log('Wrote development keys to .env');
