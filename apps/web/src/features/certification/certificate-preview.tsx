import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/cn';
import { QrCode } from './qr-code';
import type { PreviewBorder, PreviewElement, PreviewModel } from './template-preview';

/** Percent of the page → CSS container-query width units, so sizes in points scale with the canvas. */
const cqw = (pt: number, widthPt: number) => `${(pt / widthPt) * 100}cqw`;

function BorderLayer({ model }: { model: PreviewModel }) {
  const { widthPt: W, heightPt: H, border, accentColor } = model;
  if (border.style === 'none') return null;
  const w = border.width;
  const inset = (border.inset / 100) * Math.min(W, H);
  const outer = { x: inset + w / 2, y: inset + w / 2, w: W - 2 * inset - w, h: H - 2 * inset - w };
  const double = border.style === 'double' || border.style === 'ornamental';
  const gap = Math.max(3, w * 2.5);
  const inner = { x: outer.x + gap, y: outer.y + gap, w: outer.w - 2 * gap, h: outer.h - 2 * gap };
  const innerWidth = Math.max(0.5, w / 2);
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 size-full"
    >
      <rect
        x={outer.x}
        y={outer.y}
        width={outer.w}
        height={outer.h}
        fill="none"
        stroke={border.color}
        strokeWidth={w}
        strokeLinejoin="miter"
      />
      {double && (
        <rect
          x={inner.x}
          y={inner.y}
          width={inner.w}
          height={inner.h}
          fill="none"
          stroke={border.color}
          strokeWidth={innerWidth}
        />
      )}
      {border.style === 'ornamental' && (
        <Ornaments inner={inner} border={border} accent={accentColor} gap={gap} />
      )}
    </svg>
  );
}

function Ornaments({
  inner,
  border,
  accent,
  gap,
}: {
  inner: { x: number; y: number; w: number; h: number };
  border: PreviewBorder;
  accent: string;
  gap: number;
}) {
  const size = Math.max(5, border.width * 3);
  const corners: Array<[number, number]> = [
    [inner.x, inner.y],
    [inner.x + inner.w, inner.y],
    [inner.x, inner.y + inner.h],
    [inner.x + inner.w, inner.y + inner.h],
  ];
  const mids: Array<[number, number]> = [
    [inner.x + inner.w / 2, inner.y],
    [inner.x + inner.w / 2, inner.y + inner.h],
    [inner.x, inner.y + inner.h / 2],
    [inner.x + inner.w, inner.y + inner.h / 2],
  ];
  const dot = gap + Math.max(2, border.width);
  const diamond = ([cx, cy]: [number, number], s: number, key: string) => (
    <polygon
      key={key}
      points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
      fill={accent}
      stroke={border.color}
      strokeWidth={0.5}
    />
  );
  return (
    <>
      <rect
        x={inner.x + dot}
        y={inner.y + dot}
        width={inner.w - 2 * dot}
        height={inner.h - 2 * dot}
        fill="none"
        stroke={border.color}
        strokeWidth={Math.max(0.35, border.width / 3)}
        strokeDasharray="0.6 2.4"
      />
      {corners.map((p, i) => diamond(p, size, `c${i}`))}
      {mids.map((p, i) => diamond(p, size * 0.6, `m${i}`))}
    </>
  );
}

const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' } as const;

