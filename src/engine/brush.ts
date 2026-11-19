// Hairy-brush ink model.
//
// The brush is a bundle of bristles, each carrying its own ink. Bristles lay
// tracks as the brush moves; when a bristle runs low, the paper's fibre field
// decides where it still touches, which opens the white streaks of 飞白.
// Speed lifts the brush (thinner, drier), slowness presses it (wider, wetter),
// and pausing lets ink pool (涨墨). On absorbent paper the finished stroke
// bleeds outward along the fibres.

import { PAPERS, TILE, type PaperKind, getPaper, sampleField, type PaperField } from './paper';
import { mulberry32 } from './rng';

export type BrushKind = 'wolf' | 'mixed' | 'goat';
export type ToneKind = 'jiao' | 'nong' | 'zhong' | 'dan' | 'qing';
export type InkColor = 'mo' | 'zhu';

export interface BrushProfile {
  /** Footprint at lightest and heaviest press, as a multiple of the base radius. */
  minF: number;
  maxF: number;
  /** How closely the tip follows the hand (stiff hair tracks tightly). */
  follow: number;
  /** Pressure response time in ms (soft hair is slow to spring back). */
  tau: number;
  /** Relative ink the belly of the brush holds. */
  capacity: number;
  bristles: number;
  bleed: number;
  /** Length of the pointed tip (锋) relative to the belly. */
  tip: number;
  /** How slowly the tip swings round to trail the stroke, in ms. */
  tipLag: number;
}

export const BRUSHES: Record<BrushKind, BrushProfile> = {
  // 狼毫: weasel hair. Stiff and springy, sharp tips, holds less ink.
  wolf: { minF: 0.32, maxF: 1.0, follow: 0.62, tau: 35, capacity: 0.75, bristles: 52, bleed: 0.75, tip: 1.25, tipLag: 70 },
  // 兼毫: stiff core wrapped in goat hair.
  mixed: { minF: 0.24, maxF: 1.12, follow: 0.48, tau: 55, capacity: 1, bristles: 60, bleed: 1, tip: 1, tipLag: 100 },
  // 羊毫: goat hair. Soft, absorbent, wide swing between light and heavy press.
  goat: { minF: 0.14, maxF: 1.32, follow: 0.34, tau: 85, capacity: 1.45, bristles: 72, bleed: 1.3, tip: 0.8, tipLag: 150 },
};

export interface ToneProfile {
  density: number;
  water: number;
}

/** 墨分五色: the five tones of ink, set by how much water is ground in. */
export const TONES: Record<ToneKind, ToneProfile> = {
  jiao: { density: 0.99, water: 0.08 }, // 焦 scorched: thick, dry, breaks into flying white
  nong: { density: 0.95, water: 0.3 }, // 浓 dense
  zhong: { density: 0.8, water: 0.5 }, // 重 heavy
  dan: { density: 0.5, water: 0.75 }, // 淡 light
  qing: { density: 0.27, water: 0.95 }, // 清 clear, almost water
};

export const INK_COLORS: Record<InkColor, string> = {
  mo: '#141311', // 墨 pine-soot black
  zhu: '#b8321f', // 朱 cinnabar, used for corrections and marking
};

export interface StrokeSettings {
  brush: BrushKind;
  tone: ToneKind;
  ink: InkColor;
  paper: PaperKind;
  /** Base brush radius in sheet pixels. */
  radius: number;
}

export interface InputPoint {
  x: number;
  y: number;
  t: number;
  /** Pen pressure 0..1, or -1 when the device has none. */
  p: number;
}

export interface StrokeRecord {
  seed: number;
  settings: StrokeSettings;
  loadStart: number;
  points: InputPoint[];
}

interface Bristle {
  ox: number;
  oy: number;
  ink: number;
  w: number;
  drain: number;
  /** Ink level below which this hair stops touching; hairs drop out one by one, leaving streaks. */
  thr: number;
  /** Smoothed deposit, so a hair's tone changes gradually instead of flickering per step. */
  a: number;
  px: number;
  py: number;
}

const ALPHA_STEPS = [0.15, 0.3, 0.45, 0.6, 0.8, 1];

/** A right hand holds the brush so its tip rests toward the upper left of the belly. */
const HOLD_X = -Math.SQRT1_2;
const HOLD_Y = -Math.SQRT1_2;

