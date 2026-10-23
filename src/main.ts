import Phaser from 'phaser';
import './style.css';
import { GAME_H, GAME_W } from './game/config';
import { GameScene } from './game/GameScene';
import { MenuScene } from './game/MenuScene';
import { OVERLAY_EVENT, type OverlayState } from './game/events';
import { sound } from './game/Sound';

const overlay = document.getElementById('overlay') as HTMLDivElement;
const card = document.getElementById('card') as HTMLDivElement;

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_W,
  height: GAME_H,
  backgroundColor: '#f3ead9',
  disableContextMenu: true,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: {
    antialias: true,
    roundPixels: false,
    powerPreference: 'high-performance',
  },
  scene: [MenuScene, GameScene],
});

const gameScene = (): GameScene => game.scene.getScene('Game') as GameScene;

let state: OverlayState = { kind: 'start' };


// A little hand-drawn tank + ricochet diagram for the title card.
const DOODLE = `
  <svg class="doodle" viewBox="0 0 260 96" aria-hidden="true">
    <g fill="none" stroke="#26221d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18 62 h48 v10 h-48 z" />
      <path d="M14 60 h56" stroke-dasharray="3 4" />
      <path d="M22 72 l8 6 M36 72 l8 6 M50 72 l8 6" />
      <path d="M30 62 v-12 h26 v12" />
      <circle cx="43" cy="48" r="8" />
      <path d="M51 46 l22 -2" />
      <path d="M73 44 l6 -22" stroke-dasharray="5 5" stroke="#3f9c8f" />
      <path d="M79 22 l46 26" stroke-dasharray="5 5" stroke="#3f9c8f" />
      <path d="M125 48 l18 40" stroke-dasharray="5 5" stroke="#3f9c8f" />
      <circle cx="125" cy="48" r="3.4" fill="#3f9c8f" stroke="none" />
      <path d="M150 88 l6 -8 M150 80 l6 8" stroke="#d4552e" />
      <path d="M170 40 h44 v14 h-44 z" />
      <path d="M214 40 v14" stroke-dasharray="3 3" />
    </g>
  </svg>
`;

const CONTROLS = `
  <ul class="controls">
    <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 驾驶 / 转向</li>
    <li><kbd>鼠标</kbd> 瞄准炮塔</li>
    <li><kbd>左键</kbd><kbd>空格</kbd> 开火</li>
    <li><kbd>右键</kbd><kbd>Shift</kbd> 慢速微调</li>
  </ul>
`;

function render(next: OverlayState): void {
  state = next;

  if (next.kind === 'hidden') {
    overlay.classList.add('hidden');
    // Drop the buttons so a stray Space/Enter can't re-trigger a hidden action.
    card.innerHTML = '';
    (document.activeElement as HTMLElement | null)?.blur();
    sound.resume();
    return;
  }

  overlay.classList.remove('hidden');
  card.setAttribute('data-state', next.kind);

  if (next.kind === 'start') {
    card.innerHTML = `
      <div class="kicker">Sketch Tank · Ricochet</div>
      <h1>坦克大作战<span class="accent">!</span></h1>
      ${DOODLE}
      <div class="rule"></div>
      <p>你驾驶一台铅笔涂出来的小坦克。子弹碰到任何墙壁都会<strong>反弹</strong>，
      所以别站在自己的弹道上——拐角、墙角和反弹，都是你的武器。</p>
      ${CONTROLS}
      <div class="actions">
        <button class="primary" id="btn-start">开始游戏</button>
        <span class="hint">或按 Enter</span>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
      </div>
      <div class="tip"><span class="dot"></span> 命中 3 次击毁敌方坦克 · 你共有 3 条命 · 共 3 个关卡 · 建议使用电脑键盘游玩</div>
    `;
  } else if (next.kind === 'paused') {
    card.innerHTML = `
      <div class="kicker">Paused</div>
      <h1>暂停中</h1>
      <div class="rule"></div>
      <p>喘口气。瞄准那条虚线——它会把子弹弹到哪里，画得清清楚楚。</p>
      ${CONTROLS}
      <div class="actions">
        <button class="primary" id="btn-resume">继续</button>
        <button id="btn-restart">重新开始</button>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
      </div>
      <div class="tip"><span class="dot"></span> 按 P 或 Esc 也可以继续</div>
    `;
  } else if (next.kind === 'gameover') {
    card.innerHTML = `
      <div class="kicker">Game Over</div>
      <h1>被击毁了</h1>
      <div class="rule"></div>
      <p>弹道不等人。下一次，把敌人的反弹线也算进去。</p>
      <div class="stateline">
        <span>得分 <b>${next.score}</b></span>
        <span>倒在 <b>${next.level}</b></span>
      </div>
      <div class="actions">
        <button class="primary" id="btn-restart">再玩一次</button>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
      </div>
    `;
  } else {
    card.innerHTML = `
      <div class="kicker">Mission Complete</div>
      <h1>全部击毁<span class="accent">!</span></h1>
      <div class="rule"></div>
      <p>三关全部清空。你的炮弹和你的胆子都挺好用。</p>
      <div class="stateline"><span>总得分 <b>${next.score}</b></span></div>
      <div class="actions">
        <button class="primary" id="btn-restart">再来一局</button>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
      </div>
    `;
  }

  document.getElementById('btn-start')?.addEventListener('click', () => {
    sound.resume();
    sound.ui();
    game.scene.stop('Menu');
    game.scene.start('Game');
    render({ kind: 'hidden' });
  });

  document.getElementById('btn-resume')?.addEventListener('click', () => {
    sound.ui();
    gameScene()?.setPaused(false);
    render({ kind: 'hidden' });
  });

  document.getElementById('btn-restart')?.addEventListener('click', () => {
    sound.resume();
    sound.ui();
    game.scene.stop('Menu');
    if (!game.scene.isActive('Game')) game.scene.start('Game');
    else gameScene()?.restartGame();
    render({ kind: 'hidden' });
  });

  document.getElementById('btn-mute')?.addEventListener('click', () => {
    sound.setMuted(!sound.muted);
    render(state);
  });
}

game.events.on(OVERLAY_EVENT, (next: OverlayState) => render(next));

game.events.once(Phaser.Core.Events.READY, () => render({ kind: 'start' }));
// Safety net in case the ready event has already fired.
window.setTimeout(() => {
  if (!card.childElementCount) render({ kind: 'start' });
}, 900);

// Phaser bakes text into a canvas at creation; re-rasterise once the hand
// lettering font has arrived.
function refreshText(): void {
  for (const scene of game.scene.getScenes(true)) {
    for (const obj of scene.children.list) {
      if (obj instanceof Phaser.GameObjects.Text) {
        const value = obj.text;
        obj.setText(`${value} `);
        obj.setText(value);
      }
    }
  }
}

if (document.fonts?.ready) {
  void document.fonts.ready.then(() => window.setTimeout(refreshText, 100));
}

window.addEventListener('keydown', (event) => {
  if (state.kind !== 'start') return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    document.getElementById('btn-start')?.click();
  }
});

// Unlock audio on the first interaction (browsers require a gesture).
window.addEventListener('pointerdown', () => sound.resume(), { once: true });
window.addEventListener('keydown', () => sound.resume(), { once: true });
