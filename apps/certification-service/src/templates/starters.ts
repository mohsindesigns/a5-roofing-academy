import { certification } from '@a5/contracts';

type DesignInput = certification.TemplateDesignInput;
type ElementInput = DesignInput['elements'][number];

const NAVY = '#1F2A44';
const GOLD = '#8C6D2C';
const SLATE = '#4B5563';
const MUTED = '#6B7280';
const INK = '#111827';
const COPPER = '#B4531F';

function text(id: string, content: string, x: number, y: number, width: number, height: number, style: Partial<ElementInput> = {}): ElementInput {
  return { id, type: 'text', content, x, y, width, height, ...style };
}

function line(id: string, x: number, y: number, width: number, color: string, strokeWidth: number): ElementInput {
  return { id, type: 'line', x, y, width, height: 0.8, color, strokeWidth };
}

function signatureBlock(slot: 1 | 2, x: number, top: number, width: number, align: 'left' | 'center', imageHeight: number, color: string): ElementInput[] {
  const lineY = top + imageHeight + 0.3;
  return [
    { id: `signature-${slot}`, type: 'signature', content: `{{signatory_${slot}_signature}}`, x, y: top, width, height: imageHeight, align },
    line(`signature-${slot}-rule`, x, lineY, width, color, 0.75),
    text(`signatory-${slot}-name`, `{{signatory_${slot}_name}}`, x, lineY + 0.9, width, 3.4, { fontSize: 10.5, fontWeight: 'bold', color, align }),
    text(`signatory-${slot}-title`, `{{signatory_${slot}_title}}`, x, lineY + 4.2, width, 3, { fontSize: 8.5, color: SLATE, align }),
  ];
}

/** Letter landscape, ivory paper, navy double frame with gold accents, classic serif type. */
const classic: DesignInput = {
  schemaVersion: 1,
  page: { size: 'LETTER', orientation: 'landscape' },
  theme: {
    backgroundColor: '#FFFDF7',
    backgroundImageAssetId: null,
    border: { style: 'double', color: NAVY, width: 2.5, inset: 3.5 },
    accentColor: '#B08D3C',
    fontFamily: 'serif',
  },
  elements: [
    text('organization', '{{organization_name}}', 10, 9, 80, 4.5, { fontSize: 13, fontWeight: 'bold', uppercase: true, letterSpacing: 4, color: GOLD }),
    text('title', 'Certificate of Achievement', 10, 14.5, 80, 10, { fontSize: 40, color: NAVY }),
    line('title-rule', 42, 25, 16, '#B08D3C', 1.5),
    text('intro', 'This certifies that', 10, 27.5, 80, 4.5, { fontSize: 13, fontStyle: 'italic', color: SLATE }),
    text('recipient', '{{recipient_name}}', 10, 32.5, 80, 10, { fontSize: 38, fontWeight: 'bold', color: NAVY }),
    line('recipient-rule', 27, 43, 46, '#B08D3C', 0.75),
    text('body', 'has completed every requirement of the {{program_name}} and is hereby recognized as an', 15, 45.5, 70, 7.5, {
      fontSize: 12.5,
      color: '#374151',
      lineHeight: 1.3,
    }),
    text('certification', '{{certificate_name}}', 10, 53.5, 80, 6.5, { fontSize: 21, fontWeight: 'bold', color: GOLD }),
    text('dates', 'Issued {{issue_date}}  ·  Valid through {{expiration_date}}', 15, 60.5, 70, 3.8, { fontSize: 10.5, color: SLATE }),
    ...signatureBlock(1, 11, 65, 24, 'center', 11, NAVY),
    { id: 'stamp', type: 'stamp', content: '{{organization_stamp}}', x: 42, y: 64, width: 16, height: 20.5 },
    ...signatureBlock(2, 65, 65, 24, 'center', 11, NAVY),
    text('number', 'Certificate No. {{certificate_number}}', 8, 88, 45, 3, { fontSize: 8.5, color: MUTED, align: 'left', letterSpacing: 0.5 }),
    text('verify', 'Verify at {{verification_url}}', 8, 91, 70, 2.6, { fontSize: 6.5, color: MUTED, align: 'left' }),
    { id: 'qr', type: 'qr', content: '{{qr_code}}', x: 86.5, y: 83.5, width: 8, height: 10.5, color: NAVY },
  ],
};

