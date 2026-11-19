import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css';
import './styles.css';

import {
  BRUSHES,
  INK_COLORS,
  Stroke,
  TONES,
  commitStroke,
  prepareScratch,
  replayStroke,
  type BrushKind,
  type InkColor,
  type InputPoint,
  type StrokeRecord,
  type ToneKind,
} from './engine/brush';
import { paintPaper, type PaperKind } from './engine/paper';
import { drawGrid, drawGuides, KAI_STACK, sheetCells, type GridColor, type GridKind, type GuideMode } from './engine/sheet';
import { PRESETS, QIANZIWEN, RANDOM_POOL, hanSequence } from './data/characters';
import { mulberry32 } from './engine/rng';
import { createArrange, type Direction, type Piece } from './arrange';

// ── Settings ─────────────────────────────────────────────────────────────────

type Mode = 'set' | 'random' | 'free';
type View = 'write' | 'arrange';

interface Settings {
  mode: Mode;
  setText: string;
  grid: GridKind;
  cells: number;
  guide: GuideMode;
  brush: BrushKind;
  size: number;
  tone: ToneKind;
  ink: InkColor;
  gridColor: GridColor;
  paper: PaperKind;
  autoDip: boolean;
  view: View;
  direction: Direction;
  perLine: number;
  gap: number;
  arrangeGrid: boolean;
}

const DEFAULTS: Settings = {
  mode: 'set',
  setText: QIANZIWEN.slice(0, 32),
  grid: 'mi',
  cells: 1,
  guide: 'trace',
  brush: 'mixed',
  size: 26,
  tone: 'nong',
  ink: 'mo',
  gridColor: 'zhu',
  paper: 'raw',
  autoDip: false,
  view: 'write',
  direction: 'vertical',
  perLine: 5,
  gap: 20,
  arrangeGrid: true,
};

const STORE_KEY = 'calligraphy-simulator:v1';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable */
  }
}

const settings = loadSettings();

const HINTS = {
  mode: { set: 'Your characters', random: 'Random characters', free: 'Blank sheets' },
  grid: {
    tian: 'Field grid 田字格',
    mi: 'Rice grid 米字格',
    jiugong: 'Nine-palace 九宫格',
    huigong: 'Centre box 回宫格',
    fang: 'Plain square 方格',
  },
  brush: { wolf: 'Weasel, stiff', mixed: 'Mixed hair', goat: 'Goat, soft' },
  tone: { jiao: 'Scorched', nong: 'Dense', zhong: 'Heavy', dan: 'Light', qing: 'Clear' },
  paper: { raw: 'Raw xuan, bleeds', half: 'Half-sized xuan', sized: 'Sized xuan, crisp', maobian: 'Bamboo paper' },
} as const;

// ── Canvas setup ─────────────────────────────────────────────────────────────

const SIZE = 2048;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const paperEl = $('paper');
const layers = {
  paper: $<HTMLCanvasElement>('layer-paper'),
  grid: $<HTMLCanvasElement>('layer-grid'),
  guide: $<HTMLCanvasElement>('layer-guide'),
  ink: $<HTMLCanvasElement>('layer-ink'),
  halo: $<HTMLCanvasElement>('layer-halo'),
  live: $<HTMLCanvasElement>('layer-live'),
};
for (const c of Object.values(layers)) {
  c.width = c.height = SIZE;
}
const ctx = {
  paper: layers.paper.getContext('2d')!,
  grid: layers.grid.getContext('2d')!,
  guide: layers.guide.getContext('2d')!,
  ink: layers.ink.getContext('2d')!,
  halo: layers.halo.getContext('2d')!,
  live: layers.live.getContext('2d')!,
};

// ── Sheets ───────────────────────────────────────────────────────────────────

type Action = { kind: 'stroke'; loadBefore: number } | { kind: 'clear'; removed: StrokeRecord[] };

interface Sheet {
  strokes: StrokeRecord[];
  history: Action[];
  /** Layout and characters the sheet was written with, so Arrange can cut it into cells. */
  cells: number;
  chars: string[];
  version: number;
}

const sheets = new Map<string, Sheet>();
const pageByMode: Record<Mode, number> = { set: 0, random: 0, free: 0 };
let load = 1;

function sheetKey() {
  return `${settings.mode}:${pageByMode[settings.mode]}`;
}

