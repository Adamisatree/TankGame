/**
 * Draws the app icon (build/icon.png) with the same pencil style as the game,
 * so the installers get a real icon instead of the default Electron one.
 *
 *   npx tsx scripts/make-icon.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const SIZE = 1024;
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');

const PAPER = '#f3ead9';
const INK = '#26221d';
const TEAL = '#3f9c8f';
const RUST = '#d4552e';

ctx.fillStyle = PAPER;
ctx.fillRect(0, 0, SIZE, SIZE);

// faint paper grain
for (let i = 0; i < 5000; i++) {
  ctx.fillStyle = `rgba(38,34,29,${Math.random() * 0.05})`;
  ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 2, 2);
}

/** Double-stroke so lines look pencilled rather than vector-perfect. */
function sketch(draw: (jitter: number) => void, passes = 2, colour = INK) {
  for (let p = 0; p < passes; p++) {
    ctx.strokeStyle = colour;
    ctx.globalAlpha = p === 0 ? 1 : 0.45;
    ctx.lineWidth = p === 0 ? 14 : 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    draw((Math.random() - 0.5) * 7);
  }
  ctx.globalAlpha = 1;
}

// rounded "card" edge
sketch((j) => {
  ctx.beginPath();
  ctx.roundRect(90 + j, 90 + j, 844, 844, 90);
  ctx.stroke();
});

// tank body
sketch((j) => {
  ctx.beginPath();
  ctx.roundRect(250 + j, 560 + j, 430, 170, 34);
  ctx.stroke();
});

// treads
for (let i = 0; i < 6; i++) {
  sketch((j) => {
    ctx.beginPath();
    ctx.moveTo(268 + i * 66 + j, 700);
    ctx.lineTo(300 + i * 66 + j, 748);
    ctx.stroke();
  }, 1);
}

// turret + barrel
sketch((j) => {
  ctx.beginPath();
  ctx.arc(465 + j, 560 + j, 92, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(465 + j, 468 + j);
  ctx.lineTo(700 + j, 330 + j);
  ctx.lineWidth = 26;
  ctx.stroke();
});

// ricochet path: bounces off the wall and comes back
ctx.setLineDash([26, 22]);
sketch((j) => {
  ctx.strokeStyle = TEAL;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(712, 322);
  ctx.lineTo(860, 250 + j);
  ctx.lineTo(742, 148 + j);
  ctx.stroke();
}, 1);

// the shell, and the little "hit" it left behind
ctx.setLineDash([]);
ctx.fillStyle = TEAL;
ctx.beginPath();
ctx.arc(742, 148, 22, 0, Math.PI * 2);
ctx.fill();

ctx.strokeStyle = RUST;
ctx.lineWidth = 10;
for (const angle of [-0.6, 0, 0.6, 1.4, 2.4, 3.4]) {
  ctx.beginPath();
  ctx.moveTo(470 + Math.cos(angle) * 132, 560 + Math.sin(angle) * 132);
  ctx.lineTo(470 + Math.cos(angle) * 158, 560 + Math.sin(angle) * 158);
  ctx.stroke();
}

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', canvas.toBuffer('image/png'));
console.log('build/icon.png written (1024x1024)');
