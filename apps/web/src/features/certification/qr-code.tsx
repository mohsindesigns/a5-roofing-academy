import { useMemo } from 'react';
import QRCode from 'qrcode';

/** Dark modules of a QR code (error correction M, the level the PDF renderer uses). */
export function qrMatrix(value: string): boolean[][] {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => Boolean(qr.modules.get(row, col))),
  );
}

export const QR_QUIET_ZONE = 2;

/** SVG path data with horizontal runs of dark modules merged, in module units. */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((cells, row) => {
    let col = 0;
    while (col < cells.length) {
      if (!cells[col]) {
        col++;
        continue;
      }
      const start = col;
      while (col < cells.length && cells[col]) col++;
      parts.push(
        `M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${col - start}v1h${start - col}z`,
      );
    }
  });
  return parts.join('');
}

/**
 * QR code drawn as inline SVG. Dark modules on a light background with a quiet zone, whatever the
 * theme, so scanners can read it. `foreground` lets the template preview use the design's colour.
 */
export function QrCode({
  value,
  size = 168,
  label,
  foreground = '#000000',
  className,
}: {
  value: string;
  /** Pixels, or `fill` to take the height of the parent and keep the square shape. */
  size?: number | 'fill';
  label: string;
  foreground?: string;
  className?: string;
}) {
  const { path, dimension } = useMemo(() => {
    const matrix = qrMatrix(value);
    return { path: qrPath(matrix), dimension: matrix.length + QR_QUIET_ZONE * 2 };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${dimension} ${dimension}`}
      width={size === 'fill' ? undefined : size}
      height={size === 'fill' ? undefined : size}
      shapeRendering="crispEdges"
      className={size === 'fill' ? `h-full w-auto ${className ?? ''}` : className}
    >
      <rect width={dimension} height={dimension} fill="#ffffff" />
      <path d={path} fill={foreground} />
    </svg>
  );
}
