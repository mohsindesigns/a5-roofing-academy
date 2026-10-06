import { describe, expect, it } from 'vitest';
import { certification as c } from '@a5/contracts';
import {
  CSS_FONTS,
  FALLBACK_SAMPLE_VALUES,
  FALLBACK_SOURCES,
  buildPreviewModel,
  imageFingerprint,
  resolveText,
  signatureSlot,
  sourcesFromPreview,
} from './template-preview';
import type { TemplateDesign, TemplatePreview } from './types';

const ASSET = '0190aaaa-0000-7000-8000-0000000000a1';
const BACKGROUND = '0190aaaa-0000-7000-8000-0000000000b2';

function design(overrides: Partial<c.TemplateDesignInput> = {}): TemplateDesign {
  return c.templateDesignSchema.parse({
    page: { size: 'LETTER', orientation: 'landscape' },
    theme: {
      backgroundColor: '#FFFDF7',
      border: { style: 'double', color: '#1F2A44', width: 2.5, inset: 3.5 },
      accentColor: '#B08D3C',
      fontFamily: 'serif',
    },
    elements: [
      {
        id: 'name',
        type: 'text',
        content: '  {{recipient_name}}   completed {{program_name}} ',
        x: 10,
        y: 30,
        width: 80,
        height: 10,
        fontSize: 32,
        fontWeight: 'bold',
        uppercase: true,
      },
      {
        id: 'sig-2',
        type: 'signature',
        content: '{{signatory_2_signature}}',
        x: 60,
        y: 60,
        width: 25,
        height: 10,
      },
      {
        id: 'sig-1',
        type: 'signature',
        content: '{{signatory_1_signature}}',
        x: 10,
        y: 60,
        width: 25,
        height: 10,
      },
      {
        id: 'seal',
        type: 'stamp',
        content: '{{organization_stamp}}',
        x: 42,
        y: 60,
        width: 16,
        height: 20,
      },
      { id: 'qr', type: 'qr', content: '{{qr_code}}', x: 86, y: 82, width: 8, height: 10 },
      { id: 'logo', type: 'logo', assetId: ASSET, x: 42, y: 5, width: 16, height: 12 },
      { id: 'rule', type: 'line', x: 20, y: 50, width: 60, height: 0.8, strokeWidth: 1.5 },
      {
        id: 'tag',
        type: 'text',
        content: 'Verified',
        x: 10,
        y: 90,
        width: 20,
        height: 4,
        fontFamily: 'display',
        fontWeight: 'normal',
      },
    ],
    ...overrides,
  });
}

describe('resolveText', () => {
  it('fills placeholders, collapses spaces and applies capitals', () => {
    expect(
      resolveText(
        { content: '  Hello   {{recipient_name}} ', uppercase: false },
        { recipient_name: 'Jordan Ellis' },
      ),
    ).toBe('Hello Jordan Ellis');
    expect(
      resolveText(
        { content: '{{certificate_name}}', uppercase: true },
        { certificate_name: 'Sales Pro' },
      ),
    ).toBe('SALES PRO');
  });

  it('turns an unknown placeholder into nothing instead of leaving braces on screen', () => {
    expect(resolveText({ content: 'A{{nope}}B', uppercase: false }, {})).toBe('AB');
  });
});

