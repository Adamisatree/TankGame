/**
 * In-app map editor.
 *
 * A grid canvas plus a small, tidy toolbar: paint walls and crates, drop
 * pickups and spawn points, mirror the result, then save it straight into the
 * local library (or export a `.tankmap.json`).
 *
 * The editor works on the same normalised 0..1 geometry as the built-in maps,
 * so what you draw is exactly what `buildLayout` renders on every map size.
 */

import {
  MAP_GRID,
  MAP_SIZES,
  MIRROR_LABELS,
  applyMirror,
  mapHasErrors,
  normalizeMapFile,
  validateMap,
  type MapBox,
  type MapFile,
  type MapPoint,
  type MapSpawn,
  type MirrorMode,
} from '../maps/format';

export type EditorTool = 'wall' | 'crate' | 'pickup' | 'spawn' | 'erase';

export interface EditorHandlers {
  /** Save into the library. Null means storage refused it. */
  onSave: (map: MapFile) => MapFile | null;
  /** Store a copy under a new id and return it, so the editor can adopt it. */
  onSaveCopy: (map: MapFile) => MapFile | null;
  onDelete: (map: MapFile) => void;
  onPlay: (map: MapFile) => void;
  onExport: (map: MapFile) => void;
  onClose: () => void;
  /** Called whenever the working copy changes, so the host can repaint chrome. */
  onChange?: (map: MapFile) => void;
}

const TOOLS: { id: EditorTool; label: string; hint: string }[] = [
  { id: 'wall', label: '墙', hint: '拖动画墙（挡住子弹并反弹）' },
  { id: 'crate', label: '木箱', hint: '可以被打碎，也能挡坦克' },
  { id: 'pickup', label: '道具', hint: '点一下放一个道具点' },
  { id: 'spawn', label: '出生点', hint: '一局最少 2 个，最多 10 个' },
  { id: 'erase', label: '橡皮', hint: '擦掉这一格里的东西' },
];

const ANGLES: { label: string; angle: number }[] = [
  { label: '↑', angle: -Math.PI / 2 },
  { label: '→', angle: 0 },
  { label: '↓', angle: Math.PI / 2 },
  { label: '←', angle: Math.PI },
];

interface Snapshot {
  walls: MapBox[];
  crates: MapBox[];
  pickups: MapPoint[];
  spawns: MapSpawn[];
  size: { w: number; h: number };
  mirror: MirrorMode;
}

/** Box identity, so the mirror ghost can tell copies from authored pieces. */
const boxKey = (box: MapBox): string => `${box.x}|${box.y}|${box.w}|${box.h}`;

const cellW = 1 / MAP_GRID.cols;
const cellH = 1 / MAP_GRID.rows;
const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Grid cells → merged boxes (one box per constant row-run). */
function cellsToBoxes(cells: Set<string>): MapBox[] {
  const byRow = new Map<number, number[]>();
  for (const key of cells) {
    const [col, row] = key.split(':').map(Number);
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row)!.push(col);
  }
  const boxes: MapBox[] = [];
  for (const [row, cols] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    cols.sort((a, b) => a - b);
    let start = cols[0];
    let previous = cols[0];
    const flush = (): void => {
      boxes.push({
        x: round(start * cellW),
        y: round(row * cellH),
        w: round((previous - start + 1) * cellW),
        h: round(cellH),
      });
    };
    for (let i = 1; i < cols.length; i += 1) {
      if (cols[i] === previous + 1) {
        previous = cols[i];
        continue;
      }
      flush();
      start = cols[i];
      previous = cols[i];
    }
    flush();
  }
  return boxes;
}

export class MapEditor {
  private map: MapFile;
  private tool: EditorTool = 'wall';
  private angle = ANGLES[2].angle;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private stroke = new Set<string>();
  private painting = false;
  private showGrid = true;