function currentSheet(): Sheet {
  const key = sheetKey();
  let s = sheets.get(key);
  if (!s) {
    s = { strokes: [], history: [], cells: settings.cells, chars: [], version: 0 };
    sheets.set(key, s);
  }
  return s;
}

function setChars(): string[] {
  return hanSequence(settings.setText);
}

function pageCount(): number {
  if (settings.mode !== 'set') return Infinity;
  return Math.max(1, Math.ceil(setChars().length / settings.cells));
}

/** Characters for the current sheet: one per row. */
function sheetChars(): string[] {
  const n = settings.cells;
  const page = pageByMode[settings.mode];
  if (settings.mode === 'free') return [];
  if (settings.mode === 'set') {
    return setChars().slice(page * n, page * n + n);
  }
  const rand = mulberry32(page * 2654435761 + n);
  const out: string[] = [];
  while (out.length < n) {
    const ch = RANDOM_POOL[Math.floor(rand() * RANDOM_POOL.length)];
    if (!out.includes(ch)) out.push(ch);
  }
  return out;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderPaper() {
  paintPaper(ctx.paper, settings.paper, SIZE);
}

function renderGrid() {
  ctx.grid.clearRect(0, 0, SIZE, SIZE);
  drawGrid(ctx.grid, SIZE, settings.cells, settings.grid, settings.gridColor);
}

let guideToken = 0;
async function renderGuides() {
  const token = ++guideToken;
  const chars = sheetChars();
  const mode: GuideMode = settings.mode === 'free' ? 'off' : settings.guide;
  if (chars.length && mode !== 'off') {
    try {
      await document.fonts.load(`64px ${KAI_STACK}`, chars.join(''));
    } catch {
      /* fall back to whatever Kai face is available */
    }
  }
  if (token !== guideToken) return;
  ctx.guide.clearRect(0, 0, SIZE, SIZE);
  drawGuides(ctx.guide, SIZE, settings.cells, chars, mode, settings.gridColor);
}

const scratch = layers.live;

function replayInk() {
  flushHalo();
  ctx.ink.clearRect(0, 0, SIZE, SIZE);
  for (const rec of currentSheet().strokes) replayStroke(scratch, rec, { ink: ctx.ink });
}

let haloTimer = 0;
function flushHalo() {
  window.clearTimeout(haloTimer);
  if (layers.halo.dataset.dirty) {
    ctx.ink.save();
    ctx.ink.globalCompositeOperation = 'multiply';
    ctx.ink.drawImage(layers.halo, 0, 0);
    ctx.ink.restore();
    ctx.halo.clearRect(0, 0, SIZE, SIZE);
    delete layers.halo.dataset.dirty;
  }
  layers.halo.style.transition = 'none';
  layers.halo.style.opacity = '0';
}

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** The one animated moment: wet ink creeping into the paper after the brush lifts. */
function revealHalo() {
  layers.halo.dataset.dirty = '1';
  if (reduceMotion.matches) {
    flushHalo();
    return;
  }
  layers.halo.style.transition = 'none';
  layers.halo.style.opacity = '0';
  void layers.halo.offsetWidth;
  layers.halo.style.transition = 'opacity 900ms cubic-bezier(0.2, 0.7, 0.3, 1)';
  layers.halo.style.opacity = '1';
  haloTimer = window.setTimeout(flushHalo, 950);
}

function renderSheetChrome() {
  const chars = sheetChars();
  const page = pageByMode[settings.mode];
  const total = pageCount();
  $('sheet-chars').textContent = chars.join('');
  $('sheet-label').textContent = Number.isFinite(total) ? `${page + 1} / ${total}` : `Sheet ${page + 1}`;
  ($('prev-sheet') as HTMLButtonElement).disabled = page === 0;
  ($('next-sheet') as HTMLButtonElement).disabled = page + 1 >= total;

  const strokes = currentSheet().strokes.length;
  const gridName = settings.gridColor === 'off' ? 'no grid' : HINTS.grid[settings.grid];
  const charText = chars.length ? `characters ${chars.join(' ')}` : 'blank';
  paperEl.setAttribute(
    'aria-label',
    `Practice sheet, ${settings.cells} by ${settings.cells} cells, ${gridName}, ${charText}, ${strokes} ${strokes === 1 ? 'stroke' : 'strokes'}`,
  );
  ($('undo') as HTMLButtonElement).disabled = currentSheet().history.length === 0;
  ($('clear') as HTMLButtonElement).disabled = strokes === 0;
}

function renderAll() {
  renderPaper();
  renderGrid();
  void renderGuides();
  replayInk();
  renderSheetChrome();
}

// ── Brush radius & ring cursor ───────────────────────────────────────────────

function baseRadius() {
  const cell = sheetCells(SIZE, settings.cells)[0].size;
  return cell * (0.012 + (settings.size / 100) * 0.075);
}

const ring = $('brush-ring');
function updateRing() {
  const scale = paperEl.clientWidth / SIZE;
  const d = baseRadius() * BRUSHES[settings.brush].maxF * 2 * scale;
  ring.style.width = ring.style.height = `${Math.max(4, d)}px`;
}

// ── Ink load meter ───────────────────────────────────────────────────────────

const loadBar = $('load-bar');
const status = $('status');

function setLoad(v: number) {
  load = Math.max(0, Math.min(1, v));
  loadBar.style.setProperty('--load', String(load));
  loadBar.setAttribute('aria-valuenow', String(Math.round(load * 100)));
  loadBar.setAttribute('aria-valuetext', `${Math.round(load * 100)}% ink`);
  const low = load < 0.18 && !settings.autoDip;
  loadBar.classList.toggle('is-low', low);
  status.textContent = low ? 'The brush is dry. Press D or Dip to reload.' : '';
}

function dip() {
  setLoad(1);
}

// ── Drawing ──────────────────────────────────────────────────────────────────

let active: { stroke: Stroke; pointerId: number; lastEvent: number; last: InputPoint } | null = null;
let holdTimer = 0;

function toPoint(e: PointerEvent): InputPoint {
  const rect = paperEl.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * SIZE,
    y: ((e.clientY - rect.top) / rect.height) * SIZE,
    t: e.timeStamp,
    p: e.pointerType === 'pen' ? e.pressure : -1,
  };
}