/** Fill the brush footprint: the round belly plus the cone of the tip. */
function teardrop(ctx: CanvasRenderingContext2D, cx: number, cy: number, ax: number, ay: number, rc: number, tipDist: number) {
  ctx.beginPath();
  if (tipDist <= rc * 1.02) {
    ctx.arc(cx, cy, rc, 0, Math.PI * 2);
  } else {
    const base = Math.atan2(ay, ax);
    const th = Math.acos(rc / tipDist);
    ctx.moveTo(cx + ax * tipDist, cy + ay * tipDist);
    ctx.arc(cx, cy, rc, base + th, base - th + Math.PI * 2);
    ctx.closePath();
  }
  ctx.fill();
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Stroke {
  readonly rec: StrokeRecord;
  private ctx: CanvasRenderingContext2D;
  private brush: BrushProfile;
  private tone: ToneProfile;
  private field: PaperField;
  private rough: number;
  private absorb: number;
  private bristles: Bristle[] = [];
  private bx = 0;
  private by = 0;
  private p = 0;
  private v = 0;
  private lastT = 0;
  private lastRaw: InputPoint | null = null;
  private prevRaw: InputPoint | null = null;
  private dwell = 0;
  private consume: number;
  private started = false;
  private buckets: (Path2D | null)[] = new Array(ALPHA_STEPS.length * 2).fill(null);
  /** Direction from the belly to the tip of the brush (unit vector). */
  private tipX = HOLD_X;
  private tipY = HOLD_Y;
  /** Previous footprint (belly centre and tip point), to bridge the gap to the next one. */
  /** 1 while the brush is on the paper; falls toward 0 as it lifts away at the end of a flick. */
  private lift = 1;
  private prevFoot: { x: number; y: number; tx: number; ty: number } | null = null;
  private bucketR = 0;
  bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  constructor(ctx: CanvasRenderingContext2D, rec: StrokeRecord) {
    this.ctx = ctx;
    this.rec = rec;
    const s = rec.settings;
    this.brush = BRUSHES[s.brush];
    this.tone = TONES[s.tone];
    this.field = getPaper(s.paper);
    this.rough = PAPERS[s.paper].rough;
    this.absorb = PAPERS[s.paper].absorb;
    // Ink spent per pixel travelled. A full load writes roughly 70 brush-radii of line.
    const reach = 120 * this.brush.capacity * (0.5 + this.tone.water * 0.75);
    this.consume = 1 / (s.radius * reach);

    const rand = mulberry32(rec.seed);
    for (let i = 0; i < this.brush.bristles; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand());
      this.bristles.push({
        ox: Math.cos(a) * d,
        oy: Math.sin(a) * d,
        // Outer hairs hold less and give it up sooner, so a drying stroke frays at the edges first.
        ink: Math.min(1, rec.loadStart * (0.9 + rand() * 0.2) * (1 - 0.22 * d * d)),
        w: 0.6 + rand() * 0.8,
        drain: 0.75 + 0.8 * d * d + rand() * 0.35,
        thr: rand() * 0.5 + d * 0.25,
        a: 1,
        px: 0,
        py: 0,
      });
    }
  }

  get load(): number {
    let sum = 0;
    for (const b of this.bristles) sum += b.ink;
    return sum / this.bristles.length;
  }

  add(pt: InputPoint) {
    this.rec.points.push(pt);
    this.process(pt);
  }

  /** Apply a point without recording it (used during replay). */
  process(pt: InputPoint) {
    if (!this.started) {
      this.started = true;
      this.bx = pt.x;
      this.by = pt.y;
      this.lastT = pt.t;
      this.lastRaw = pt;
      this.p = 0.45;
      const r = this.radiusFor(this.p);
      for (const b of this.bristles) {
        b.px = pt.x + b.ox * r;
        b.py = pt.y + b.oy * r;
      }
      this.stamp(pt.x, pt.y, r, 0, this.p);
      this.flush();
      return;
    }

    const dt = Math.max(1, pt.t - this.lastT);
    const last = this.lastRaw!;
    const dist = Math.hypot(pt.x - last.x, pt.y - last.y);
    const inst = dist / dt;
    const kv = 1 - Math.exp(-dt / 70);
    this.v += (inst - this.v) * kv;

    // Pressure: pen pressure if the device reports it, otherwise inferred from speed.
    let target: number;
    if (pt.p >= 0) {
      target = Math.pow(Math.min(1, Math.max(0, pt.p)), 0.85) * (1 - 0.25 * smoothstep(0.5, 5, this.v));
    } else {
      target = 1 - smoothstep(0.1, 2.4, this.v) * 0.85;
    }
    const kp = 1 - Math.exp(-dt / this.brush.tau);
    const pNext = this.p + (target - this.p) * kp;

    if (dist < 0.6) {
      this.dwell += dt;
      this.pool(dt);
    } else {
      this.dwell = 0;
      // The tip drags behind the motion but never forgets how the hand holds the brush.
      const drag = Math.min(1, this.v / 0.6) * 0.5;
      this.turnTip(HOLD_X * (1 - drag) - ((pt.x - last.x) / dist) * drag, HOLD_Y * (1 - drag) - ((pt.y - last.y) / dist) * drag, 1 - Math.exp(-dt / this.brush.tipLag));
    }

    const tx = this.bx + (pt.x - this.bx) * this.brush.follow;
    const ty = this.by + (pt.y - this.by) * this.brush.follow;
    this.moveTo(tx, ty, pNext);

    this.lastT = pt.t;
    if (dist >= 0.6) this.prevRaw = last;
    this.lastRaw = pt;
  }

  /** Lift the brush: catch up to the hand, then flick out a tapered tip (出锋) if moving fast. */
  finish(): number {
    if (!this.started || !this.lastRaw) return this.load;
    const raw = this.lastRaw;
    this.moveTo(raw.x, raw.y, this.p);
    if (this.v > 0.6 && this.prevRaw) {
      const dx = raw.x - this.prevRaw.x;
      const dy = raw.y - this.prevRaw.y;
      const len = Math.hypot(dx, dy) || 1;
      const tail = Math.min(this.rec.settings.radius * 4.5, this.v * 60);
      const steps = 12;
      let x = raw.x;
      let y = raw.y;
      let p = this.p;
      for (let i = 0; i < steps; i++) {
        x += (dx / len) * (tail / steps);
        y += (dy / len) * (tail / steps);
        p *= 0.78;
        this.lift = Math.pow(1 - (i + 1) / (steps + 1), 1.1);
        // As the brush lifts away, the hairs gather into a point trailing the flick.
        this.turnTip(-dx / len, -dy / len, 0.3);
        this.moveTo(x, y, p);
      }
    }
    return this.load;
  }

  private turnTip(gx: number, gy: number, k: number) {
    const len = Math.hypot(gx, gy);
    if (len < 1e-6) return;
    let x = this.tipX + (gx / len - this.tipX) * k;
    let y = this.tipY + (gy / len - this.tipY) * k;
    const l = Math.hypot(x, y) || 1;
    this.tipX = x / l;
    this.tipY = y / l;
  }

  private radiusFor(p: number) {
    const { minF, maxF } = this.brush;
    return this.rec.settings.radius * (minF + (maxF - minF) * p) * this.lift;
  }

  private moveTo(tx: number, ty: number, pNext: number) {
    const r0 = this.radiusFor(this.p);
    const d = Math.hypot(tx - this.bx, ty - this.by);
    const step = Math.max(0.75, r0 * 0.12);
    const n = Math.max(1, Math.ceil(d / step));
    const sx = this.bx;
    const sy = this.by;
    const sp = this.p;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const p = sp + (pNext - sp) * f;
      this.stamp(sx + (tx - sx) * f, sy + (ty - sy) * f, this.radiusFor(p), d / n, p);
    }
    this.flush();
    this.bx = tx;
    this.by = ty;
    this.p = pNext;
  }

  /** Draw the open hair paths. One stroke() per bucket, so a hair's own overlaps never darken. */
  private flush() {
    const ctx = this.ctx;
    ctx.lineJoin = 'round';
    for (let k = 0; k < this.buckets.length; k++) {
      const path = this.buckets[k];
      if (!path) continue;
      const alpha = ALPHA_STEPS[k >> 1];
      // Opaque hairs get round ends; translucent ones butt ends so consecutive runs don't overlap into beads.
      ctx.lineCap = alpha >= 1 ? 'round' : 'butt';
      ctx.globalAlpha = alpha;
      // A drying hair carries less ink and leaves a finer line.
      const thin = alpha >= 1 ? 1 : 0.3 + 0.5 * alpha;
      ctx.lineWidth = Math.max(0.8, this.bucketR * (k & 1 ? 0.19 : 0.12) * thin);
      ctx.stroke(path);
      this.buckets[k] = null;
    }
    this.bucketR = 0;
  }

  /** Ink pooling while the brush rests on the paper. */
  private pool(dt: number) {
    const load = this.load;
    // A nearly dry brush has nothing to pool.
    if (load < 0.45) return;
    const wet = Math.max(0, this.dwell - 180);
    const growth = Math.min(0.6, (this.absorb * (0.25 + this.tone.water) * this.brush.bleed * wet) / 2600);
    const base = this.radiusFor(this.p);
    // A resting brush leaves a round pool; the paper's bleed gives it a soft edge afterwards.
    const r = base * (0.98 + growth) * Math.min(1, (load - 0.3) * 2.5);
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(this.bx, this.by, r, 0, Math.PI * 2);
    ctx.fill();
    this.grow(this.bx, this.by, r);
    for (const b of this.bristles) b.ink = Math.max(0, b.ink - dt * 0.00005 * b.drain * this.absorb);
  }

  private grow(x: number, y: number, r: number) {
    const bb = this.bbox;
    if (x - r < bb.minX) bb.minX = x - r;
    if (y - r < bb.minY) bb.minY = y - r;
    if (x + r > bb.maxX) bb.maxX = x + r;
    if (y + r > bb.maxY) bb.maxY = y + r;
  }

  private stamp(x: number, y: number, r: number, ds: number, p: number) {
    const ctx = this.ctx;
    const load = this.load;
    const speedDry = smoothstep(1.2, 5, this.v) * 0.55;

    // Saturated belly of the brush: a solid core that narrows as the brush dries.
    const coreK = smoothstep(0.28, 0.72, load * (1 - speedDry * 0.6));
    // A wet, unhurried brush closes up into one smooth body; hairs only show once it dries or speeds up.
    const wet = smoothstep(0.25, 0.7, load) * Math.max(0, 1 - speedDry * 1.6);
    // Footprint: a pressed brush is mostly belly; a light touch is mostly tip.
    const tipF = this.brush.tip * (0.3 + 0.85 * (1 - p));
    const ax = this.tipX;
    const ay = this.tipY;
    if (coreK > 0.02) {
      ctx.globalAlpha = 1;
      const rc = r * (0.84 * coreK * (1 - wet) + wet);
      const tipDist = rc * (1 + tipF * 0.9);
      teardrop(ctx, x, y, ax, ay, rc, tipDist);
      const foot = { x, y, tx: x + ax * tipDist, ty: y + ay * tipDist };
      const pf = this.prevFoot;
      if (pf && ds > 0) {
        ctx.beginPath();
        ctx.moveTo(pf.x, pf.y);
        ctx.lineTo(pf.tx, pf.ty);
        ctx.lineTo(foot.tx, foot.ty);
        ctx.lineTo(foot.x, foot.y);
        ctx.closePath();
        ctx.fill();
      }
      this.prevFoot = foot;
    } else {
      this.prevFoot = null;
    }
    const spread = r * (1 - 0.16 * wet);

    // Individual bristle tracks, grouped by opacity and width to keep draw calls low.
    const buckets = this.buckets;
    if (r > this.bucketR) this.bucketR = r;
    for (const b of this.bristles) {
      // Map the hair from the unit disc onto the teardrop: hairs ahead of the belly
      // run out into the tip and pinch together.
      let lx = b.ox;
      let ly = b.oy;
      if (lx > 0) {
        ly *= Math.sqrt((1 - lx) / (1 + lx));
        lx *= 1 + tipF;
      }
      const nx = x + (ax * lx - ay * ly) * spread;
      const ny = y + (ay * lx + ax * ly) * spread;
      // When the brush swells or shrinks in place, hairs move sideways rather than along the
      // stroke; drawing that would leave radial spikes, so only the position updates.
      if (ds < 0.3 || Math.hypot(nx - b.px, ny - b.py) > ds * 1.6 + 0.5) {
        b.px = nx;
        b.py = ny;
        continue;
      }
      const t = sampleField(this.field, nx, ny);
      const eff = b.ink * (1 - speedDry * (0.5 + this.rough));
      // Mostly the hair's own threshold (continuous streaks), nudged by the paper grain (broken edges).
      const thr = 0.03 + b.thr * (0.6 + this.rough * 0.6) + (t - 0.5) * this.rough * 0.35;
      const target = smoothstep(thr, thr + 0.1, eff) * (0.55 + 0.45 * b.ink);
      // Gaps open immediately (that's the flying white); tone otherwise eases.
      b.a = target < 0.08 ? 0 : b.a + (target - b.a) * 0.3;
      const a = b.a;
      if (a > 0.08) {
        let ai = 0;
        while (ai < ALPHA_STEPS.length - 1 && ALPHA_STEPS[ai] < a) ai++;
        const key = ai * 2 + (b.w > 1 ? 1 : 0);
        const path = buckets[key] ?? (buckets[key] = new Path2D());
        path.moveTo(b.px, b.py);
        path.lineTo(nx, ny);
        b.ink = Math.max(0, b.ink - ds * a * this.consume * b.drain);
      }
      b.px = nx;
      b.py = ny;
    }
    // The core also spends ink.
    if (coreK > 0.02) {
      for (const b of this.bristles) b.ink = Math.max(0, b.ink - ds * this.consume * 0.35 * coreK);
    }
    this.grow(x, y, r * (1 + tipF));
  }
}