  constructor(
    private root: HTMLElement,
    map: MapFile,
    private handlers: EditorHandlers
  ) {
    this.map = normalizeMapFile({ ...map });
    root.innerHTML = this.html();
    this.canvas = root.querySelector<HTMLCanvasElement>('#map-canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.bind();
    this.resize();
    this.draw();
    this.refreshSide();
  }

  // ---------------------------------------------------------------- markup

  private html(): string {
    const tools = TOOLS.map(
      (tool) =>
        `<button type="button" class="tool-chip ${this.tool === tool.id ? 'on' : ''}" data-tool="${tool.id}" title="${tool.hint}">
           ${tool.label}
         </button>`
    ).join('');
    const sizes = MAP_SIZES.map(
      (size) =>
        `<option value="${size.id}" ${size.w === this.map.size.w && size.h === this.map.size.h ? 'selected' : ''}>
           ${size.label}
         </option>`
    ).join('');
    const mirrors = (Object.keys(MIRROR_LABELS) as MirrorMode[])
      .map(
        (mode) =>
          `<button type="button" class="chip ${this.map.mirror === mode ? 'on' : ''}" data-mirror="${mode}">
             ${MIRROR_LABELS[mode]}
           </button>`
      )
      .join('');
    const angles = ANGLES.map(
      (entry) =>
        `<button type="button" class="chip tiny ${this.angle === entry.angle ? 'on' : ''}" data-angle="${entry.angle}" data-face="1">
           ${entry.label}
         </button>`
    ).join('');

    return `
      <div class="editor">
        <div class="editor-head">
          <input id="map-name" class="editor-name" value="${this.escape(this.map.name)}" maxlength="24" aria-label="地图名字" />
          <span class="editor-id" id="map-id">${this.map.id} · rev ${this.map.rev}</span>
          <button type="button" class="chip ghost" id="editor-close">返回菜单</button>
        </div>

        <div class="editor-toolbar">
          <div class="tool-group">${tools}</div>
          <div class="tool-group">
            <button type="button" class="chip tiny" id="editor-undo">撤销</button>
            <button type="button" class="chip tiny" id="editor-redo">重做</button>
            <button type="button" class="chip tiny" id="editor-grid">网格</button>
            <button type="button" class="chip tiny ghost" id="editor-clear">清空</button>
          </div>
          <div class="tool-group">
            <span class="tool-label">朝向</span>
            ${angles}
          </div>
        </div>

        <div class="editor-body">
          <div class="editor-canvas-wrap">
            <canvas id="map-canvas" width="720" height="432"></canvas>
            <p class="editor-hint" id="editor-hint">${TOOLS[0].hint}</p>
          </div>
          <aside class="editor-side">
            <div class="side-block">
              <div class="side-title">尺寸</div>
              <select id="map-size" class="editor-select">${sizes}</select>
            </div>
            <div class="side-block">
              <div class="side-title">镜像（让两边地形对称）</div>
              <div class="chip-row">${mirrors}</div>
            </div>
            <div class="side-block">
              <div class="side-title">统计</div>
              <ul class="side-stats" id="map-stats"></ul>
            </div>
            <div class="side-block">
              <div class="side-title">检查</div>
              <ul class="side-issues" id="map-issues"></ul>
            </div>
          </aside>
        </div>

        <div class="editor-actions">
          <button class="primary" id="editor-save">保存</button>
          <button id="editor-play">保存并试玩</button>
          <button id="editor-copy">另存副本</button>
          <button id="editor-export">导出 .tankmap.json</button>
          <button class="ghost" id="editor-delete">删除</button>
          <button class="ghost" id="editor-import">导入地图</button>
          <span class="editor-status" id="editor-status"></span>
        </div>
      </div>`;
  }

  private escape(text: string): string {
    return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
  }

  // ---------------------------------------------------------------- binding

  private bind(): void {
    const root = this.root;

    root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.tool = btn.dataset.tool as EditorTool;
        root.querySelectorAll('[data-tool]').forEach((el) => el.classList.toggle('on', el === btn));
        const hint = TOOLS.find((tool) => tool.id === this.tool)?.hint ?? '';
        const label = root.querySelector<HTMLElement>('#editor-hint');
        if (label) label.textContent = hint;
      });
    });

    root.querySelectorAll<HTMLButtonElement>('[data-angle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.angle = Number(btn.dataset.angle);
        root.querySelectorAll('[data-angle]').forEach((el) => el.classList.toggle('on', el === btn));
      });
    });

    root.querySelector<HTMLInputElement>('#map-name')?.addEventListener('input', (event) => {
      this.map.name = (event.target as HTMLInputElement).value.slice(0, 24) || '未命名地图';
      this.touch();
    });

    root.querySelector<HTMLSelectElement>('#map-size')?.addEventListener('change', (event) => {
      const size = MAP_SIZES.find((entry) => entry.id === (event.target as HTMLSelectElement).value);
      if (!size) return;
      this.snapshot();
      this.map.size = { w: size.w, h: size.h };
      this.resize();
      this.draw();
      this.touch();
    });

    root.querySelectorAll<HTMLButtonElement>('[data-mirror]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.map.mirror = btn.dataset.mirror as MirrorMode;
        root.querySelectorAll('[data-mirror]').forEach((el) => el.classList.toggle('on', el === btn));
        this.draw();
        this.touch();
      });
    });

    root.querySelector<HTMLButtonElement>('#editor-undo')?.addEventListener('click', () => this.undo());
    root.querySelector<HTMLButtonElement>('#editor-redo')?.addEventListener('click', () => this.redo());
    root.querySelector<HTMLButtonElement>('#editor-grid')?.addEventListener('click', () => {
      this.showGrid = !this.showGrid;
      this.draw();
    });
    root.querySelector<HTMLButtonElement>('#editor-clear')?.addEventListener('click', () => {
      this.snapshot();
      this.map.walls = [];
      this.map.crates = [];
      this.map.pickups = [];
      this.draw();
      this.touch();
    });

    // Painting.
    const toCell = (event: PointerEvent): { col: number; row: number } => {
      const rect = this.canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width;
      const y = (event.clientY - rect.top) / rect.height;
      return {
        col: Math.max(0, Math.min(MAP_GRID.cols - 1, Math.floor(x * MAP_GRID.cols))),
        row: Math.max(0, Math.min(MAP_GRID.rows - 1, Math.floor(y * MAP_GRID.rows))),
      };
    };

    this.canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      // Capture keeps the stroke alive outside the canvas; not every host
      // (jsdom, some embedded webviews) implements it.
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        /* no capture available — dragging still works inside the canvas */
      }
      this.painting = true;
      this.stroke.clear();
      this.snapshot();
      const cell = toCell(event);
      this.applyAt(cell.col, cell.row, true);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (!this.painting) return;
      const cell = toCell(event);
      this.applyAt(cell.col, cell.row, false);
    });
    const finish = (): void => {
      if (!this.painting) return;
      this.painting = false;
      // Merge the painted cells into tidy rectangles.
      if (this.tool === 'wall' || this.tool === 'crate') {
        const boxes = cellsToBoxes(this.stroke);
        if (this.tool === 'wall') this.map.walls = this.map.walls.concat(boxes);
        else this.map.crates = this.map.crates.concat(boxes);
      }
      this.stroke.clear();
      this.draw();
      this.touch();
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);
    this.canvas.addEventListener('pointerleave', () => {
      if (this.painting) finish();
    });

    root.querySelector<HTMLButtonElement>('#editor-close')?.addEventListener('click', () => this.handlers.onClose());
    root.querySelector<HTMLButtonElement>('#editor-save')?.addEventListener('click', () => this.save(false));
    root.querySelector<HTMLButtonElement>('#editor-play')?.addEventListener('click', () => this.save(true));
    root.querySelector<HTMLButtonElement>('#editor-copy')?.addEventListener('click', () => {
      if (!this.commit()) return;
      const copy = this.handlers.onSaveCopy(this.map);
      if (!copy) {
        this.status('另存失败：本机存储已满或被禁用', true);
        return;
      }
      this.map = copy;
      this.syncControls();
      this.status('已另存为副本');
    });
    root.querySelector<HTMLButtonElement>('#editor-export')?.addEventListener('click', () => this.handlers.onExport(this.map));
    root.querySelector<HTMLButtonElement>('#editor-delete')?.addEventListener('click', () => this.handlers.onDelete(this.map));
    root.querySelector<HTMLButtonElement>('#editor-import')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        void file.text().then((text) => {
          try {
            const parsed = JSON.parse(text) as MapFile;
            this.snapshot();
            this.map = normalizeMapFile(parsed);
            this.root.innerHTML = this.html();
            this.canvas = this.root.querySelector<HTMLCanvasElement>('#map-canvas')!;
            this.ctx = this.canvas.getContext('2d')!;
            this.bind();
            this.resize();
            this.draw();
            this.touch();
            this.status('已导入，记得保存');
          } catch {
            this.status('这个文件读不出来', true);
          }
        });
      });
      input.click();
    });
  }

  // ---------------------------------------------------------------- painting

  private applyAt(col: number, row: number, first: boolean): void {
    const key = `${col}:${row}`;
    const x = round(col * cellW);
    const y = round(row * cellH);

    if (this.tool === 'wall' || this.tool === 'crate') {
      if (this.stroke.has(key)) return;
      this.stroke.add(key);
      // A live preview while dragging: draw the pending cells.
      this.drawPreview();
      return;
    }

    if (!first && this.tool !== 'erase') return; // one placement per click

    if (this.tool === 'erase') {
      const inBox = (box: MapBox): boolean => x < box.x + box.w && x + cellW > box.x && y < box.y + box.h && y + cellH > box.y;
      const before = this.map.walls.length + this.map.crates.length + this.map.pickups.length + this.map.spawns.length;
      this.map.walls = this.map.walls.filter((box) => !inBox(box));
      this.map.crates = this.map.crates.filter((box) => !inBox(box));
      this.map.pickups = this.map.pickups.filter((point) => !inBox({ x: point.x - 0.012, y: point.y - 0.012, w: 0.024, h: 0.024 }));
      this.map.spawns = this.map.spawns.filter((spawn) => !inBox({ x: spawn.x - 0.014, y: spawn.y - 0.014, w: 0.028, h: 0.028 }));
      const after = this.map.walls.length + this.map.crates.length + this.map.pickups.length + this.map.spawns.length;
      if (after === before) return;
      this.draw();
      this.touch();
      return;
    }

    if (this.tool === 'pickup') {
      this.map.pickups.push({ x: round(x + cellW / 2), y: round(y + cellH / 2) });
      this.draw();
      this.touch();
      return;
    }

    if (this.tool === 'spawn') {
      if (this.map.spawns.length >= 10) {
        this.status('出生点最多 10 个', true);
        return;
      }
      this.map.spawns.push({ x: round(x + cellW / 2), y: round(y + cellH / 2), angle: this.angle });
      this.draw();
      this.touch();
    }
  }

  private drawPreview(): void {
    this.draw();
    const ctx = this.ctx;
    const cellWpx = this.canvas.width / MAP_GRID.cols;
    const cellHpx = this.canvas.height / MAP_GRID.rows;
    ctx.fillStyle = this.tool === 'wall' ? 'rgba(38,34,29,0.55)' : 'rgba(184,135,63,0.55)';
    for (const key of this.stroke) {
      const [col, row] = key.split(':').map(Number);
      ctx.fillRect(col * cellWpx, row * cellHpx, cellWpx, cellHpx);
    }
  }

  // ---------------------------------------------------------------- history

  private grab(): Snapshot {
    return {
      walls: this.map.walls.map((box) => ({ ...box })),
      crates: this.map.crates.map((box) => ({ ...box })),
      pickups: this.map.pickups.map((point) => ({ ...point })),
      spawns: this.map.spawns.map((spawn) => ({ ...spawn })),
      size: { ...this.map.size },
      mirror: this.map.mirror,
    };
  }

  private snapshot(): void {
    this.undoStack.push(this.grab());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }

  private restore(snapshot: Snapshot): void {
    this.map.walls = snapshot.walls;
    this.map.crates = snapshot.crates;
    this.map.pickups = snapshot.pickups;
    this.map.spawns = snapshot.spawns;
    this.map.mirror = snapshot.mirror;
    if (this.map.size.w !== snapshot.size.w || this.map.size.h !== snapshot.size.h) {
      this.map.size = { ...snapshot.size };
      this.resize();
    }
    this.syncControls();
    this.draw();
    this.touch();
  }

  /** Keeps the size drop-down and mirror chips in step with the map. */
  private syncControls(): void {
    const size = this.root.querySelector<HTMLSelectElement>('#map-size');
    if (size) size.value = MAP_SIZES.find((entry) => entry.w === this.map.size.w && entry.h === this.map.size.h)?.id ?? size.value;
    this.root.querySelectorAll<HTMLButtonElement>('[data-mirror]').forEach((chip) => {
      chip.classList.toggle('on', chip.dataset.mirror === this.map.mirror);
    });
    const id = this.root.querySelector<HTMLElement>('#map-id');
    if (id) id.textContent = `${this.map.id} · rev ${this.map.rev}`;
    const name = this.root.querySelector<HTMLInputElement>('#map-name');
    if (name && name.value !== this.map.name) name.value = this.map.name;
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.grab());
    this.restore(previous);
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.grab());
    this.restore(next);
  }

  // ---------------------------------------------------------------- drawing

  private resize(): void {
    const aspect = this.map.size.h / this.map.size.w;
    const width = 720;
    const height = Math.max(320, Math.min(520, Math.round(width * aspect)));
    this.canvas.width = width;
    this.canvas.height = height;
  }

  private draw(): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    // Paper + grid.
    ctx.fillStyle = '#f3ead9';
    ctx.fillRect(0, 0, width, height);
    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(203,189,164,0.55)';
      ctx.lineWidth = 1;
      for (let col = 1; col < MAP_GRID.cols; col += 1) {
        const x = (col / MAP_GRID.cols) * width;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let row = 1; row < MAP_GRID.rows; row += 1) {
        const y = (row / MAP_GRID.rows) * height;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
    }

    // Frame (the game adds solid walls there).
    ctx.strokeStyle = '#26221d';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, width - 3, height - 3);

    const px = (value: number): number => value * width;
    const py = (value: number): number => value * height;

    // Walls.
    ctx.fillStyle = '#e3d6bf';
    ctx.strokeStyle = '#26221d';
    ctx.lineWidth = 1.6;
    for (const wall of this.map.walls) {
      ctx.fillRect(px(wall.x), py(wall.y), px(wall.w), py(wall.h));
      ctx.strokeRect(px(wall.x), py(wall.y), px(wall.w), py(wall.h));
    }

    // Crates.
    for (const crate of this.map.crates) {
      ctx.fillStyle = 'rgba(214,167,92,0.85)';
      ctx.fillRect(px(crate.x), py(crate.y), px(crate.w), py(crate.h));
      ctx.strokeStyle = '#b8873f';
      ctx.strokeRect(px(crate.x), py(crate.y), px(crate.w), py(crate.h));
      ctx.beginPath();
      ctx.moveTo(px(crate.x), py(crate.y));
      ctx.lineTo(px(crate.x + crate.w), py(crate.y + crate.h));
      ctx.moveTo(px(crate.x + crate.w), py(crate.y));
      ctx.lineTo(px(crate.x), py(crate.y + crate.h));
      ctx.stroke();
    }

    // Pickups.
    for (const pickup of this.map.pickups) {
      ctx.beginPath();
      ctx.arc(px(pickup.x), py(pickup.y), 7, 0, Math.PI * 2);
      ctx.fillStyle = '#faf5ea';
      ctx.fill();
      ctx.strokeStyle = '#3f9c8f';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Mirror ghost: exactly what the arena will look like at play time.
    if (this.map.mirror !== 'none') {
      const authored = new Set([...this.map.walls, ...this.map.crates].map(boxKey));
      const ghost = applyMirror(this.map);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.4;
      const ghostBoxes = (boxes: MapBox[], fill: string, stroke: string): void => {
        for (const box of boxes) {
          if (authored.has(boxKey(box))) continue;
          const x = px(box.x);
          const y = py(box.y);
          const w = px(box.w);
          const h = py(box.h);
          ctx.globalAlpha = 0.32;
          ctx.fillStyle = fill;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 0.7;
          ctx.strokeStyle = stroke;
          ctx.strokeRect(x, y, w, h);
        }
      };
      ghostBoxes(ghost.walls, '#e3d6bf', '#26221d');
      ghostBoxes(ghost.crates, 'rgba(214,167,92,0.9)', '#b8873f');
      ctx.globalAlpha = 0.55;
      const authoredPoints = new Set(this.map.pickups.map((point) => `${point.x}|${point.y}`));
      for (const point of ghost.pickups) {
        if (authoredPoints.has(`${point.x}|${point.y}`)) continue;
        ctx.beginPath();
        ctx.arc(px(point.x), py(point.y), 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#3f9c8f';
        ctx.stroke();
      }
      ctx.restore();
    }

    // Spawns: numbered, with a nose tick showing the facing.
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    this.map.spawns.forEach((spawn, index) => {
      const x = px(spawn.x);
      const y = py(spawn.y);
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.fillStyle = index === 0 ? 'rgba(63,156,143,0.9)' : 'rgba(111,90,168,0.85)';
      ctx.fill();
      ctx.strokeStyle = '#faf5ea';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#faf5ea';
      ctx.fillText(String(index + 1), x, y + 0.5);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(spawn.angle) * 13, y + Math.sin(spawn.angle) * 13);
      ctx.lineTo(x + Math.cos(spawn.angle) * 22, y + Math.sin(spawn.angle) * 22);
      ctx.strokeStyle = index === 0 ? 'rgba(63,156,143,0.9)' : 'rgba(111,90,168,0.85)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
    });
  }

  // ---------------------------------------------------------------- state

  /**
   * The map exactly as it will play: the mirror applied, nothing re-normalised.
   * Going through `normalizeMapFile` here would quietly top up missing spawns
   * and hide the very problems the checks are meant to report.
   */
  private effective(): MapFile {
    return applyMirror(this.map);
  }

  private touch(): void {
    this.map.updatedAt = new Date().toISOString();
    this.refreshSide();
    this.handlers.onChange?.(this.map);
  }

  private refreshSide(): void {
    const stats = this.root.querySelector<HTMLElement>('#map-stats');
    if (stats) {
      stats.innerHTML = `
        <li><span>墙</span><b>${this.map.walls.length}</b></li>
        <li><span>木箱</span><b>${this.map.crates.length}</b></li>
        <li><span>道具点</span><b>${this.map.pickups.length}</b></li>
        <li><span>出生点</span><b>${this.map.spawns.length}</b></li>
        <li><span>尺寸</span><b>${this.map.size.w}×${this.map.size.h}</b></li>`;
    }

    const issues = validateMap(this.effective());
    const list = this.root.querySelector<HTMLElement>('#map-issues');
    if (list) {
      if (!issues.length) {
        list.innerHTML = '<li class="issue-ok">没问题，可以保存</li>';
      } else {
        list.innerHTML = issues
          .map(
            (issue) =>
              `<li class="${issue.severity === 'error' ? 'issue-error' : 'issue-warn'}">${
                issue.severity === 'error' ? '✕' : '!'
              } ${issue.message}</li>`
          )
          .join('');
      }
    }
  }

  private status(text: string, bad = false): void {
    const el = this.root.querySelector<HTMLElement>('#editor-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('bad', bad);
  }

  private commit(): boolean {
    const issues = validateMap(this.effective());
    if (mapHasErrors(issues)) {
      const first = issues.find((issue) => issue.severity === 'error');
      this.status(first ? `还不能保存：${first.message}` : '还不能保存', true);
      return false;
    }
    return true;
  }

  private save(play: boolean): void {
    if (!this.commit()) return;
    const name = this.root.querySelector<HTMLInputElement>('#map-name')?.value ?? this.map.name;
    this.map = { ...this.map, name: name.trim().slice(0, 24) || '未命名地图' };
    const saved = this.handlers.onSave(this.map);
    if (!saved) {
      this.status('保存失败：本机存储已满或被禁用', true);
      return;
    }
    // Adopt the stored revision so 返回/再保存 don't look like another edit.
    this.map = saved;
    this.syncControls();
    this.status('已保存');
    if (play) this.handlers.onPlay(saved);
  }
}