function moveRing(e: PointerEvent) {
  if (e.pointerType === 'touch') return;
  const rect = paperEl.getBoundingClientRect();
  ring.style.left = `${e.clientX - rect.left}px`;
  ring.style.top = `${e.clientY - rect.top}px`;
}

paperEl.addEventListener('pointerenter', (e) => {
  if (e.pointerType !== 'touch') paperEl.classList.add('is-hovering');
  updateRing();
});
paperEl.addEventListener('pointerleave', () => paperEl.classList.remove('is-hovering'));

paperEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || active) return;
  e.preventDefault();
  paperEl.setPointerCapture(e.pointerId);
  flushHalo();
  if (settings.autoDip) setLoad(1);

  const rec: StrokeRecord = {
    seed: (Math.random() * 2 ** 32) >>> 0,
    settings: {
      brush: settings.brush,
      tone: settings.tone,
      ink: settings.ink,
      paper: settings.paper,
      radius: baseRadius(),
    },
    loadStart: load,
    points: [],
  };
  const sctx = ctx.live;
  sctx.clearRect(0, 0, SIZE, SIZE);
  prepareScratch(sctx, rec.settings);
  layers.live.style.opacity = String(TONES[rec.settings.tone].density);
  const stroke = new Stroke(sctx, rec);
  const pt = toPoint(e);
  stroke.add(pt);
  active = { stroke, pointerId: e.pointerId, lastEvent: performance.now(), last: pt };

  // Keep time moving while the brush rests, so ink can pool.
  holdTimer = window.setInterval(() => {
    if (!active) return;
    const now = performance.now();
    if (now - active.lastEvent > 45) {
      const hold = { ...active.last, t: now };
      active.stroke.add(hold);
      active.last = hold;
      setLoad(active.stroke.load);
    }
  }, 50);
});

paperEl.addEventListener('pointermove', (e) => {
  moveRing(e);
  if (!active || e.pointerId !== active.pointerId) return;
  const events = e.getCoalescedEvents?.() ?? [e];
  for (const ev of events.length ? events : [e]) {
    const pt = toPoint(ev);
    if (pt.t <= active.last.t) pt.t = active.last.t + 0.5;
    active.stroke.add(pt);
    active.last = pt;
  }
  active.lastEvent = performance.now();
  setLoad(active.stroke.load);
});

