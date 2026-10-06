import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { certification as c } from '@a5/contracts';
import { decisionBlocker } from './approval-rules';
import { imageProblem, limitsText } from './image-upload';
import { QrCode, qrMatrix, qrPath } from './qr-code';
import { RequirementChecklist, describeProgress, progressValue } from './requirement-checklist';
import type { RequirementItem } from './types';
import './test-utils';

describe('imageProblem', () => {
  const rule = c.IMAGE_UPLOAD_RULES.signature;
  const ok = { type: 'image/png', size: 100_000 };

  it('accepts an image that fits the limits', () => {
    expect(imageProblem(ok, { width: 600, height: 200 }, rule)).toBeNull();
  });

  it('explains what to change for each kind of problem', () => {
    expect(
      imageProblem({ type: 'image/svg+xml', size: 1000 }, { width: 600, height: 200 }, rule),
    ).toMatch(/PNG or JPEG/);
    expect(
      imageProblem({ ...ok, size: 5 * 1024 * 1024 }, { width: 600, height: 200 }, rule),
    ).toMatch(/Use one under 2 MB/);
    expect(imageProblem(ok, null, rule)).toMatch(/could not be read/);
    expect(imageProblem(ok, { width: 100, height: 40 }, rule)).toMatch(/at least 200 × 60 px/);
    expect(imageProblem(ok, { width: 5000, height: 400 }, rule)).toMatch(/at most 4000 × 2000 px/);
    expect(imageProblem(ok, { width: 400, height: 400 }, rule)).toMatch(/proportions/);
  });

  it('states the limits people have to meet', () => {
    expect(limitsText('stamp')).toBe('PNG or JPEG, up to 2 MB, at least 150 × 150 px.');
  });
});

describe('QR code', () => {
  it('encodes a value into a square module grid with merged horizontal runs', () => {
    const matrix = qrMatrix('https://a5.example/verify/abc');
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    // The three finder patterns always have a dark module in their corners.
    expect(matrix[0]![0]).toBe(true);
    expect(matrix[0]![matrix.length - 1]).toBe(true);
    expect(matrix[matrix.length - 1]![0]).toBe(true);
    expect(qrPath(matrix)).toMatch(/^M2 2h7v1h-7z/);
  });

  it('renders accessibly with a quiet zone', () => {
    const { container } = render(
      <QrCode value="https://a5.example/verify/abc" label="QR code for certificate A5-1" />,
    );
    const svg = screen.getByRole('img', { name: 'QR code for certificate A5-1' });
    const size = qrMatrix('https://a5.example/verify/abc').length + 4;
    expect(svg).toHaveAttribute('viewBox', `0 0 ${size} ${size}`);
    expect(container.querySelector('rect')).toHaveAttribute('fill', '#ffffff');
  });
});

describe('requirement progress', () => {
  const item = (over: Partial<RequirementItem>): RequirementItem => ({
    key: '0',
    type: 'assessment_score',
    description: 'Score 85% or higher on the final',
    satisfied: false,
    unknown: false,
    progress: { current: 70, target: 85, unit: 'percent' },
    ...over,
  });

  it('describes each unit in words', () => {
    expect(describeProgress({ current: 72.04, target: 80, unit: 'percent' })).toBe(
      '72% of 80% needed',
    );
    expect(describeProgress({ current: 3, target: 5, unit: 'count' })).toBe('3 of 5');
    expect(describeProgress({ current: 12, target: 30, unit: 'days' })).toBe('12 of 30 days');
    expect(describeProgress({ current: 0, target: 1, unit: 'boolean' })).toBeNull();
    expect(describeProgress(null)).toBeNull();
  });

  it('measures progress against the target, never above 100', () => {
    expect(progressValue(item({}))).toBeCloseTo(82.35, 1);
    expect(progressValue(item({ satisfied: true }))).toBe(100);
    expect(progressValue(item({ progress: { current: 9, target: 5, unit: 'count' } }))).toBe(100);
    expect(progressValue(item({ progress: null }))).toBe(0);
  });

  it('lists every requirement with its state, driven only by the data it is given', () => {
    render(
      <RequirementChecklist
        metCount={1}
        totalCount={3}
        requirements={[
          item({
            key: '0',
            description: 'Complete the program',
            satisfied: true,
            progress: { current: 100, target: 100, unit: 'percent' },
          }),
          item({ key: '1', description: 'Score 85% or higher on the final' }),
          item({ key: '2', description: 'Hold the prerequisite', unknown: true, progress: null }),
        ]}
      />,
    );
    expect(screen.getByText('1 of 3 complete')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: '1 of 3 requirements complete' }),
    ).toHaveAttribute('aria-valuenow', '33');
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText(/Met\./)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Not met yet\./)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('70% of 85% needed')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('. Status not available yet.')).toBeInTheDocument();
  });

  it('says so when a certification tracks nothing', () => {
    render(<RequirementChecklist metCount={0} totalCount={0} requirements={[]} />);
    expect(screen.getByText(/No individual requirements/)).toBeInTheDocument();
  });
});

describe('decisionBlocker', () => {
  const approval = (over: {
    id?: string;
    kind?: 'manager' | 'trainer' | 'manual_review';
    status?: 'pending' | 'approved';
  }) => ({
    status: over.status ?? ('pending' as const),
    kind: over.kind ?? ('manager' as const),
    user: {
      id: over.id ?? 'someone-else',
      displayName: 'Brianna Castillo',
      employeeId: null,
      jobTitle: null,
    },
  });

  it('never lets anyone decide their own certification', () => {
    expect(decisionBlocker(approval({ id: 'me' }), { userId: 'me', scope: 'organization' })).toBe(
      'You cannot decide your own certification. Ask another approver.',
    );
  });

  it('leaves manual review to people with organization-wide approval access', () => {
    expect(
      decisionBlocker(approval({ kind: 'manual_review' }), { userId: 'me', scope: 'managed' }),
    ).toMatch(/organization-wide/);
    expect(
      decisionBlocker(approval({ kind: 'manual_review' }), { userId: 'me', scope: 'organization' }),
    ).toBeNull();
    expect(
      decisionBlocker(approval({ kind: 'manual_review' }), { userId: 'me', scope: 'platform' }),
    ).toBeNull();
  });

  it('lets the API decide what the client cannot know (for example who the trainer is)', () => {
    expect(
      decisionBlocker(approval({ kind: 'trainer' }), { userId: 'me', scope: 'managed' }),
    ).toBeNull();
  });

  it('has nothing to say about requests that are already decided', () => {
    expect(
      decisionBlocker(approval({ id: 'me', status: 'approved' }), {
        userId: 'me',
        scope: 'managed',
      }),
    ).toBeNull();
  });
});
