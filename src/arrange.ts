// Arrange: lay every written cell out as one piece of work, like a finished scroll,
// then export it as a single image.

import { getPaper, type PaperKind } from './engine/paper';
import { drawCellGrids, type GridColor, type GridKind } from './engine/sheet';

export interface Piece {
  id: string;
  /** The model character that cell was practising, if any. */
  label: string;
  /** The cell's ink, square, transparent background. */
  image: HTMLCanvasElement;
}

export type Direction = 'vertical' | 'horizontal';

export interface ArrangeOptions {
  direction: Direction;
  perLine: number;
  /** Gap between characters as a fraction of a cell. */
  gap: number;
  showGrid: boolean;
}

export interface Look {
  paper: PaperKind;
  grid: GridKind;
  gridColor: GridColor;
}

interface Slot {
  x: number;
  y: number;
  size: number;
}

/** Positions for `count` characters. Vertical runs top to bottom in columns read right to left (竖排). */
export function layout(count: number, opt: ArrangeOptions, tile: number) {
  const per = Math.max(1, Math.min(opt.perLine, Math.max(1, count)));
  const lines = Math.max(1, Math.ceil(count / per));
  const gap = tile * opt.gap;
  const margin = tile * 0.45;
  const cols = opt.direction === 'vertical' ? lines : per;
  const rows = opt.direction === 'vertical' ? per : lines;
  const width = margin * 2 + cols * tile + (cols - 1) * gap;
  const height = margin * 2 + rows * tile + (rows - 1) * gap;
  const slots: Slot[] = [];
  for (let i = 0; i < Math.max(count, 1); i++) {
    const line = Math.floor(i / per);
    const k = i % per;
    if (opt.direction === 'vertical') {
      slots.push({ x: width - margin - tile - line * (tile + gap), y: margin + k * (tile + gap), size: tile });
    } else {
      slots.push({ x: margin + k * (tile + gap), y: margin + line * (tile + gap), size: tile });
    }
  }
  return { width, height, slots, cols, rows };
}

export function drawComposition(
  ctx: CanvasRenderingContext2D,
  pieces: Piece[],
  opt: ArrangeOptions,
  look: Look,
  tile: number,
  include: { paper: boolean; grid: boolean; opaque: boolean },
) {
  const { width, height, slots } = layout(pieces.length, opt, tile);
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  if (include.paper) {
    const pattern = ctx.createPattern(getPaper(look.paper).tile, 'repeat')!;
    // Keep the paper fibres at a similar size relative to the characters as on a sheet.
    const k = tile / 560;
    pattern.setTransform(new DOMMatrix().scale(k, k));
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  } else if (include.opaque) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  if (include.grid && opt.showGrid) {
    drawCellGrids(ctx, slots.slice(0, pieces.length), look.grid, look.gridColor, {
      outer: Math.max(1, tile * 0.006),
      inner: Math.max(0.75, tile * 0.0028),
    });
  }
  ctx.globalCompositeOperation = include.paper || include.grid || include.opaque ? 'multiply' : 'source-over';
  pieces.forEach((p, i) => {
    const s = slots[i];
    ctx.drawImage(p.image, s.x, s.y, s.size, s.size);
  });
  ctx.restore();
  return { width, height, slots };
}

export interface ArrangeController {
  open(pieces: Piece[]): void;
  close(): void;
  render(): void;
  setOptions(opt: Partial<ArrangeOptions>): void;
  moveSelected(delta: number): void;
  hideSelected(): void;
  restoreHidden(): void;
  visible(): Piece[];
  hiddenCount(): number;
  selected(): Piece | null;
  exportCanvas(longEdge: number, include: { paper: boolean; grid: boolean; opaque: boolean }): HTMLCanvasElement | null;
}

