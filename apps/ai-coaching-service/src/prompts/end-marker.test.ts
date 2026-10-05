import { describe, expect, it } from 'vitest';
import { EndMarkerFilter, stripEndMarkers } from './end-marker.js';

function run(chunks: string[]) {
  const filter = new EndMarkerFilter();
  const forwarded = chunks.map((c) => filter.push(c));
  const { tail, text, endReason } = filter.finish();
  return { forwarded: forwarded.join('') + tail, text, endReason };
}

describe('EndMarkerFilter', () => {
  it('passes ordinary text through unchanged', () => {
    expect(run(['Look, ', "I don't ", 'have time.'])).toEqual({
      forwarded: "Look, I don't have time.",
      text: "Look, I don't have time.",
      endReason: null,
    });
  });

  it('removes a marker at the end and reports the reason', () => {
    expect(run(['Okay, Thursday works. [[END:objective_reached]]'])).toEqual({
      forwarded: 'Okay, Thursday works. ',
      text: 'Okay, Thursday works.',
      endReason: 'objective_reached',
    });
  });

  it('never leaks a marker split across deltas', () => {
    for (const split of [3, 5, 8, 12, 20]) {
      const full = 'Fine. Have a good day. [[END:homeowner_ended]]';
      const out = run([full.slice(0, 22 + split - 3), full.slice(22 + split - 3)]);
      expect(out.forwarded).not.toContain('[[');
      expect(out.forwarded).not.toContain('END');
      expect(out.endReason).toBe('homeowner_ended');
    }
    const oneByOne = run([...'Okay. [[END:objective_reached]]']);
    expect(oneByOne.forwarded.trim()).toBe('Okay.');
    expect(oneByOne.endReason).toBe('objective_reached');
  });

  it('releases text that only looks like the start of a marker', () => {
    expect(run(['The price is [[not a marker]] ok']).forwarded).toBe(
      'The price is [[not a marker]] ok',
    );
    expect(run(['Call me [', 'later']).forwarded).toBe('Call me [later');
    expect(run(['Dangling [[EN']).forwarded).toBe('Dangling [[EN');
  });

  it('removes unknown END markers without ending the conversation', () => {
    const out = run(['Hello [[END:something_else]] there']);
    expect(out.endReason).toBeNull();
    expect(out.text).toBe('Hello there');
  });

  it('strips markers from a complete reply', () => {
    expect(stripEndMarkers('Thanks, bye. [[END:homeowner_ended]]')).toEqual({
      text: 'Thanks, bye.',
      endReason: 'homeowner_ended',
    });
    expect(stripEndMarkers('Just text')).toEqual({ text: 'Just text', endReason: null });
  });
});
