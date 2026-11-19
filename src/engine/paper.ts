// Paper: a tileable fibre field that both renders the sheet and decides where a
// drying brush still leaves ink (飞白 flying white) and how far wet ink spreads.

import { mulberry32 } from './rng';

export type PaperKind = 'raw' | 'half' | 'sized' | 'maobian';

export interface PaperProfile {
  /** How much water the sheet pulls sideways from a stroke (bleed). */
  absorb: number;
  /** How strongly the fibre texture breaks up a dry stroke. */
  rough: number;
  color: string;
  fibre: string;
  fibreCount: number;
  mottle: number;
}

export const PAPERS: Record<PaperKind, PaperProfile> = {
  // 生宣: unsized xuan; absorbent, ink feathers along the fibres.
  raw: { absorb: 1, rough: 0.55, color: '#f7f5ef', fibre: '#d9d3c3', fibreCount: 2600, mottle: 0.05 },
  // 半熟宣: lightly sized.
  half: { absorb: 0.5, rough: 0.5, color: '#f6f4ee', fibre: '#ddd8ca', fibreCount: 1800, mottle: 0.04 },
  // 熟宣: sized with alum; ink sits on top with crisp edges.
  sized: { absorb: 0.1, rough: 0.35, color: '#f9f8f4', fibre: '#e4e0d6', fibreCount: 700, mottle: 0.025 },
  // 毛边纸: cheap bamboo practice paper; yellow, rough, fairly absorbent.
  maobian: { absorb: 0.7, rough: 0.8, color: '#ecdcb5', fibre: '#cdb680', fibreCount: 3400, mottle: 0.09 },
};

export const TILE = 1024;

export interface PaperField {
  kind: PaperKind;
  /** Values 0..1 where high = raised fibre that resists a dry brush. */
  data: Float32Array;
  /** Visual tile used as a repeating pattern on the sheet. */
  tile: HTMLCanvasElement;
  /** Alpha mask that breaks bleed halos into fibrous edges. */
  bleedMask: HTMLCanvasElement;
}

const cache = new Map<PaperKind, PaperField>();

export function getPaper(kind: PaperKind): PaperField {
  let field = cache.get(kind);
  if (!field) {
    field = buildPaper(kind);
    cache.set(kind, field);
  }
  return field;
}

export function sampleField(field: PaperField, x: number, y: number): number {
  const ix = (Math.floor(x) & (TILE - 1)) >>> 0;
  const iy = (Math.floor(y) & (TILE - 1)) >>> 0;
  return field.data[iy * TILE + ix];
}

function periodicValueNoise(rand: () => number, period: number): (x: number, y: number) => number {
  const lattice = new Float32Array(period * period);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const scale = period / TILE;
  return (x, y) => {
    const fx = x * scale;
    const fy = y * scale;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const xa = ((x0 % period) + period) % period;
    const ya = ((y0 % period) + period) % period;
    const xb = (xa + 1) % period;
    const yb = (ya + 1) % period;
    const a = lattice[ya * period + xa];
    const b = lattice[ya * period + xb];
    const c = lattice[yb * period + xa];
    const d = lattice[yb * period + xb];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function drawFibres(ctx: CanvasRenderingContext2D, rand: () => number, count: number, color: string) {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const x = rand() * TILE;
    const y = rand() * TILE;
    const len = 12 + rand() ** 2 * 140;
    const ang = rand() * Math.PI * 2;
    const bend = (rand() - 0.5) * len * 0.6;
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;
    const cx = (x + ex) / 2 - Math.sin(ang) * bend;
    const cy = (y + ey) / 2 + Math.cos(ang) * bend;
    ctx.globalAlpha = 0.12 + rand() * 0.4;
    ctx.lineWidth = 0.5 + rand() * 1.4;
    // Draw at wrapped offsets so the tile repeats seamlessly.
    for (const ox of [-TILE, 0, TILE]) {
      for (const oy of [-TILE, 0, TILE]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.quadraticCurveTo(cx + ox, cy + oy, ex + ox, ey + oy);
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;
}

function buildPaper(kind: PaperKind): PaperField {
  const p = PAPERS[kind];
  const rand = mulberry32(kind.length * 7919 + 17);

  // Fibre layer, used for both the look and the field.
  const fibreCanvas = document.createElement('canvas');
  fibreCanvas.width = fibreCanvas.height = TILE;
  const fctx = fibreCanvas.getContext('2d', { willReadFrequently: true })!;
  drawFibres(fctx, rand, p.fibreCount, '#000');
  const fibreAlpha = fctx.getImageData(0, 0, TILE, TILE).data;

  const n1 = periodicValueNoise(rand, 8);
  const n2 = periodicValueNoise(rand, 32);
  const n3 = periodicValueNoise(rand, 128);
  const n4 = periodicValueNoise(rand, 512);

  const data = new Float32Array(TILE * TILE);
  const tile = document.createElement('canvas');
  tile.width = tile.height = TILE;
  const tctx = tile.getContext('2d')!;
  const img = tctx.createImageData(TILE, TILE);
  const base = hexToRgb(p.color);
  const fib = hexToRgb(p.fibre);

  const mask = document.createElement('canvas');
  mask.width = mask.height = TILE;
  const mctx = mask.getContext('2d')!;
  const mimg = mctx.createImageData(TILE, TILE);

  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const i = y * TILE + x;
      const cloud = n1(x, y) * 0.45 + n2(x, y) * 0.3 + n3(x, y) * 0.15 + n4(x, y) * 0.1;
      const grain = n4(x, y);
      const fibre = fibreAlpha[i * 4 + 3] / 255;
      const v = Math.min(1, cloud * 0.55 + grain * 0.3 + fibre * 0.6);
      data[i] = v;

      // Visual: base colour, cloudy mottling (the "clouds" visible in xuan when held to light), fibres.
      const shade = 1 - (cloud - 0.5) * p.mottle * 2 - (grain - 0.5) * p.mottle * 0.6;
      const f = fibre * 0.55;
      const o = i * 4;
      img.data[o] = clamp255(base[0] * shade * (1 - f) + fib[0] * f);
      img.data[o + 1] = clamp255(base[1] * shade * (1 - f) + fib[1] * f);
      img.data[o + 2] = clamp255(base[2] * shade * (1 - f) + fib[2] * f);
      img.data[o + 3] = 255;

      // Bleed mask: ink travels along fibres and through thin cloud.
      const m = 0.35 + fibre * 0.65 + (0.5 - cloud) * 0.5;
      mimg.data[o] = mimg.data[o + 1] = mimg.data[o + 2] = 0;
      mimg.data[o + 3] = clamp255(m * 255);
    }
  }
  tctx.putImageData(img, 0, 0);
  mctx.putImageData(mimg, 0, 0);

  return { kind, data, tile, bleedMask: mask };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function clamp255(v: number) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function paintPaper(ctx: CanvasRenderingContext2D, kind: PaperKind, size: number) {
  const field = getPaper(kind);
  const pattern = ctx.createPattern(field.tile, 'repeat')!;
  ctx.save();
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
}
