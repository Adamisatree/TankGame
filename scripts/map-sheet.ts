/**
 * Draws every authored map to one contact sheet PNG so layouts can be eyeballed
 * (and reviewed in a PR) without launching the game.
 *
 *   npx tsx scripts/map-sheet.ts [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { LEVELS, validateLevels } from '../src/engine/level';

const outDir = process.argv[2] ?? '/tmp/tank-maps';
mkdirSync(outDir, { recursive: true });

const CELL_W = 320;
const CELL_H = 230;
const PAD = 16;
const LABEL = 30;
const cols = 4;
const rows = Math.ceil(LEVELS.length / cols);

const canvas = createCanvas(cols * CELL_W + PAD, rows * (CELL_H + LABEL) + PAD);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#f3ead9';
ctx.fillRect(0, 0, canvas.width, canvas.height);

const issues = validateLevels();

LEVELS.forEach((level, i) => {
  const cx = PAD / 2 + (i % cols) * CELL_W;
  const cy = PAD / 2 + Math.floor(i / cols) * (CELL_H + LABEL);
  const w = CELL_W - PAD;
  const h = CELL_H - PAD;

  // paper
  ctx.fillStyle = '#fbf5e9';
  ctx.fillRect(cx + 4, cy + 4, w, h);

  const px = (v: number): number => cx + 4 + v * w;
  const py = (v: number): number => cy + 4 + v * h;

  for (const b of level.walls) {
    ctx.fillStyle = '#d8c9ae';
    ctx.fillRect(px(b.x), py(b.y), b.w * w, b.h * h);
    ctx.strokeStyle = '#26221d';
    ctx.lineWidth = 1;
    ctx.strokeRect(px(b.x), py(b.y), b.w * w, b.h * h);
  }
  for (const b of level.crates) {
    ctx.fillStyle = '#d6a75c';
    ctx.fillRect(px(b.x), py(b.y), b.w * w, b.h * h);
    ctx.strokeStyle = '#26221d';
    ctx.strokeRect(px(b.x), py(b.y), b.w * w, b.h * h);
  }
  for (const p of level.pickups) {
    ctx.beginPath();
    ctx.arc(px(p.x), py(p.y), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#3f9c8f';
    ctx.fill();
  }
  for (const [spawn, colour] of [
    [level.player, '#3f9c8f'],
    [level.enemy, '#6f5aa8'],
  ] as const) {
    ctx.beginPath();
    ctx.arc(px(spawn.x), py(spawn.y), 7, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.strokeStyle = '#26221d';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // barrel direction
    ctx.beginPath();
    ctx.moveTo(px(spawn.x), py(spawn.y));
    ctx.lineTo(px(spawn.x) + Math.cos(spawn.angle) * 16, py(spawn.y) + Math.sin(spawn.angle) * 16);
    ctx.stroke();
  }

  ctx.fillStyle = '#26221d';
  ctx.font = '16px sans-serif';
  ctx.fillText(level.name, cx + 6, cy + h + 22);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#7a6f5f';
  ctx.fillText(level.blurb.slice(0, 30), cx + 6, cy + h + 38 > canvas.height ? cy + h + 16 : cy + h + 36);
});

const file = `${outDir}/maps.png`;
writeFileSync(file, canvas.toBuffer('image/png'));
console.log(`wrote ${file}`);
console.log(issues.length ? `validation issues: ${JSON.stringify(issues)}` : 'all maps valid');