/** Letter portrait, white page, copper accent bar, left-aligned modern sans type. */
const modern: DesignInput = {
  schemaVersion: 1,
  page: { size: 'LETTER', orientation: 'portrait' },
  theme: {
    backgroundColor: '#FFFFFF',
    backgroundImageAssetId: null,
    border: { style: 'single', color: '#D1D5DB', width: 0.75, inset: 4 },
    accentColor: COPPER,
    fontFamily: 'sans',
  },
  elements: [
    line('accent-bar', 8, 7, 84, COPPER, 6),
    text('organization', '{{organization_name}}', 8, 10, 60, 3, { fontSize: 10, fontWeight: 'bold', uppercase: true, letterSpacing: 3, color: INK, align: 'left' }),
    text('title', 'Certificate', 8, 16, 84, 7, { fontSize: 44, fontFamily: 'display', uppercase: true, letterSpacing: 2, color: INK, align: 'left' }),
    text('subtitle', 'of Professional Certification', 8, 23, 84, 3.5, { fontSize: 16, color: COPPER, align: 'left' }),
    text('intro', 'Awarded to', 8, 33, 84, 3, { fontSize: 10, uppercase: true, letterSpacing: 2, color: MUTED, align: 'left' }),
    text('recipient', '{{recipient_name}}', 8, 36.5, 84, 7, { fontSize: 34, fontWeight: 'bold', color: INK, align: 'left' }),
    line('recipient-rule', 8, 44, 40, COPPER, 1.5),
    text('body', 'for completing every requirement of the {{program_name}} and demonstrating field readiness as an', 8, 46.5, 70, 6, {
      fontSize: 12,
      color: '#374151',
      align: 'left',
      lineHeight: 1.35,
    }),
    text('certification', '{{certificate_name}}', 8, 53, 84, 5, { fontSize: 18, fontWeight: 'bold', color: COPPER, align: 'left' }),
    text('issued-label', 'Issued', 8, 61, 25, 2.2, { fontSize: 8, uppercase: true, letterSpacing: 1.5, color: MUTED, align: 'left' }),
    text('issued-value', '{{issue_date}}', 8, 63.2, 25, 3, { fontSize: 11, fontWeight: 'bold', color: INK, align: 'left' }),
    text('valid-label', 'Valid through', 35, 61, 25, 2.2, { fontSize: 8, uppercase: true, letterSpacing: 1.5, color: MUTED, align: 'left' }),
    text('valid-value', '{{expiration_date}}', 35, 63.2, 25, 3, { fontSize: 11, fontWeight: 'bold', color: INK, align: 'left' }),
    text('number-label', 'Certificate No.', 8, 67.2, 40, 2.2, { fontSize: 8, uppercase: true, letterSpacing: 1.5, color: MUTED, align: 'left' }),
    text('number-value', '{{certificate_number}}', 8, 69.4, 40, 2.8, { fontSize: 10.5, fontWeight: 'bold', color: INK, align: 'left' }),
    { id: 'stamp', type: 'stamp', content: '{{organization_stamp}}', x: 74, y: 58, width: 18, height: 14 },
    ...signatureBlock(1, 8, 73.5, 30, 'left', 7, INK),
    ...signatureBlock(2, 42, 73.5, 30, 'left', 7, INK),
    { id: 'qr', type: 'qr', content: '{{qr_code}}', x: 79, y: 79, width: 13, height: 10, color: INK, align: 'right' },
    text('verify', 'Scan the code or visit {{verification_url}} to verify this certificate', 8, 90, 68, 2.5, { fontSize: 7, color: MUTED, align: 'left' }),
  ],
};

export const STARTER_DESIGNS: Record<'classic' | 'modern', { name: string; description: string; design: certification.TemplateDesign }> = {
  classic: {
    name: 'Classic Landscape',
    description: 'Letter landscape on ivory paper with a navy double frame, gold accents and serif type.',
    design: certification.templateDesignSchema.parse(classic),
  },
  modern: {
    name: 'Modern Portrait',
    description: 'Letter portrait with a copper accent bar, left-aligned sans-serif type and a detail grid.',
    design: certification.templateDesignSchema.parse(modern),
  },
};
