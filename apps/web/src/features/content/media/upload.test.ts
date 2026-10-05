import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { media } from '@a5/contracts';
import {
  UploadError,
  acceptAttribute,
  kindOfFile,
  parseClock,
  resolveMime,
  titleFromFilename,
  uploadToStorage,
} from './upload';

class FakeXhr {
  static last: FakeXhr;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  status = 0;
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

beforeEach(() => {
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

const expires = '2026-10-05T18:00:00.000Z';
const file = new File(['hello world'], 'welcome.mp4', { type: 'video/mp4' });

describe('uploadToStorage', () => {
  it('posts policy fields before the file and reports progress', async () => {
    const target: media.UploadTarget = {
      method: 'POST',
      url: 'https://storage.example/bucket',
      fields: { key: 'media/o/a/source', policy: 'abc', 'x-amz-signature': 'sig' },
      headers: {},
      expiresAt: expires,
    };
    const progress = vi.fn();
    const done = uploadToStorage(target, file, progress);
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('POST');
    const names = [...(xhr.body as FormData).keys()];
    expect(names).toEqual(['key', 'policy', 'x-amz-signature', 'file']);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 11 });
    expect(progress).toHaveBeenLastCalledWith({ loaded: 4, total: 11 });
    xhr.status = 204;
    xhr.onload?.();
    await expect(done).resolves.toBeUndefined();
    expect(progress).toHaveBeenLastCalledWith({ loaded: file.size, total: file.size });
  });

  it('puts the file with the required headers', async () => {
    const target: media.UploadTarget = {
      method: 'PUT',
      url: '/api/v1/media/dev-storage/upload?key=k&sig=s',
      fields: {},
      headers: { 'content-type': 'video/mp4' },
      expiresAt: expires,
    };
    const done = uploadToStorage(target, file, () => {});
    const xhr = FakeXhr.last;
    expect(xhr.method).toBe('PUT');
    expect(xhr.headers).toEqual({ 'content-type': 'video/mp4' });
    expect(xhr.body).toBe(file);
    xhr.status = 200;
    xhr.onload?.();
    await done;
  });

  it('explains rejections and dropped connections', async () => {
    const target: media.UploadTarget = {
      method: 'PUT',
      url: '/u',
      fields: {},
      headers: {},
      expiresAt: expires,
    };
    const expired = uploadToStorage(target, file, () => {});
    FakeXhr.last.status = 403;
    FakeXhr.last.onload?.();
    await expect(expired).rejects.toMatchObject({
      kind: 'rejected',
      status: 403,
      message: /expired/,
    });

    const dropped = uploadToStorage(target, file, () => {});
    FakeXhr.last.onerror?.();
    await expect(dropped).rejects.toMatchObject({ kind: 'network' });
  });

  it('can be cancelled', async () => {
    const target: media.UploadTarget = {
      method: 'PUT',
      url: '/u',
      fields: {},
      headers: {},
      expiresAt: expires,
    };
    const controller = new AbortController();
    const pending = uploadToStorage(target, file, () => {}, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(UploadError);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    expect(FakeXhr.last.aborted).toBe(true);
  });
});

describe('file checks', () => {
  it('maps files to a library kind using the shared MIME table', () => {
    expect(kindOfFile({ name: 'intro.mp4', type: 'video/mp4' })).toBe('video');
    expect(kindOfFile({ name: 'playbook.pdf', type: 'application/pdf' })).toBe('document');
    expect(kindOfFile({ name: 'roof.JPG', type: 'image/jpeg' })).toBe('image');
    expect(kindOfFile({ name: 'script.exe', type: 'application/x-msdownload' })).toBeNull();
    // Browsers sometimes report no type for .mkv or .mov files.
    expect(kindOfFile({ name: 'walkthrough.mov', type: '' })).toBe('video');
    // A video type with a document extension is not trusted.
    expect(kindOfFile({ name: 'notes.pdf', type: 'video/mp4' })).toBeNull();
    expect(resolveMime({ name: 'a.webm', type: '' })).toBe('video/webm');
  });

  it('builds the file picker filter from the same table', () => {
    const accept = acceptAttribute();
    expect(accept).toContain('video/mp4');
    expect(accept).toContain('.pdf');
    expect(accept).not.toContain('text/vtt');
  });

  it('derives a readable title from a file name', () => {
    expect(titleFromFilename('door_knock-walkthrough_v2.mp4')).toBe('door knock walkthrough v2');
    expect(titleFromFilename('.hidden')).toBe('.hidden');
  });
});

describe('parseClock', () => {
  it('reads minutes, hours and plain seconds', () => {
    expect(parseClock('1:05')).toBe(65);
    expect(parseClock('01:02:03')).toBe(3723);
    expect(parseClock('90')).toBe(90);
    expect(parseClock(' 0:00 ')).toBe(0);
  });

  it('rejects text, empty input and out-of-range parts', () => {
    expect(parseClock('')).toBeNull();
    expect(parseClock('abc')).toBeNull();
    expect(parseClock('1:75')).toBeNull();
    expect(parseClock('1:2:3:4')).toBeNull();
    expect(parseClock('-5')).toBeNull();
  });
});