function ElementContent({ el, model }: { el: PreviewElement; model: PreviewModel }) {
  const W = model.widthPt;
  switch (el.type) {
    case 'text':
      return (
        <div className="flex h-full w-full items-center overflow-hidden">
          <div
            data-font-pt={el.fontSize}
            style={{
              width: '100%',
              textAlign: el.align,
              fontFamily: el.cssFontFamily,
              fontWeight: el.fontWeight,
              fontStyle: el.fontStyle,
              color: el.color,
              fontSize: cqw(el.fontSize, W),
              letterSpacing: cqw(el.letterSpacing, W),
              lineHeight: el.lineHeight,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {el.text}
          </div>
        </div>
      );
    case 'line':
      return (
        <div
          className="absolute inset-x-0 top-1/2 -translate-y-1/2"
          style={{ height: cqw(el.strokeWidth, W), background: el.color }}
        />
      );
    case 'qr':
      return (
        <div
          className="flex h-full w-full items-center"
          style={{ justifyContent: JUSTIFY[el.align] }}
        >
          {el.qrValue ? (
            <QrCode
              value={el.qrValue}
              size="fill"
              foreground={el.color}
              label="Verification QR code (sample)"
            />
          ) : null}
        </div>
      );
    default:
      return (
        <div
          className="flex h-full w-full items-center"
          style={{ justifyContent: JUSTIFY[el.align] }}
        >
          {el.imageUrl ? (
            <img
              src={el.imageUrl}
              alt=""
              className="max-h-full max-w-full object-contain"
              draggable={false}
            />
          ) : (
            <span
              className="flex h-full w-full items-center justify-center border border-dashed border-black/30 text-center text-black/50"
              style={{ fontSize: cqw(8, W), lineHeight: 1.2 }}
            >
              {el.label}
            </span>
          )}
        </div>
      );
  }
}

export type NudgeMode = 'move' | 'resize';

/**
 * The certificate drawn in the browser from its design. With `interactive`, each element can be
 * selected, dragged and nudged with the arrow keys (Shift moves faster, Alt resizes).
 */
export function CertificatePreview({
  model,
  interactive = false,
  selectedId = null,
  onSelect,
  onMove,
  onNudge,
  showSafeArea = false,
  label = 'Certificate preview',
  className,
}: {
  model: PreviewModel;
  interactive?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, x: number, y: number) => void;
  onNudge?: (id: string, dx: number, dy: number, mode: NudgeMode) => void;
  showSafeArea?: boolean;
  label?: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: string;
    startX: number;
    startY: number;
    ox: number;
    oy: number;
    width: number;
    height: number;
    moved: boolean;
  } | null>(null);

  const down = (e: PointerEvent<HTMLButtonElement>, el: PreviewElement) => {
    onSelect?.(el.id);
    if (e.button !== 0 || !root.current || !onMove) return;
    const rect = root.current.getBoundingClientRect();
    drag.current = {
      id: el.id,
      startX: e.clientX,
      startY: e.clientY,
      ox: el.x,
      oy: el.y,
      width: rect.width,
      height: rect.height,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.width === 0 || d.height === 0) return;
    const dx = ((e.clientX - d.startX) / d.width) * 100;
    const dy = ((e.clientY - d.startY) / d.height) * 100;
    if (!d.moved && Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) return;
    d.moved = true;
    onMove?.(d.id, d.ox + dx, d.oy + dy);
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>, el: PreviewElement) => {
    const step = e.shiftKey ? 2 : 0.5;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d || !onNudge) return;
    e.preventDefault();
    onNudge(el.id, d[0], d[1], e.altKey ? 'resize' : 'move');
  };

  const style: CSSProperties = {
    aspectRatio: `${model.widthPt} / ${model.heightPt}`,
    containerType: 'inline-size',
    background: model.backgroundColor,
  };

  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      style={style}
      className={cn(
        'relative w-full overflow-hidden border border-border shadow-popover select-none',
        className,
      )}
      onPointerDown={(e) => {
        if (interactive && e.target === e.currentTarget) onSelect?.(null);
      }}
    >
      {model.backgroundImageUrl && (
        <img
          src={model.backgroundImageUrl}
          alt=""
          className="pointer-events-none absolute inset-0 size-full object-cover"
          draggable={false}
        />
      )}
      <BorderLayer model={model} />
      {model.elements.map((el) => {
        const selected = selectedId === el.id;
        return (
          <div
            key={el.id}
            data-element-id={el.id}
            data-element-type={el.type}
            className="absolute"
            style={{
              left: `${el.x}%`,
              top: `${el.y}%`,
              width: `${el.width}%`,
              height: `${el.height}%`,
            }}
          >
            <ElementContent el={el} model={model} />
            {interactive && (
              <button
                type="button"
                aria-label={el.label}
                aria-pressed={selected}
                data-selected={selected || undefined}
                className={cn(
                  'absolute -inset-px cursor-move touch-none rounded-[1px] outline-offset-0',
                  selected
                    ? 'outline-2 outline-[var(--a5-focus)]'
                    : 'outline-1 outline-transparent hover:outline-[var(--a5-focus)]/50',
                )}
                onPointerDown={(e) => down(e, el)}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onKeyDown={(e) => key(e, el)}
              />
            )}
          </div>
        );
      })}
      {showSafeArea && (
        <div
          aria-hidden
          className="pointer-events-none absolute border border-dashed border-[var(--a5-focus)]/60"
          style={{ left: '2%', top: '2%', right: '2%', bottom: '2%' }}
        />
      )}
    </div>
  );
}