function endStroke(e: PointerEvent) {
  if (!active || e.pointerId !== active.pointerId) return;
  window.clearInterval(holdTimer);
  const { stroke } = active;
  active = null;
  const end = stroke.finish();
  commitStroke(scratch, stroke, { ink: ctx.ink, halo: ctx.halo });
  ctx.live.clearRect(0, 0, SIZE, SIZE);
  revealHalo();

  const sheet = currentSheet();
  sheet.strokes.push(stroke.rec);
  sheet.history.push({ kind: 'stroke', loadBefore: stroke.rec.loadStart });
  sheet.cells = settings.cells;
  sheet.chars = sheetChars();
  sheet.version++;
  setLoad(end);
  renderSheetChrome();
}

paperEl.addEventListener('pointerup', endStroke);
paperEl.addEventListener('pointercancel', endStroke);

// ── Actions ──────────────────────────────────────────────────────────────────

function undo() {
  if (active) return;
  const sheet = currentSheet();
  const action = sheet.history.pop();
  if (!action) return;
  if (action.kind === 'stroke') {
    sheet.strokes.pop();
    setLoad(action.loadBefore);
  } else {
    sheet.strokes = action.removed;
  }
  sheet.version++;
  replayInk();
  renderSheetChrome();
}

function clearSheet() {
  if (active) return;
  const sheet = currentSheet();
  if (!sheet.strokes.length) return;
  sheet.history.push({ kind: 'clear', removed: sheet.strokes });
  sheet.strokes = [];
  sheet.version++;
  replayInk();
  renderSheetChrome();
  status.textContent = 'Sheet cleared. Undo brings it back.';
}

function goToPage(delta: number) {
  if (active) return;
  const next = pageByMode[settings.mode] + delta;
  if (next < 0 || next >= pageCount()) return;
  pageByMode[settings.mode] = next;
  void renderGuides();
  replayInk();
  renderSheetChrome();
}

$('undo').addEventListener('click', undo);
$('clear').addEventListener('click', clearSheet);
$('dip').addEventListener('click', dip);
$('prev-sheet').addEventListener('click', () => goToPage(-1));
$('next-sheet').addEventListener('click', () => goToPage(1));

document.addEventListener('keydown', (e) => {
  if (settings.view !== 'write') return;
  const target = e.target as HTMLElement;
  const typing = target.closest('textarea, input[type="text"], select');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    undo();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  const onControl = target.closest('input, button, select');
  if (e.key === 'd' || e.key === 'D') dip();
  if (!onControl && e.key === 'ArrowRight') goToPage(1);
  if (!onControl && e.key === 'ArrowLeft') goToPage(-1);
});

// ── Controls ─────────────────────────────────────────────────────────────────

const form = $<HTMLFormElement>('controls');
const setBlock = $('set-block');
const setText = $<HTMLTextAreaElement>('set-text');
const sizeInput = $<HTMLInputElement>('size');
const sizeOut = $('size-out');
const autoDip = $<HTMLInputElement>('auto-dip');
const guideGroup = $<HTMLFieldSetElement>('guide-group');
const presetSelect = $<HTMLSelectElement>('set-preset');

for (const p of PRESETS) {
  const o = document.createElement('option');
  o.value = p.id;
  o.textContent = p.label;
  presetSelect.append(o);
}

function syncControls() {
  for (const name of ['mode', 'grid', 'cells', 'guide', 'brush', 'tone', 'ink', 'gridColor', 'paper'] as const) {
    const value = String(settings[name]);
    const input = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
    if (input) input.checked = true;
  }
  setText.value = settings.setText;
  sizeInput.value = String(settings.size);
  sizeOut.textContent = String(settings.size);
  autoDip.checked = settings.autoDip;
  setBlock.hidden = settings.mode !== 'set';
  guideGroup.disabled = settings.mode === 'free';
  $('hint-mode').textContent = HINTS.mode[settings.mode];
  $('hint-grid').textContent = HINTS.grid[settings.grid];
  $('hint-brush').textContent = HINTS.brush[settings.brush];
  $('hint-tone').textContent = `${HINTS.tone[settings.tone]}${settings.ink === 'zhu' ? ', vermilion' : ''}`;
  $('hint-paper').textContent = HINTS.paper[settings.paper];
}