// ── Committing a finished stroke to the sheet ────────────────────────────────

/** Separable-ish blur by repeated halving then doubling; cheap and available everywhere. */
function blurRegion(src: HTMLCanvasElement, sx: number, sy: number, w: number, h: number, levels: number) {
  let cur = document.createElement('canvas');
  cur.width = w;
  cur.height = h;
  cur.getContext('2d')!.drawImage(src, sx, sy, w, h, 0, 0, w, h);
  const sizes: [number, number][] = [[w, h]];
  for (let i = 0; i < levels; i++) {
    const [pw, ph] = sizes[sizes.length - 1];
    const nw = Math.max(1, Math.ceil(pw / 2));
    const nh = Math.max(1, Math.ceil(ph / 2));
    const next = document.createElement('canvas');
    next.width = nw;
    next.height = nh;
    const c = next.getContext('2d')!;
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, nw, nh);
    cur = next;
    sizes.push([nw, nh]);
  }
  for (let i = sizes.length - 2; i >= 0; i--) {
    const [nw, nh] = sizes[i];
    const next = document.createElement('canvas');
    next.width = nw;
    next.height = nh;
    const c = next.getContext('2d')!;
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, nw, nh);
    cur = next;
  }
  return cur;
}

/**
 * Let the paper show through a little: raised fibres take slightly less ink, and the
 * stroke's edge breaks along the grain and wicks a touch into the valleys between fibres.
 */
