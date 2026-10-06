import { describe, expect, it } from 'vitest';
import { certification as c } from '@a5/contracts';
import {
  addElement,
  designIssues,
  duplicateElement,
  insertPlaceholder,
  moveElement,
  newElement,
  nudgeElement,
  removeElement,
  reorderElement,
  resizeElement,
  updateElement,
} from './design-model';
import type { TemplateDesign } from './types';

function base(): TemplateDesign {
  return c.templateDesignSchema.parse({
    page: { size: 'LETTER', orientation: 'landscape' },
    theme: {
      backgroundColor: '#FFFFFF',
      border: { style: 'single', color: '#111111', width: 1, inset: 3 },
      accentColor: '#B4531F',
      fontFamily: 'sans',
    },
    elements: [
      { id: 'title', type: 'text', content: 'Certificate', x: 10, y: 10, width: 80, height: 10 },
      { id: 'rule', type: 'line', x: 20, y: 50, width: 60, height: 0.8 },
    ],
  });
}

describe('new elements', () => {
  it.each(['text', 'qr', 'signature-1', 'signature-2', 'stamp', 'line'] as const)(
    'a new %s element passes the shared design schema',
    (kind) => {
      const design = addElement(base(), newElement(kind, base().elements));
      const issues = designIssues(design);
      expect(issues.count).toBe(0);
    },
  );

  it('image and logo elements wait for an upload before the design is valid', () => {
    const design = addElement(base(), newElement('logo', base().elements));
    const issues = designIssues(design);
    expect(issues.count).toBe(1);
    expect([...issues.byElement.values()][0]).toEqual([
      'Upload or choose an image for this element.',
    ]);
  });

  it('gives every element its own id', () => {
    let design = base();
    for (let i = 0; i < 3; i++) design = addElement(design, newElement('text', design.elements));
    const ids = design.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['text-1', 'text-2', 'text-3']));
  });

  it('binds signature and image elements to their placeholders', () => {
    expect(newElement('signature-2', []).content).toBe('{{signatory_2_signature}}');
    expect(newElement('stamp', []).content).toBe('{{organization_stamp}}');
    expect(newElement('qr', []).content).toBe('{{qr_code}}');
  });
});

describe('moving and resizing', () => {
  it('keeps elements inside the printable area', () => {
    const moved = moveElement(base(), 'title', -20, 500);
    const title = moved.elements[0]!;
    expect(title.x).toBe(c.DESIGN_SAFE_AREA.min);
    expect(title.y).toBe(c.DESIGN_SAFE_AREA.max - title.height);
    expect(designIssues(moved).count).toBe(0);

    const right = moveElement(base(), 'title', 99, 10).elements[0]!;
    expect(right.x + right.width).toBeLessThanOrEqual(c.DESIGN_SAFE_AREA.max);
  });

  it('snaps to a tenth of a percent', () => {
    const moved = moveElement(base(), 'title', 12.3456, 20.0449).elements[0]!;
    expect([moved.x, moved.y]).toEqual([12.3, 20]);
  });

  it('never shrinks below the minimum size or grows past the edge', () => {
    const small = resizeElement(base(), 'title', 0, 0).elements[0]!;
    expect([small.width, small.height]).toEqual([0.5, 0.2]);
    const large = resizeElement(base(), 'title', 500, 500).elements[0]!;
    expect(large.x + large.width).toBeCloseTo(c.DESIGN_SAFE_AREA.max, 5);
    expect(large.y + large.height).toBeCloseTo(c.DESIGN_SAFE_AREA.max, 5);
  });

  it('nudges by the step for moves and sizes', () => {
    const moved = nudgeElement(base(), 'title', 0.5, -2, 'move').elements[0]!;
    expect([moved.x, moved.y]).toEqual([10.5, 8]);
    const sized = nudgeElement(base(), 'title', -2, 1, 'resize').elements[0]!;
    expect([sized.width, sized.height]).toEqual([78, 11]);
    expect(nudgeElement(base(), 'missing', 1, 1, 'move')).toEqual(base());
  });
});

describe('list operations', () => {
  it('updates, removes, duplicates and reorders without touching the original', () => {
    const design = base();
    expect(updateElement(design, 'title', { content: 'Hello' }).elements[0]!.content).toBe('Hello');
    expect(design.elements[0]!.content).toBe('Certificate');
    expect(removeElement(design, 'title').elements.map((e) => e.id)).toEqual(['rule']);

    const dup = duplicateElement(design, 'title');
    expect(dup.design.elements.map((e) => e.id)).toEqual(['title', 'text-1', 'rule']);
    expect(dup.id).toBe('text-1');
    expect(duplicateElement(design, 'nope').id).toBeNull();

    expect(reorderElement(design, 'title', 1).elements.map((e) => e.id)).toEqual(['rule', 'title']);
    expect(reorderElement(design, 'title', -1)).toBe(design);
  });
});

describe('designIssues', () => {
  it('groups problems by the element they belong to', () => {
    const design = updateElement(base(), 'title', { content: '{{qr_code}}', x: 99 });
    const issues = designIssues(design);
    expect(issues.byElement.get('title')?.length).toBeGreaterThanOrEqual(2);
    expect(issues.general).toEqual([]);
    expect(issues.count).toBe(issues.byElement.get('title')!.length);
  });

  it('reports duplicate ids', () => {
    const design = base();
    design.elements[1] = { ...design.elements[1]!, id: 'title' };
    expect(designIssues(design).count).toBeGreaterThan(0);
  });
});

describe('insertPlaceholder', () => {
  it('inserts at the cursor and replaces a selection', () => {
    expect(insertPlaceholder('Hello !', 'recipient_name', 6, 6)).toBe('Hello {{recipient_name}}!');
    expect(insertPlaceholder('Hello NAME', 'recipient_name', 6, 10)).toBe(
      'Hello {{recipient_name}}',
    );
    expect(insertPlaceholder('Hi ', 'issue_date', null, null)).toBe('Hi {{issue_date}}');
  });
});
