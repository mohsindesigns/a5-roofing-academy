import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

/**
 * Deterministic seed artwork (signatures and the company seal) rendered from SVG with the resvg
 * WebAssembly rasterizer and bundled OFL fonts. No native dependencies and no network access.
 */
const require = createRequire(import.meta.url);

let wasmReady: Promise<void> | null = null;
const fontCache = new Map<string, Promise<Uint8Array>>();

async function ensureWasm(): Promise<void> {
  wasmReady ??= (async () => {
    const wasm = await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
    try {
      await initWasm(wasm);
    } catch (err) {
      // The module is process-global; another caller may have initialized it already.
      if (!/already initiali[sz]ed/i.test(String(err))) throw err;
    }
  })();
  return wasmReady;
}

const FONT_FILES = {
  'Great Vibes': '@expo-google-fonts/great-vibes/400Regular/GreatVibes_400Regular.ttf',
  'Mrs Saint Delafield':
    '@expo-google-fonts/mrs-saint-delafield/400Regular/MrsSaintDelafield_400Regular.ttf',
  Cinzel: '@expo-google-fonts/cinzel/700Bold/Cinzel_700Bold.ttf',
} as const;
type FontName = keyof typeof FONT_FILES;

function font(name: FontName): Promise<Uint8Array> {
  let pending = fontCache.get(name);
  if (!pending) {
    pending = readFile(require.resolve(FONT_FILES[name])).then((b) => new Uint8Array(b));
    fontCache.set(name, pending);
  }
  return pending;
}

async function rasterize(svg: string, fonts: FontName[]): Promise<Buffer> {
  await ensureWasm();
  const buffers = await Promise.all(fonts.map(font));
  const resvg = new Resvg(svg, {
    font: { fontBuffers: buffers, loadSystemFonts: false, defaultFontFamily: fonts[0] },
    shapeRendering: 2,
    textRendering: 2,
  });
  const rendered = resvg.render();
  const png = Buffer.from(rendered.asPng());
  rendered.free();
  resvg.free();
  return png;
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
}

export type SignatureStyle = 'flowing' | 'brisk';

/** Handwritten-style signature on a transparent background (960 × 300). */
export async function renderSignature(
  name: string,
  style: SignatureStyle,
  ink = '#1B2A55',
): Promise<Buffer> {
  const family: FontName = style === 'flowing' ? 'Great Vibes' : 'Mrs Saint Delafield';
  const size = style === 'flowing' ? 124 : 150;
  const flourish =
    style === 'flowing'
      ? 'M 96 236 C 260 214, 520 226, 700 206 S 880 188, 900 176'
      : 'M 120 230 C 330 246, 600 206, 870 214';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="300" viewBox="0 0 960 300">
  <g transform="rotate(-3 480 150)">
    <text x="480" y="190" text-anchor="middle" font-family="${family}" font-size="${size}" fill="${ink}">${escapeXml(name)}</text>
    <path d="${flourish}" stroke="${ink}" stroke-width="3.2" fill="none" stroke-linecap="round" opacity="0.85"/>
  </g>
</svg>`;
  return rasterize(svg, [family]);
}

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M ${points.join(' L ')} Z`;
}

function serratedEdge(cx: number, cy: number, outer: number, inner: number, teeth: number): string {
  const points: string[] = [];
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i * Math.PI) / teeth;
    points.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M ${points.join(' L ')} Z`;
}

/** Circular company seal with arched text, a roofline mark and the monogram (640 × 640). */
export async function renderSeal(options: {
  topText: string;
  bottomText: string;
  monogram: string;
  caption: string;
  color?: string;
}): Promise<Buffer> {
  const color = options.color ?? '#7F1D1D';
  const c = 320;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">
  <defs>
    <path id="top" d="M ${c - 232},${c} A 232,232 0 0,1 ${c + 232},${c}"/>
    <path id="bottom" d="M ${c - 262},${c} A 262,262 0 0,0 ${c + 262},${c}"/>
  </defs>
  <g opacity="0.94">
    <path fill-rule="evenodd" fill="${color}" d="${serratedEdge(c, c, 312, 298, 90)} M ${c + 292},${c} A 292,292 0 1,0 ${c - 292},${c} A 292,292 0 1,0 ${c + 292},${c} Z"/>
    <circle cx="${c}" cy="${c}" r="282" fill="none" stroke="${color}" stroke-width="7"/>
    <circle cx="${c}" cy="${c}" r="196" fill="none" stroke="${color}" stroke-width="4"/>
    <circle cx="${c}" cy="${c}" r="184" fill="none" stroke="${color}" stroke-width="1.5"/>
    <text font-family="Cinzel" font-weight="700" font-size="44" letter-spacing="7" fill="${color}">
      <textPath href="#top" startOffset="50%" text-anchor="middle">${escapeXml(options.topText)}</textPath>
    </text>
    <text font-family="Cinzel" font-weight="700" font-size="40" letter-spacing="7" fill="${color}">
      <textPath href="#bottom" startOffset="50%" text-anchor="middle">${escapeXml(options.bottomText)}</textPath>
    </text>
    <path d="${starPath(c - 240, c + 6, 15, 6.5)}" fill="${color}"/>
    <path d="${starPath(c + 240, c + 6, 15, 6.5)}" fill="${color}"/>
    <path d="M ${c - 112},${c - 34} L ${c},${c - 112} L ${c + 112},${c - 34}" fill="none" stroke="${color}" stroke-width="14" stroke-linejoin="miter" stroke-linecap="square"/>
    <path d="M ${c - 76},${c - 46} L ${c},${c - 98} L ${c + 76},${c - 46}" fill="none" stroke="${color}" stroke-width="5" stroke-linejoin="miter"/>
    <text x="${c}" y="${c + 62}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="124" fill="${color}">${escapeXml(options.monogram)}</text>
    <text x="${c}" y="${c + 118}" text-anchor="middle" font-family="Cinzel" font-weight="700" font-size="25" letter-spacing="5" fill="${color}">${escapeXml(options.caption)}</text>
  </g>
</svg>`;
  return rasterize(svg, ['Cinzel']);
}