function applyGrain(scratch: HTMLCanvasElement, s: StrokeSettings, x0: number, y0: number, w: number, h: number) {
  const paper = PAPERS[s.paper];
  const field = getPaper(s.paper);
  const amount = 0.35 + paper.rough * 0.65;
  const wick = amount * (0.3 + paper.absorb * 0.7);
  const ctx = scratch.getContext('2d')!;
  const img = ctx.getImageData(x0, y0, w, h);
  const near = blurRegion(scratch, x0, y0, w, h, 2).getContext('2d')!.getImageData(0, 0, w, h).data;
  const d = img.data;
  const hex = parseInt(INK_COLORS[s.ink].slice(1), 16);
  const cr = (hex >> 16) & 255;
  const cg = (hex >> 8) & 255;
  const cb = hex & 255;
  for (let y = 0; y < h; y++) {
    const row = ((y + y0) & (TILE - 1)) * TILE;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const B = near[i + 3] / 255;
      if (B === 0) continue;
      const f = field.data[row + ((x + x0) & (TILE - 1))];
      let A = d[i + 3] / 255;
      const edge = 1 - Math.abs(2 * B - 1);
      if (A > 0) {
        A *= 1 - 0.2 * amount * smoothstep(0.55, 0.95, f);
        A *= 1 - 0.75 * amount * edge * smoothstep(0.45, 0.8, f);
      }
      if (A < 0.5 && B > 0.15) {
        A = Math.max(A, B * 0.7 * wick * (1 - smoothstep(0.2, 0.5, f)));
      }
      d[i] = cr;
      d[i + 1] = cg;
      d[i + 2] = cb;
      d[i + 3] = A * 255;
    }
  }
  ctx.putImageData(img, x0, y0);
}