form.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.type !== 'radio') return;
  const name = input.name as keyof Settings;
  const prev = { ...settings };
  (settings as unknown as Record<string, unknown>)[name] = name === 'cells' ? Number(input.value) : input.value;
  saveSettings();
  syncControls();

  if (name === 'paper') renderPaper();
  if (name === 'grid' || name === 'cells' || name === 'gridColor') renderGrid();
  if (name === 'cells' && settings.mode === 'set') {
    // Keep roughly the same place in the set when rows per sheet change.
    pageByMode.set = Math.min(Math.floor((pageByMode.set * prev.cells) / settings.cells), pageCount() - 1);
  }
  if (['mode', 'cells', 'guide', 'gridColor'].includes(name)) void renderGuides();
  if (name === 'mode' || name === 'cells') replayInk();
  if (name === 'ink' || name === 'tone') {
    $('hint-tone').textContent = `${HINTS.tone[settings.tone]}${settings.ink === 'zhu' ? ', vermilion' : ''}`;
  }
  updateRing();
  renderSheetChrome();
});

sizeInput.addEventListener('input', () => {
  settings.size = Number(sizeInput.value);
  sizeOut.textContent = sizeInput.value;
  updateRing();
  saveSettings();
});

autoDip.addEventListener('change', () => {
  settings.autoDip = autoDip.checked;
  saveSettings();
  setLoad(settings.autoDip ? 1 : load);
});

function applySetText(text: string) {
  settings.setText = text;
  saveSettings();
  pageByMode.set = Math.min(pageByMode.set, pageCount() - 1);
  void renderGuides();
  replayInk();
  renderSheetChrome();
}

let textTimer = 0;
setText.addEventListener('input', () => {
  window.clearTimeout(textTimer);
  textTimer = window.setTimeout(() => applySetText(setText.value), 250);
});

presetSelect.addEventListener('change', () => {
  const preset = PRESETS.find((p) => p.id === presetSelect.value);
  presetSelect.value = '';
  if (!preset) return;
  setText.value = preset.text;
  pageByMode.set = 0;
  applySetText(preset.text);
});

$<HTMLInputElement>('set-file').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 1_000_000) {
    status.textContent = 'That file is over 1 MB. Upload a plain text file of characters.';
    return;
  }
  const text = await file.text();
  const chars = hanSequence(text);
  if (!chars.length) {
    status.textContent = `No Chinese characters found in ${file.name}.`;
    return;
  }
  const trimmed = chars.slice(0, 4000).join('');
  setText.value = trimmed;
  pageByMode.set = 0;
  applySetText(trimmed);
  status.textContent = `Loaded ${chars.length} characters from ${file.name}.`;
});

// ── Export ───────────────────────────────────────────────────────────────────

const exportPop = $('export-pop');
const exportBtn = $('export-btn');
const exportNote = $('export-note');

exportPop.addEventListener('toggle', (e) => {
  if ((e as ToggleEvent).newState !== 'open') return;
  exportNote.textContent = '';
  const r = exportBtn.getBoundingClientRect();
  const w = exportPop.offsetWidth;
  const h = exportPop.offsetHeight;
  const left = Math.min(window.innerWidth - w - 12, Math.max(12, r.right - w));
  const top = r.top - h - 8 > 12 ? r.top - h - 8 : r.bottom + 8;
  exportPop.style.left = `${left}px`;
  exportPop.style.top = `${top}px`;
});

function exportValue(name: string) {
  return exportPop.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)!.value;
}

function sheetCanvas(out: number, withPaper: boolean, withGrid: boolean, withGuide: boolean, format: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = out;
  const c = canvas.getContext('2d')!;
  c.imageSmoothingQuality = 'high';
  if (withPaper) c.drawImage(layers.paper, 0, 0, out, out);
  else if (format === 'jpeg') {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, out, out);
  }
  if (withGrid) c.drawImage(layers.grid, 0, 0, out, out);
  if (withGuide) c.drawImage(layers.guide, 0, 0, out, out);
  c.globalCompositeOperation = withPaper || withGrid || withGuide || format === 'jpeg' ? 'multiply' : 'source-over';
  c.drawImage(layers.ink, 0, 0, out, out);
  return canvas;
}

