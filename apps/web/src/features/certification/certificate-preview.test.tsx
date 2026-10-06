import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { certification as c } from '@a5/contracts';
import { CertificatePreview } from './certificate-preview';
import { FALLBACK_SOURCES, buildPreviewModel } from './template-preview';
import './test-utils';

function model(
  border: c.TemplateDesignInput['theme']['border'] = {
    style: 'double',
    color: '#1F2A44',
    width: 2.5,
    inset: 3.5,
  },
) {
  const design = c.templateDesignSchema.parse({
    page: { size: 'LETTER', orientation: 'landscape' },
    theme: { backgroundColor: '#FFFDF7', border, accentColor: '#B08D3C', fontFamily: 'serif' },
    elements: [
      {
        id: 'name',
        type: 'text',
        content: '{{recipient_name}}',
        x: 10,
        y: 30,
        width: 80,
        height: 10,
        fontSize: 32,
      },
      { id: 'qr', type: 'qr', content: '{{qr_code}}', x: 86, y: 82, width: 8, height: 10 },
      {
        id: 'sig',
        type: 'signature',
        content: '{{signatory_1_signature}}',
        x: 10,
        y: 60,
        width: 25,
        height: 10,
      },
      { id: 'rule', type: 'line', x: 20, y: 50, width: 60, height: 0.8 },
    ],
  });
  return buildPreviewModel(design, {
    ...FALLBACK_SOURCES,
    signatureUrls: { 1: null, 2: null },
  });
}

describe('CertificatePreview', () => {
  it('draws the page in the design proportions with elements placed in percent', () => {
    const { container } = render(<CertificatePreview model={model()} />);
    const page = screen.getByRole('group', { name: 'Certificate preview' });
    expect(page.style.aspectRatio.replace(/\s/g, '')).toBe('792/612');
    const name = container.querySelector('[data-element-id="name"]') as HTMLElement;
    expect(name.style.left).toBe('10%');
    expect(name.style.top).toBe('30%');
    expect(name.style.width).toBe('80%');
    expect(name.style.height).toBe('10%');
    expect(name).toHaveTextContent('Jordan Ellis');
    expect(container.querySelector('[data-font-pt="32"]')).not.toBeNull();
  });

  it('renders a scannable QR code and says when a signature image is missing', () => {
    render(<CertificatePreview model={model()} />);
    expect(screen.getByRole('img', { name: /Verification QR code/ })).toBeInTheDocument();
    expect(screen.getByText('Signature 1')).toBeInTheDocument();
  });

  it('draws the border style chosen in the design', () => {
    const none = render(
      <CertificatePreview model={model({ style: 'none', color: '#000000', width: 1, inset: 3 })} />,
    );
    expect(none.container.querySelectorAll('svg[aria-hidden] rect')).toHaveLength(0);
    none.unmount();
    const single = render(
      <CertificatePreview
        model={model({ style: 'single', color: '#000000', width: 1, inset: 3 })}
      />,
    );
    expect(single.container.querySelectorAll('svg[aria-hidden] rect')).toHaveLength(1);
    single.unmount();
    const double = render(
      <CertificatePreview
        model={model({ style: 'double', color: '#000000', width: 1, inset: 3 })}
      />,
    );
    expect(double.container.querySelectorAll('svg[aria-hidden] rect')).toHaveLength(2);
    double.unmount();
    const ornamental = render(
      <CertificatePreview
        model={model({ style: 'ornamental', color: '#000000', width: 1, inset: 3 })}
      />,
    );
    // Outer frame, inner frame and the dotted rule, plus a diamond at each corner and edge middle.
    expect(ornamental.container.querySelectorAll('svg[aria-hidden] rect')).toHaveLength(3);
    expect(ornamental.container.querySelectorAll('svg[aria-hidden] polygon')).toHaveLength(8);
  });

  it('is a plain picture unless it is interactive', () => {
    render(<CertificatePreview model={model()} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lets people select elements and nudge them with the keyboard', () => {
    const onSelect = vi.fn();
    const onNudge = vi.fn();
    render(
      <CertificatePreview
        model={model()}
        interactive
        selectedId="name"
        onSelect={onSelect}
        onNudge={onNudge}
      />,
    );
    const name = screen.getByRole('button', { name: 'Text: Jordan Ellis' });
    expect(name).toHaveAttribute('aria-pressed', 'true');
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Signature 1' }), { button: 0 });
    expect(onSelect).toHaveBeenCalledWith('sig');

    fireEvent.keyDown(name, { key: 'ArrowRight' });
    fireEvent.keyDown(name, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(name, { key: 'ArrowLeft', altKey: true });
    expect(onNudge.mock.calls).toEqual([
      ['name', 0.5, 0, 'move'],
      ['name', 0, 2, 'move'],
      ['name', -0.5, 0, 'resize'],
    ]);
  });

  it('shows the printable area on request', () => {
    const { container, rerender } = render(<CertificatePreview model={model()} />);
    expect(container.querySelector('.border-dashed[aria-hidden]')).toBeNull();
    rerender(<CertificatePreview model={model()} showSafeArea />);
    expect(container.querySelector('.border-dashed[aria-hidden]')).not.toBeNull();
  });
});