describe('buildPreviewModel', () => {
  const sources = {
    ...FALLBACK_SOURCES,
    signatureUrls: { 1: 'https://files.test/sig-1.png', 2: 'https://files.test/sig-2.png' },
    stampUrl: 'https://files.test/seal.png',
    assetUrls: { [ASSET]: 'https://files.test/logo.png' },
  };
  const model = buildPreviewModel(design(), sources);
  const el = (id: string) => model.elements.find((e) => e.id === id)!;

  it('uses the same page dimensions as the PDF renderer', () => {
    expect(model.widthPt).toBe(792);
    expect(model.heightPt).toBe(612);
    const portrait = buildPreviewModel(
      design({ page: { size: 'A4', orientation: 'portrait' } }),
      sources,
    );
    expect(portrait.widthPt).toBeCloseTo(595.28, 2);
    expect(portrait.heightPt).toBeCloseTo(841.89, 2);
  });

  it('keeps element geometry in percent of the page', () => {
    expect(el('name')).toMatchObject({ x: 10, y: 30, width: 80, height: 10, fontSize: 32 });
  });

  it('resolves text with sample values', () => {
    expect(el('name').text).toBe(
      `${FALLBACK_SAMPLE_VALUES['recipient_name']!.toUpperCase()} COMPLETED ${FALLBACK_SAMPLE_VALUES['program_name']!.toUpperCase()}`,
    );
    expect(el('rule').text).toBeNull();
  });

  it('puts each signature in its own slot, whatever the order in the design', () => {
    expect(el('sig-1').imageUrl).toBe('https://files.test/sig-1.png');
    expect(el('sig-2').imageUrl).toBe('https://files.test/sig-2.png');
    expect(signatureSlot({ content: '{{signatory_2_signature}}' })).toBe(2);
    expect(signatureSlot({ content: '{{signatory_1_signature}}' })).toBe(1);
  });

  it('maps stamp and uploaded images, and leaves a gap while an image is not available', () => {
    expect(el('seal').imageUrl).toBe('https://files.test/seal.png');
    expect(el('logo').imageUrl).toBe('https://files.test/logo.png');
    const empty = buildPreviewModel(design(), FALLBACK_SOURCES);
    expect(empty.elements.find((e) => e.id === 'logo')!.imageUrl).toBeNull();
    expect(empty.elements.find((e) => e.id === 'sig-1')!.imageUrl).toBeNull();
  });

  it('encodes the verification address in QR elements only', () => {
    expect(el('qr').qrValue).toBe(FALLBACK_SOURCES.qrValue);
    expect(el('name').qrValue).toBeNull();
  });

  it('uses CSS font stacks matching the PDF fonts and always bolds the display family', () => {
    expect(el('name').cssFontFamily).toBe(CSS_FONTS.serif);
    expect(el('tag').cssFontFamily).toBe(CSS_FONTS.display);
    expect(el('tag').fontWeight).toBe('bold');
    expect(el('name').fontWeight).toBe('bold');
  });

  it('describes elements for assistive technology', () => {
    expect(el('sig-2').label).toBe('Signature 2');
    expect(el('seal').label).toBe('Stamp');
    expect(el('tag').label).toBe('Text: Verified');
  });

  it('carries the theme: background image, border and accent colour', () => {
    const themed = buildPreviewModel(
      design({
        theme: {
          backgroundColor: '#FFFFFF',
          backgroundImageAssetId: BACKGROUND,
          border: { style: 'ornamental', color: '#111111', width: 3, inset: 4 },
          accentColor: '#B4531F',
          fontFamily: 'sans',
        },
      }),
      {
        ...sources,
        assetUrls: { ...sources.assetUrls, [BACKGROUND]: 'https://files.test/bg.jpg' },
      },
    );
    expect(themed.backgroundImageUrl).toBe('https://files.test/bg.jpg');
    expect(themed.border).toMatchObject({ style: 'ornamental', width: 3, inset: 4 });
    expect(themed.accentColor).toBe('#B4531F');
  });
});

describe('sourcesFromPreview', () => {
  const d = design({
    theme: {
      backgroundColor: '#FFFFFF',
      backgroundImageAssetId: BACKGROUND,
      border: { style: 'none', color: '#111111', width: 1, inset: 3 },
      accentColor: '#B4531F',
      fontFamily: 'sans',
    },
  });
  const resolved = (id: string, type: string, imageUrl: string | null) => ({
    id,
    type,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    text: null,
    imageUrl,
    qrValue: null,
    align: 'center',
    fontSize: 12,
    fontWeight: 'normal',
    fontStyle: 'normal',
    fontFamily: 'sans',
    cssFontFamily: 'sans-serif',
    color: '#000000',
    letterSpacing: 0,
    uppercase: false,
    lineHeight: 1.2,
    strokeWidth: 1,
  });
  const preview = {
    pdfUrl: 'https://files.test/sample.pdf',
    expiresAt: '2026-10-05T17:00:00.000Z',
    page: { size: 'LETTER', orientation: 'landscape', widthPt: 792, heightPt: 612 },
    theme: { ...d.theme, backgroundImageUrl: 'https://files.test/bg.jpg' },
    elements: [
      resolved('sig-1', 'signature', 'https://files.test/s1.png'),
      resolved('sig-2', 'signature', 'https://files.test/s2.png'),
      resolved('seal', 'stamp', 'https://files.test/seal.png'),
      resolved('logo', 'logo', 'https://files.test/logo.png'),
    ],
    sampleValues: {
      recipient_name: 'Jordan Ellis',
      verification_url: 'https://a5.test/verify/SAMPLE-PREVIEW',
    },
    warnings: [],
  } as unknown as TemplatePreview;

  it('takes values and signed image links from the API sample', () => {
    const s = sourcesFromPreview(preview, d);
    expect(s.values['recipient_name']).toBe('Jordan Ellis');
    expect(s.qrValue).toBe('https://a5.test/verify/SAMPLE-PREVIEW');
    expect(s.signatureUrls).toEqual({
      1: 'https://files.test/s1.png',
      2: 'https://files.test/s2.png',
    });
    expect(s.stampUrl).toBe('https://files.test/seal.png');
    expect(s.assetUrls).toMatchObject({
      [ASSET]: 'https://files.test/logo.png',
      [BACKGROUND]: 'https://files.test/bg.jpg',
    });
  });
});

describe('imageFingerprint', () => {
  it('ignores text edits and moves, but changes when an image or signature slot changes', () => {
    const base = design();
    const edited = design();
    edited.elements[0] = { ...edited.elements[0]!, content: 'Something else', x: 20 };
    expect(imageFingerprint(edited)).toBe(imageFingerprint(base));

    const swapped = design();
    swapped.elements[1] = { ...swapped.elements[1]!, content: '{{signatory_1_signature}}' };
    expect(imageFingerprint(swapped)).not.toBe(imageFingerprint(base));

    const reuploaded = design();
    reuploaded.elements[5] = { ...reuploaded.elements[5]!, assetId: BACKGROUND };
    expect(imageFingerprint(reuploaded)).not.toBe(imageFingerprint(base));
  });
});
