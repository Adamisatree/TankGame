import Phaser from 'phaser';
import { COLORS, GAME_H, GAME_W } from './config';

/**
 * Generates the paper and grain textures at runtime so the project needs no
 * binary assets at all.
 */
export function makeTextures(scene: Phaser.Scene): void {
  if (!scene.textures.exists('paper')) makePaper(scene);
  if (!scene.textures.exists('grain')) makeGrain(scene);
}

function makePaper(scene: Phaser.Scene): void {
  const tex = scene.textures.createCanvas('paper', GAME_W, GAME_H);
  if (!tex) return;
  const ctx = tex.getContext();

  ctx.fillStyle = '#f3ead9';
  ctx.fillRect(0, 0, GAME_W, GAME_H);

  // Warm, uneven wash: a few huge soft blotches.
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * GAME_W;
    const y = Math.random() * GAME_H;
    const r = 90 + Math.random() * 260;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const warm = Math.random() > 0.5;
    g.addColorStop(0, warm ? 'rgba(214, 193, 158, 0.18)' : 'rgba(255, 251, 241, 0.20)');
    g.addColorStop(1, 'rgba(243, 234, 217, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fibres.
  ctx.globalAlpha = 0.055;
  ctx.strokeStyle = '#6b5b45';
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * GAME_W;
    const y = Math.random() * GAME_H;
    const l = 3 + Math.random() * 16;
    const a = Math.random() * Math.PI;
    ctx.lineWidth = Math.random() < 0.85 ? 0.6 : 1.1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }

  // Vignette so the playing field feels printed on a page.
  const v = ctx.createRadialGradient(GAME_W / 2, GAME_H / 2, GAME_H * 0.32, GAME_W / 2, GAME_H / 2, GAME_W * 0.72);
  v.addColorStop(0, 'rgba(120, 96, 62, 0)');
  v.addColorStop(1, 'rgba(120, 96, 62, 0.22)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, GAME_W, GAME_H);

  tex.refresh();
}

function makeGrain(scene: Phaser.Scene): void {
  const size = 128;
  const tex = scene.textures.createCanvas('grain', size, size);
  if (!tex) return;
  const ctx = tex.getContext();
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random();
    img.data[i] = 60;
    img.data[i + 1] = 48;
    img.data[i + 2] = 34;
    img.data[i + 3] = v > 0.72 ? 26 : 0;
  }
  ctx.putImageData(img, 0, 0);
  tex.refresh();
}

export function paperBackground(scene: Phaser.Scene): void {
  scene.add.image(GAME_W / 2, GAME_H / 2, 'paper').setDepth(-100);
  scene.add
    .tileSprite(GAME_W / 2, GAME_H / 2, GAME_W, GAME_H, 'grain')
    .setDepth(-99)
    .setAlpha(0.9);

  // Faint blueprint grid over the paper.
  const g = scene.add.graphics().setDepth(-98);
  g.lineStyle(1, COLORS.grid, 0.5);
  const step = 40;
  for (let x = 0; x <= GAME_W; x += step) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, GAME_H);
    g.strokePath();
  }
  for (let y = 0; y <= GAME_H; y += step) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(GAME_W, y);
    g.strokePath();
  }

  // A red margin rule down the left, like a notebook.
  g.lineStyle(1.5, COLORS.enemy, 0.32);
  g.beginPath();
  g.moveTo(18, 0);
  g.lineTo(18, GAME_H);
  g.strokePath();
}