export function createArrange(
  canvas: HTMLCanvasElement,
  frame: HTMLElement,
  initial: ArrangeOptions,
  look: () => Look,
  onChange: (summary: string) => void,
): ArrangeController {
  const ctx = canvas.getContext('2d')!;
  const opt: ArrangeOptions = { ...initial };
  let pieces: Piece[] = [];
  let order: string[] = [];
  const hidden = new Set<string>();
  let selectedId: string | null = null;
  let drag: { id: string; startX: number; startY: number; x: number; y: number; active: boolean; target: number } | null = null;
  let scale = 1;
  let tile = 100;

  const byId = () => new Map(pieces.map((p) => [p.id, p]));
  const visible = () => {
    const map = byId();
    return order.filter((id) => !hidden.has(id) && map.has(id)).map((id) => map.get(id)!);
  };

  function summary() {
    const v = visible();
    const sel = selectedId ? v.findIndex((p) => p.id === selectedId) : -1;
    const lineWord = opt.direction === 'vertical' ? 'column' : 'row';
    const lines = Math.ceil(v.length / Math.max(1, opt.perLine)) || 0;
    let text = v.length
      ? `${v.length} ${v.length === 1 ? 'character' : 'characters'} in ${lines} ${lineWord}${lines === 1 ? '' : 's'}`
      : 'Nothing to arrange';
    if (sel >= 0) text += `. Selected ${sel + 1} of ${v.length}${v[sel].label ? `, ${v[sel].label}` : ''}`;
    canvas.setAttribute('aria-label', `Arrangement: ${text}. Arrow keys select, Shift with an arrow moves, Delete hides.`);
    onChange(text);
  }

  function fit() {
    const v = visible();
    const box = frame.getBoundingClientRect();
    const avail = Math.max(50, Math.min(box.width, box.height));
    const unit = layout(v.length, opt, 100);
    const k = Math.min(avail / unit.width, avail / unit.height);
    const cssW = Math.max(1, Math.floor(unit.width * k));
    const cssH = Math.max(1, Math.floor(unit.height * k));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    tile = 100 * k * dpr;
    scale = dpr;
    canvas.width = Math.round(unit.width * k * dpr);
    canvas.height = Math.round(unit.height * k * dpr);
  }

  function render() {
    fit();
    const v = visible();
    const shown = drag?.active ? v.filter((p) => p.id !== drag!.id) : v;
    // While dragging, leave a gap where the piece would land.
    const arranged = drag?.active ? [...shown.slice(0, drag.target), null, ...shown.slice(drag.target)] : v;
    const lay = layout(v.length, opt, tile);
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const l = look();
    const pattern = ctx.createPattern(getPaper(l.paper).tile, 'repeat')!;
    const k = tile / 560;
    pattern.setTransform(new DOMMatrix().scale(k, k));
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, lay.width, lay.height);
    if (opt.showGrid) {
      drawCellGrids(ctx, lay.slots.slice(0, v.length), l.grid, l.gridColor, {
        outer: Math.max(1, tile * 0.006),
        inner: Math.max(0.75, tile * 0.0028),
      });
    }
    ctx.globalCompositeOperation = 'multiply';
    arranged.forEach((p, i) => {
      if (!p) return;
      const s = lay.slots[i];
      ctx.drawImage(p.image, s.x, s.y, s.size, s.size);
    });
    ctx.globalCompositeOperation = 'source-over';
    if (drag?.active) {
      const s = lay.slots[drag.target];
      ctx.strokeStyle = 'rgb(0 0 0 / 0.45)';
      ctx.setLineDash([6 * scale, 5 * scale]);
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeRect(s.x + 1, s.y + 1, s.size - 2, s.size - 2);
      const p = v.find((q) => q.id === drag!.id)!;
      ctx.globalAlpha = 0.85;
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(p.image, drag.x * scale - tile / 2, drag.y * scale - tile / 2, tile, tile);
    } else if (selectedId) {
      const i = v.findIndex((p) => p.id === selectedId);
      if (i >= 0) {
        const s = lay.slots[i];
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2 * scale;
        const inset = 3 * scale;
        ctx.strokeRect(s.x - inset, s.y - inset, s.size + inset * 2, s.size + inset * 2);
      }
    }
    ctx.restore();
    summary();
  }

  function slotAt(px: number, py: number, count: number) {
    const lay = layout(count, opt, tile);
    let best = 0;
    let bestD = Infinity;
    lay.slots.slice(0, count).forEach((s, i) => {
      const d = Math.hypot(px * scale - (s.x + s.size / 2), py * scale - (s.y + s.size / 2));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return { index: best, inside: bestD < tile * 0.75 };
  }

  function move(id: string, to: number) {
    const v = visible().map((p) => p.id);
    const from = v.indexOf(id);
    if (from < 0) return;
    v.splice(from, 1);
    v.splice(Math.max(0, Math.min(v.length, to)), 0, id);
    // Hidden pieces keep their place at the end of the order.
    order = [...v, ...order.filter((x) => !v.includes(x))];
  }

  canvas.addEventListener('pointerdown', (e) => {
    const v = visible();
    if (!v.length) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hit = slotAt(x, y, v.length);
    if (!hit.inside) {
      selectedId = null;
      render();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    selectedId = v[hit.index].id;
    drag = { id: selectedId, startX: x, startY: y, x, y, active: false, target: hit.index };
    render();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    drag.x = e.clientX - r.left;
    drag.y = e.clientY - r.top;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 6) drag.active = true;
    if (drag.active) {
      drag.target = slotAt(drag.x, drag.y, visible().length).index;
      render();
    }
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.active) move(drag.id, drag.target);
    drag = null;
    render();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', () => {
    drag = null;
    render();
  });

  canvas.addEventListener('keydown', (e) => {
    const v = visible();
    if (!v.length) return;
    let i = selectedId ? v.findIndex((p) => p.id === selectedId) : -1;
    const per = Math.max(1, opt.perLine);
    // Steps in reading order for each arrow, depending on the direction of writing.
    const steps: Record<string, number> =
      opt.direction === 'vertical'
        ? { ArrowUp: -1, ArrowDown: 1, ArrowLeft: per, ArrowRight: -per }
        : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -per, ArrowDown: per };
    if (e.key in steps) {
      e.preventDefault();
      if (i < 0) {
        selectedId = v[0].id;
      } else if (e.shiftKey || e.altKey) {
        move(v[i].id, i + steps[e.key]);
      } else {
        i = Math.max(0, Math.min(v.length - 1, i + steps[e.key]));
        selectedId = v[i].id;
      }
      render();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && i >= 0) {
      e.preventDefault();
      ctl.hideSelected();
    } else if (e.key === 'Escape') {
      selectedId = null;
      render();
    }
  });
  canvas.addEventListener('focus', () => {
    if (!selectedId && visible().length) {
      selectedId = visible()[0].id;
      render();
    }
  });

  new ResizeObserver(() => {
    if (!frame.hidden) render();
  }).observe(frame);

  const ctl: ArrangeController = {
    open(next) {
      const known = new Set(next.map((p) => p.id));
      // Keep the user's order for pieces that still exist; new ones join at the end.
      order = [...order.filter((id) => known.has(id)), ...next.map((p) => p.id).filter((id) => !order.includes(id))];
      for (const id of [...hidden]) if (!known.has(id)) hidden.delete(id);
      pieces = next;
      if (selectedId && !known.has(selectedId)) selectedId = null;
      render();
    },
    close() {
      drag = null;
    },
    render,
    setOptions(o) {
      Object.assign(opt, o);
      render();
    },
    moveSelected(delta) {
      const v = visible();
      const i = v.findIndex((p) => p.id === selectedId);
      if (i < 0) return;
      move(v[i].id, i + delta);
      render();
    },
    hideSelected() {
      const v = visible();
      const i = v.findIndex((p) => p.id === selectedId);
      if (i < 0) return;
      hidden.add(v[i].id);
      const next = visible();
      selectedId = next[Math.min(i, next.length - 1)]?.id ?? null;
      render();
    },
    restoreHidden() {
      hidden.clear();
      render();
    },
    visible,
    hiddenCount: () => [...hidden].filter((id) => pieces.some((p) => p.id === id)).length,
    selected: () => visible().find((p) => p.id === selectedId) ?? null,
    exportCanvas(longEdge, include) {
      const v = visible();
      if (!v.length) return null;
      const unit = layout(v.length, opt, 100);
      const t = (100 * longEdge) / Math.max(unit.width, unit.height);
      const lay = layout(v.length, opt, t);
      const out = document.createElement('canvas');
      out.width = Math.round(lay.width);
      out.height = Math.round(lay.height);
      const c = out.getContext('2d')!;
      c.imageSmoothingQuality = 'high';
      drawComposition(c, v, opt, look(), t, include);
      return out;
    },
  };
  return ctl;
}
