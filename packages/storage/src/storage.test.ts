import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDiskStorage, validateFileContent } from './index.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2b3f3ab0000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<<>>\nendobj\n', 'latin1');

let root: string;

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe('LocalDiskStorage', () => {
  it('stores, reads, copies and deletes objects', async () => {
    root = await mkdtemp(join(tmpdir(), 'a5-storage-'));
    const storage = new LocalDiskStorage({ root, publicBaseUrl: 'http://localhost:4030/dev-storage', signingSecret: 'x'.repeat(32) });
    await storage.putObject('certs/a/stamp.png', PNG, { contentType: 'image/png' });
    expect(await storage.headObject('certs/a/stamp.png')).toMatchObject({ size: PNG.length, contentType: 'image/png' });
    expect((await storage.getBytes('certs/a/stamp.png', { start: 0, end: 3 })).toString('hex')).toBe('89504e47');
    await storage.copyObject('certs/a/stamp.png', 'certs/b/stamp.png');
    expect(await storage.headObject('certs/b/stamp.png')).not.toBeNull();
    await storage.deleteObject('certs/a/stamp.png');
    expect(await storage.headObject('certs/a/stamp.png')).toBeNull();
  });

  it('rejects path traversal keys', async () => {
    const storage = new LocalDiskStorage({ root, publicBaseUrl: 'http://x', signingSecret: 'x'.repeat(32) });
    await expect(storage.putObject('../../etc/passwd', PNG, { contentType: 'image/png' })).rejects.toThrow('Invalid object key');
  });

  it('signs and verifies URLs with expiry', async () => {
    const storage = new LocalDiskStorage({ root, publicBaseUrl: 'http://x', signingSecret: 'x'.repeat(32) });
    const url = new URL(await storage.signedGetUrl('k/1', { expiresInSeconds: 60 }));
    const key = url.searchParams.get('key')!;
    const expires = Number(url.searchParams.get('expires'));
    const sig = url.searchParams.get('sig')!;
    expect(storage.verify(key, expires, sig)).toBe(true);
    expect(storage.verify('k/2', expires, sig)).toBe(false);
    expect(storage.verify(key, Math.floor(Date.now() / 1000) - 1, storage.sign(key, Math.floor(Date.now() / 1000) - 1))).toBe(false);
  });
});

describe('validateFileContent', () => {
  it('accepts content that matches the declared type', async () => {
    expect(await validateFileContent('certificateImage', 'image/png', PNG)).toEqual({ ok: true, mime: 'image/png' });
    expect(await validateFileContent('document', 'application/pdf', PDF)).toEqual({ ok: true, mime: 'application/pdf' });
  });

  it('rejects disallowed or mismatched types', async () => {
    expect((await validateFileContent('certificateImage', 'image/svg+xml', PNG)).ok).toBe(false);
    expect(await validateFileContent('certificateImage', 'image/jpeg', PNG)).toMatchObject({ ok: false });
    expect((await validateFileContent('image', 'image/png', Buffer.from('<script>alert(1)</script>'))).ok).toBe(false);
  });

  it('checks WebVTT captions by header', async () => {
    expect((await validateFileContent('caption', 'text/vtt', Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHi'))).ok).toBe(true);
    expect((await validateFileContent('caption', 'text/vtt', Buffer.from('1\n00:00:00,000 --> 00:00:01,000'))).ok).toBe(false);
  });
});