$('download').addEventListener('click', () => {
  flushHalo();
  const format = exportValue('format') as 'png' | 'jpeg' | 'webp';
  let out = Number(exportValue('exportSize'));
  const withPaper = $<HTMLInputElement>('ex-paper').checked;
  const withGrid = $<HTMLInputElement>('ex-grid').checked;
  const withGuide = $<HTMLInputElement>('ex-guide').checked;

  let canvas: HTMLCanvasElement | null;
  let baseName: string;
  if (settings.view === 'arrange') {
    canvas = arrange.exportCanvas(out, { paper: withPaper, grid: withGrid, opaque: format === 'jpeg' });
    const labels = arrange.visible().map((p) => p.label).join('');
    baseName = `calligraphy-${labels.slice(0, 16) || 'arrangement'}`;
    if (!canvas) {
      exportNote.textContent = 'There is nothing to export yet. Write a few characters first.';
      return;
    }
  } else {
    if (out > SIZE) out = SIZE;
    canvas = sheetCanvas(out, withPaper, withGrid, withGuide, format);
    const chars = sheetChars().join('');
    baseName = `calligraphy-${chars || `sheet-${pageByMode[settings.mode] + 1}`}`;
  }

  const mime = `image/${format}`;
  canvas!.toBlob(
    (blob) => {
      if (!blob) {
        exportNote.textContent = 'The image could not be created. Try PNG.';
        return;
      }
      const actual = blob.type.split('/')[1] ?? 'png';
      const ext = actual === 'jpeg' ? 'jpg' : actual;
      const name = `${baseName}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      if (actual !== format) {
        exportNote.textContent = `This browser can't save ${format.toUpperCase()}, so it was saved as ${ext.toUpperCase()}.`;
      } else {
        exportPop.hidePopover();
        status.textContent = `Saved ${name}.`;
      }
    },
    mime,
    format === 'png' ? undefined : 0.92,
  );
});

// ── Arrange ──────────────────────────────────────────────────────────────────

const MODE_ORDER: Mode[] = ['set', 'random', 'free'];
const pieceCache = new Map<string, { version: number; pieces: Piece[] }>();
const PIECE_SIZE = 640;

/** Cut every written sheet into cells; each cell with ink becomes a piece, in writing order. */
function collectPieces(): Piece[] {
  flushHalo();
  const keys = [...sheets.keys()]
    .filter((k) => sheets.get(k)!.strokes.length)
    .sort((a, b) => {
      const [ma, pa] = a.split(':');
      const [mb, pb] = b.split(':');
      return MODE_ORDER.indexOf(ma as Mode) - MODE_ORDER.indexOf(mb as Mode) || Number(pa) - Number(pb);
    });
  const full = document.createElement('canvas');
  full.width = full.height = SIZE;
  const fctx = full.getContext('2d')!;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 256;
  const pctx = probe.getContext('2d', { willReadFrequently: true })!;
  const out: Piece[] = [];
  for (const key of keys) {
    const sheet = sheets.get(key)!;
    const cached = pieceCache.get(key);
    if (cached && cached.version === sheet.version) {
      out.push(...cached.pieces);
      continue;
    }
    fctx.clearRect(0, 0, SIZE, SIZE);
    for (const rec of sheet.strokes) replayStroke(scratch, rec, { ink: fctx });
    pctx.clearRect(0, 0, 256, 256);
    pctx.drawImage(full, 0, 0, 256, 256);
    const alpha = pctx.getImageData(0, 0, 256, 256).data;
    const k = 256 / SIZE;
    const pieces: Piece[] = [];
    sheetCells(SIZE, sheet.cells).forEach((cell, i) => {
      // Is there real ink in this cell (not just a stray hair from a neighbour)?
      let inked = 0;
      const x0 = Math.floor(cell.x * k);
      const y0 = Math.floor(cell.y * k);
      const span = Math.floor(cell.size * k);
      for (let y = y0; y < y0 + span; y++) {
        for (let x = x0; x < x0 + span; x++) if (alpha[(y * 256 + x) * 4 + 3] > 60) inked++;
      }
      if (inked < span * span * 0.004) return;
      const image = document.createElement('canvas');
      image.width = image.height = PIECE_SIZE;
      image.getContext('2d')!.drawImage(full, cell.x, cell.y, cell.size, cell.size, 0, 0, PIECE_SIZE, PIECE_SIZE);
      pieces.push({ id: `${key}#${i}`, label: sheet.chars[cell.row] ?? '', image });
    });
    pieceCache.set(key, { version: sheet.version, pieces });
    out.push(...pieces);
  }
  return out;
}

