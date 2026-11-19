# Chinese Calligraphy Simulator

Brush-and-ink practice on a simulated practice sheet. Implements the Figma frame
`new-portfolio` → node 11:2.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build
```

## What it simulates

- **Brush (笔)**: a cone of bristles that lays down a teardrop footprint: a round belly with the tip (锋)
  trailing behind and toward the upper left, as a right hand holds it. The tip swings round slowly,
  which gives the angled heads and corners of regular script. Each bristle holds its own ink. Moving fast lifts the
  brush (thinner, drier); moving slowly presses it (wider, wetter). Pen pressure is used
  when the device reports it. Lifting while moving flicks out a tapered tip (出锋).
  - 狼毫 weasel: stiff, sharp, holds less ink
  - 兼毫 mixed: stiff core, soft outer hair
  - 羊毫 goat: soft, absorbent, wide swing between light and heavy press
- **Ink (墨分五色)**: 焦 scorched, 浓 dense, 重 heavy, 淡 light, 清 clear. More water means
  more bleed and longer reach; scorched ink breaks into 飞白 (flying white) quickly.
  墨 black or 朱 vermilion.
- **Paper (纸)**: wet strokes pick up a little of the paper's grain. 生宣 raw xuan bleeds along its fibres, 半熟 half-sized, 熟宣 sized and
  crisp, 毛边纸 yellow bamboo practice paper. Resting the brush lets ink pool (涨墨).
- **Ink load**: the brush runs dry as you write. Press **D** or **Dip** to reload, or turn
  on "Dip before every stroke".

## Sheets

- Grids: 田字格, 米字格, 九宫格, 回宫格, 方格; vermilion or grey lines; 1–16 cells.
- Guides: 描 trace (faint characters in every cell) or 临 copy (a model at the start
  of each row).
- Modes: 字帖 your own set (type, paste, upload a .txt, or pick a preset such as
  千字文), 随机 random, 自由 endless blank sheets. Each sheet keeps its strokes while you
  page back and forth.
- Export PNG, JPG or WebP at 1024 or 2048 px, with or without paper, grid and guides.
  PNG/WebP without paper are transparent.

## Arrange

Switch to **Arrange** to gather every cell you have written, across all sheets, into one piece:
竖排 vertical columns read right to left (the traditional layout) or 横排 horizontal rows, with
characters per line, spacing and an optional grid. Drag a character to move it, or select it and
use Earlier / Later / Hide (keyboard: arrows select, Shift+arrow moves, Delete hides). Export saves
the whole arrangement as one PNG, JPG or WebP, up to 4096 px on the long edge.

## Devices

Works with mouse, touch and pen (Apple Pencil and tablets use real pressure). On phones and portrait
tablets the sheet sits on top with undo, clear, dip and export right under it.

Keys: ⌘Z undo, D dip, ← → sheets.

## Fonts

UI type is Neue Haas Grotesk Display Pro, loaded from the locally installed font
(it is licensed, so it is not bundled). Safari only exposes system fonts to pages and
falls back to Helvetica Neue. Model characters use LXGW WenKai (OFL) from npm.
