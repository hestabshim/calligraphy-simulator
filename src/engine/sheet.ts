// Sheet geometry, practice grids (格) and model characters (范字).

export type GridKind = 'tian' | 'mi' | 'jiugong' | 'huigong' | 'fang';
export type GridColor = 'zhu' | 'hui' | 'off';
export type GuideMode = 'trace' | 'copy' | 'off';

export const GRID_COLORS: Record<Exclude<GridColor, 'off'>, string> = {
  zhu: '#c9442e', // 朱: vermilion, as printed on most practice sheets
  hui: '#8f8f8b',
};

export interface Cell {
  x: number;
  y: number;
  size: number;
  row: number;
  col: number;
}

export function sheetCells(size: number, n: number): Cell[] {
  const margin = size * (n === 1 ? 0.06 : 0.045);
  const cell = (size - margin * 2) / n;
  const cells: Cell[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      cells.push({ x: margin + col * cell, y: margin + row * cell, size: cell, row, col });
    }
  }
  return cells;
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  size: number,
  n: number,
  kind: GridKind,
  color: GridColor,
) {
  if (color === 'off') return;
  const unit = size / 2048;
  drawCellGrids(ctx, sheetCells(size, n), kind, color, {
    outer: Math.max(2, 4.5 * unit * (n === 1 ? 1.4 : 1)),
    inner: Math.max(1, 2 * unit),
  });
}

/** Draw the practice grid inside each given cell (cells share one size). */
export function drawCellGrids(
  ctx: CanvasRenderingContext2D,
  cells: Pick<Cell, 'x' | 'y' | 'size'>[],
  kind: GridKind,
  color: GridColor,
  widths: { outer: number; inner: number },
) {
  if (color === 'off' || !cells.length) return;
  const s = cells[0].size;
  const { outer, inner } = widths;
  const dash = [Math.max(3, s * 0.018), Math.max(3, s * 0.016)];

  ctx.save();
  ctx.strokeStyle = GRID_COLORS[color];
  ctx.lineCap = 'butt';

  // Inner guide lines, dashed and lighter so ink reads above them.
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = inner;
  ctx.setLineDash(dash);
  for (const c of cells) {
    const { x, y } = c;
    const m = s / 2;
    ctx.beginPath();
    if (kind === 'tian' || kind === 'mi' || kind === 'huigong') {
      ctx.moveTo(x + m, y);
      ctx.lineTo(x + m, y + s);
      ctx.moveTo(x, y + m);
      ctx.lineTo(x + s, y + m);
    }
    if (kind === 'mi') {
      ctx.moveTo(x, y);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y);
      ctx.lineTo(x, y + s);
    }
    if (kind === 'jiugong') {
      for (const f of [1 / 3, 2 / 3]) {
        ctx.moveTo(x + s * f, y);
        ctx.lineTo(x + s * f, y + s);
        ctx.moveTo(x, y + s * f);
        ctx.lineTo(x + s, y + s * f);
      }
    }
    ctx.stroke();

    if (kind === 'huigong') {
      // 回宫格: the inner box frames the 中宫, the dense centre of the character.
      ctx.setLineDash([]);
      ctx.lineWidth = inner * 1.2;
      const k = 0.52;
      ctx.strokeRect(x + (s * (1 - k)) / 2, y + (s * (1 - k)) / 2, s * k, s * k);
      ctx.lineWidth = inner;
      ctx.setLineDash(dash);
    }
  }

  // Cell borders, solid.
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineWidth = outer;
  for (const c of cells) ctx.strokeRect(c.x, c.y, s, s);
  ctx.restore();
}

export const KAI_STACK = '"LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", serif';

/** Which character (if any) each cell shows, and whether it is the solid model or a faint tracing copy. */
export function guideLayout(n: number, chars: string[], mode: GuideMode) {
  const out: { cellIndex: number; ch: string; model: boolean }[] = [];
  if (mode === 'off' || chars.length === 0) return out;
  for (let row = 0; row < n; row++) {
    const ch = chars[row];
    if (!ch) continue;
    for (let col = 0; col < n; col++) {
      if (mode === 'copy' && col > 0) break;
      // 1×1 trace shows a faint model; a copy sheet shows one model per row.
      out.push({ cellIndex: row * n + col, ch, model: mode === 'copy' && n > 1 });
    }
  }
  return out;
}

export function drawGuides(
  ctx: CanvasRenderingContext2D,
  size: number,
  n: number,
  chars: string[],
  mode: GuideMode,
  color: GridColor,
) {
  const cells = sheetCells(size, n);
  const hue = GRID_COLORS[color === 'off' ? 'zhu' : color];
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const g of guideLayout(n, chars, mode)) {
    const c = cells[g.cellIndex];
    const fontSize = c.size * 0.8;
    ctx.font = `${fontSize}px ${KAI_STACK}`;
    const m = ctx.measureText(g.ch);
    const asc = m.actualBoundingBoxAscent || fontSize * 0.8;
    const desc = m.actualBoundingBoxDescent || fontSize * 0.1;
    ctx.fillStyle = hue;
    ctx.globalAlpha = g.model ? 0.62 : 0.2;
    ctx.fillText(g.ch, c.x + c.size / 2, c.y + c.size / 2 + (asc - desc) / 2);
  }
  ctx.restore();
}