export interface CommitTargets {
  ink: CanvasRenderingContext2D;
  /** Where the bleed halo lands; defaults to `ink`. A separate layer lets it fade in. */
  halo?: CanvasRenderingContext2D;
}

/**
 * A stroke's finished pixels. Multiply blending is commutative and associative, so the sheet
 * can be rebuilt by compositing these in any order without re-simulating the brush.
 */
export interface StrokeImage {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

const strokeImages = new WeakMap<StrokeRecord, StrokeImage>();

export function commitStroke(scratch: HTMLCanvasElement, stroke: Stroke, targets: CommitTargets) {
  const s = stroke.rec.settings;
  const bb = stroke.bbox;
  if (!isFinite(bb.minX)) return;
  const tone = TONES[s.tone];
  const brush = BRUSHES[s.brush];
  const paper = PAPERS[s.paper];
  const size = scratch.width;

  const bleed = paper.absorb * (0.2 + tone.water) * brush.bleed * (0.35 + 0.65 * Math.min(1, stroke.rec.loadStart));
  const spread = s.radius * (0.12 + 0.75 * bleed);
  const pad = Math.ceil(spread * 2.5 + 12);
  const x0 = Math.max(0, Math.floor(bb.minX - pad));
  const y0 = Math.max(0, Math.floor(bb.minY - pad));
  const x1 = Math.min(size, Math.ceil(bb.maxX + pad));
  const y1 = Math.min(size, Math.ceil(bb.maxY + pad));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;

  applyGrain(scratch, s, x0, y0, w, h);

  // Build the stroke's full contribution once: bleed halo, wet edge, then the stroke itself.
  const image = document.createElement('canvas');
  image.width = w;
  image.height = h;
  const ictx = image.getContext('2d')!;
  ictx.globalCompositeOperation = 'multiply';

  let blurred: HTMLCanvasElement | null = null;
  let haloAlpha = 0;
  if (bleed > 0.04) {
    const levels = Math.max(1, Math.min(6, Math.round(Math.log2(spread)) - 1));
    blurred = blurRegion(scratch, x0, y0, w, h, levels);
    const bctx = blurred.getContext('2d')!;
    // Ink is densest just outside the edge: stack the blur on itself so the fringe holds near the stroke.
    bctx.drawImage(blurred, 0, 0);
    bctx.drawImage(blurred, 0, 0);
    // Break the halo up along the paper fibres.
    const mask = bctx.createPattern(getPaper(s.paper).bleedMask, 'repeat')!;
    mask.setTransform(new DOMMatrix().translate(-x0, -y0));
    bctx.globalCompositeOperation = 'destination-in';
    bctx.fillStyle = mask;
    bctx.fillRect(0, 0, w, h);
    haloAlpha = tone.density * Math.min(0.9, 0.35 + bleed * 0.8);

    // Wet edge: a slight softening of the stroke's own boundary.
    ictx.globalAlpha = tone.density * Math.min(0.5, bleed * 0.5);
    ictx.drawImage(blurRegion(scratch, x0, y0, w, h, 1), 0, 0);
  }
  ictx.globalAlpha = tone.density;
  ictx.drawImage(scratch, x0, y0, w, h, 0, 0, w, h);

  const ink = targets.ink;
  ink.save();
  ink.globalCompositeOperation = 'multiply';
  ink.drawImage(image, x0, y0);
  ink.restore();

  if (blurred) {
    // Live strokes put the halo on its own layer so it can creep outward; it also goes into the cache.
    const halo = targets.halo ?? ink;
    halo.save();
    halo.globalCompositeOperation = 'multiply';
    halo.globalAlpha = haloAlpha;
    halo.drawImage(blurred, x0, y0);
    halo.restore();
    ictx.globalAlpha = haloAlpha;
    ictx.drawImage(blurred, 0, 0);
  }

  strokeImages.set(stroke.rec, { canvas: image, x: x0, y: y0 });
}

export function prepareScratch(ctx: CanvasRenderingContext2D, settings: StrokeSettings) {
  ctx.fillStyle = INK_COLORS[settings.ink];
  ctx.strokeStyle = INK_COLORS[settings.ink];
  ctx.globalCompositeOperation = 'source-over';
}

/** Put a recorded stroke back on the sheet, from its cached pixels when available. */
export function replayStroke(scratch: HTMLCanvasElement, rec: StrokeRecord, targets: CommitTargets) {
  const cached = strokeImages.get(rec);
  if (cached) {
    targets.ink.save();
    targets.ink.globalCompositeOperation = 'multiply';
    targets.ink.drawImage(cached.canvas, cached.x, cached.y);
    targets.ink.restore();
    return;
  }
  const sctx = scratch.getContext('2d')!;
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  prepareScratch(sctx, rec.settings);
  // Re-simulate on a copy so the record keeps its original points.
  const stroke = new Stroke(sctx, { ...rec, points: [] });
  for (const pt of rec.points) stroke.process(pt);
  stroke.finish();
  commitStroke(scratch, stroke, targets);
  // Cache under the original record, not the working copy.
  const img = strokeImages.get(stroke.rec);
  if (img) strokeImages.set(rec, img);
  sctx.clearRect(0, 0, scratch.width, scratch.height);
}
