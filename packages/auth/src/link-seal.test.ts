import { describe, expect, it } from 'vitest';
import { isSealedLink, sealLink, unsealLink } from './link-seal.js';

const SECRET = 'x'.repeat(40);
const URL_ = 'https://academy.example/activate?token=abc123';

describe('link sealing', () => {
  it('round-trips and hides the token', () => {
    const sealed = sealLink(SECRET, URL_);
    expect(isSealedLink(sealed)).toBe(true);
    expect(sealed).not.toContain('abc123');
    expect(unsealLink(SECRET, sealed)).toBe(URL_);
  });

  it('uses a fresh IV each time', () => {
    expect(sealLink(SECRET, URL_)).not.toBe(sealLink(SECRET, URL_));
  });

  it('rejects another key and tampering', () => {
    const sealed = sealLink(SECRET, URL_);
    expect(() => unsealLink('y'.repeat(40), sealed)).toThrow();
    expect(() => unsealLink(SECRET, `${sealed.slice(0, -2)}AA`)).toThrow();
  });

  it('passes unsealed values through for in-flight legacy events', () => {
    expect(unsealLink(SECRET, URL_)).toBe(URL_);
  });
});