const appEl = $('app');
const arrangeFrame = $('arrange');
const arrangeForm = $<HTMLFormElement>('arrange-controls');
const arrangeEmpty = $('arrange-empty');
const perLine = $<HTMLInputElement>('per-line');
const gapInput = $<HTMLInputElement>('gap');
const arrangeGrid = $<HTMLInputElement>('arrange-grid');

const arrange = createArrange(
  $<HTMLCanvasElement>('arrange-canvas'),
  arrangeFrame,
  { direction: settings.direction, perLine: settings.perLine, gap: settings.gap / 100, showGrid: settings.arrangeGrid },
  () => ({ paper: settings.paper, grid: settings.grid, gridColor: settings.gridColor }),
  (text) => {
    $('arrange-summary').textContent = text;
    const sel = arrange?.selected();
    $('selected-out').textContent = sel ? sel.label || 'Character' : 'None';
    for (const id of ['move-earlier', 'move-later', 'hide-piece']) ($(id) as HTMLButtonElement).disabled = !sel;
    const hiddenN = arrange?.hiddenCount() ?? 0;
    const restore = $<HTMLButtonElement>('restore-hidden');
    restore.hidden = hiddenN === 0;
    restore.textContent = `Show hidden (${hiddenN})`;
    arrangeEmpty.hidden = (arrange?.visible().length ?? 0) > 0;
  },
);

function syncArrangeControls() {
  const vertical = settings.direction === 'vertical';
  for (const input of arrangeForm.querySelectorAll<HTMLInputElement>('input[name="direction"]')) {
    input.checked = input.value === settings.direction;
  }
  $('hint-direction').textContent = vertical ? 'Columns, right to left' : 'Rows, left to right';
  $('per-line-label').textContent = vertical ? 'Per column' : 'Per row';
  perLine.value = String(settings.perLine);
  $('per-line-out').textContent = String(settings.perLine);
  gapInput.value = String(settings.gap);
  $('gap-out').textContent = `${settings.gap}%`;
  arrangeGrid.checked = settings.arrangeGrid;
}

function setView(view: View) {
  settings.view = view;
  saveSettings();
  appEl.dataset.view = view;
  document.documentElement.dataset.view = view;
  const radio = document.querySelector<HTMLInputElement>(`input[name="view"][value="${view}"]`);
  if (radio) radio.checked = true;
  const arranging = view === 'arrange';
  paperEl.hidden = arranging;
  arrangeFrame.hidden = !arranging;
  form.hidden = arranging;
  arrangeForm.hidden = !arranging;
  if (arranging) {
    arrange.open(collectPieces());
  } else {
    arrange.close();
    updateRing();
  }
}

document.querySelectorAll<HTMLInputElement>('input[name="view"]').forEach((r) =>
  r.addEventListener('change', () => setView(r.value as View)),
);

arrangeForm.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.name === 'direction') {
    settings.direction = input.value as Direction;
    arrange.setOptions({ direction: settings.direction });
  }
  if (input === arrangeGrid) {
    settings.arrangeGrid = arrangeGrid.checked;
    arrange.setOptions({ showGrid: settings.arrangeGrid });
  }
  saveSettings();
  syncArrangeControls();
});
perLine.addEventListener('input', () => {
  settings.perLine = Number(perLine.value);
  $('per-line-out').textContent = perLine.value;
  arrange.setOptions({ perLine: settings.perLine });
  saveSettings();
});
gapInput.addEventListener('input', () => {
  settings.gap = Number(gapInput.value);
  $('gap-out').textContent = `${settings.gap}%`;
  arrange.setOptions({ gap: settings.gap / 100 });
  saveSettings();
});
$('move-earlier').addEventListener('click', () => arrange.moveSelected(-1));
$('move-later').addEventListener('click', () => arrange.moveSelected(1));
$('hide-piece').addEventListener('click', () => arrange.hideSelected());
$('restore-hidden').addEventListener('click', () => arrange.restoreHidden());

// ── Start ────────────────────────────────────────────────────────────────────

syncControls();
syncArrangeControls();
setLoad(1);
renderAll();
updateRing();
setView(settings.view === 'arrange' ? 'arrange' : 'write');
new ResizeObserver(updateRing).observe(paperEl);
document.fonts.ready.then(() => void renderGuides());

// Expose for quick tinkering in the console.
Object.assign(window, { __calligraphy: { settings, sheets, INK_COLORS } });
