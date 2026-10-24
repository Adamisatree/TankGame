import Phaser from 'phaser';
import './style.css';
import { GAME_H, GAME_W } from './game/config';
import { GameScene } from './game/GameScene';
import { MenuScene } from './game/MenuScene';
import { OVERLAY_EVENT, type OverlayState } from './game/events';
import { DIFFICULTIES, settings, type Difficulty, type GameMode } from './game/settings';
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

const gameScene = (): GameScene | null => (game.scene.getScene('Game') as GameScene | null) ?? null;

let state: OverlayState = { kind: 'start' };

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

const SOLO_CONTROLS = `
  <ul class="controls">
    <li><kbd>WASD</kbd> 驾驶 / 转向</li>
    <li><kbd>鼠标</kbd> 瞄准炮塔</li>
    <li><kbd>左键</kbd><kbd>空格</kbd> 开火</li>
    <li><kbd>Shift</kbd> 慢速微调</li>
  </ul>
`;

const VERSUS_CONTROLS = `
  <ul class="controls two-col">
    <li><b class="p1">P1</b> <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 驾驶 · <kbd>Q</kbd><kbd>E</kbd> 微调炮口 · <kbd>空格</kbd> 开火</li>
    <li><b class="p2">P2</b> <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> 驾驶 · <kbd>,</kbd><kbd>.</kbd> 微调炮口 · <kbd>Enter</kbd> 开火</li>
  </ul>
`;

function settingsPanel(): string {
  const d = DIFFICULTIES[settings.difficulty];
  return `
    <div class="settings">
      <div class="setting-row">
        <span class="setting-label">模式</span>
        <div class="segmented" role="group" aria-label="游戏模式">
          <button type="button" data-mode="solo" class="${settings.mode === 'solo' ? 'on' : ''}">单人闯关</button>
          <button type="button" data-mode="versus" class="${settings.mode === 'versus' ? 'on' : ''}">本地双人</button>
        </div>
      </div>
      <div class="setting-row ${settings.mode === 'versus' ? 'is-muted' : ''}">
        <span class="setting-label">难度</span>
        <div class="segmented" role="group" aria-label="难度">
          ${Object.values(DIFFICULTIES)
            .map(
              (p) =>
                `<button type="button" data-diff="${p.key}" class="${settings.difficulty === p.key ? 'on' : ''}">${p.label}</button>`
            )
            .join('')}
        </div>
      </div>
      <div class="setting-note">${settings.mode === 'versus' ? '双人模式：每人 3 条命，先被击毁的一方输掉这一局。' : d.blurb}</div>
      <label class="setting-row toggle ${settings.mode === 'versus' ? 'is-muted' : ''}">
        <input type="checkbox" id="auto-dodge" ${settings.autoDodge ? 'checked' : ''} ${settings.mode === 'versus' ? 'disabled' : ''} />
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">
          <b>自动躲弹</b>
          <em>车身自动躲炮弹、自动贴墙找角度，你只管瞄准和开火（游戏中按 <kbd>G</kbd> 可随时切换）</em>
        </span>
      </label>
    </div>
  `;
}

function controlsForMode(): string {
  return settings.mode === 'versus' ? VERSUS_CONTROLS : SOLO_CONTROLS;
}

function bindSettings(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.mode = btn.dataset.mode as GameMode;
      sound.resume();
      sound.ui();
      render({ kind: 'start' });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.difficulty = btn.dataset.diff as Difficulty;
      sound.ui();
      render({ kind: 'start' });
    });
  });
  const auto = root.querySelector<HTMLInputElement>('#auto-dodge');
  auto?.addEventListener('change', () => {
    settings.autoDodge = auto.checked;
    sound.ui();
  });
}

function startMatch(): void {
  sound.resume();
  sound.ui();
  game.scene.stop('Menu');
  if (game.scene.isActive('Game')) {
    gameScene()?.restartGame();
  } else {
    game.scene.start('Game');
  }
  render({ kind: 'hidden' });
}

function render(next: OverlayState): void {
  state = next;

  if (next.kind === 'hidden') {
    overlay.classList.add('hidden');
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
      <p>子弹碰到任何墙壁都会<strong>反弹</strong>——包括你自己的炮弹。站在自己的弹道上，一样会被自己打到。</p>
      ${settingsPanel()}
      ${controlsForMode()}
      <div class="actions">
        <button class="primary" id="btn-start">开始游戏</button>
        <span class="hint">或按 Enter</span>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
      </div>
      <div class="tip"><span class="dot"></span> ${
        settings.mode === 'versus'
          ? '双人：先被打光 3 条命的一方输 · 3 张地图轮换'
          : `单人：你有 ${DIFFICULTIES[settings.difficulty].lives} 条命，击毁敌方坦克 ${DIFFICULTIES[settings.difficulty].enemyLives} 次即可过关 · 共 3 关`
      }</div>
    `;
    bindSettings(card);
  } else if (next.kind === 'paused') {
    card.innerHTML = `
      <div class="kicker">Paused</div>
      <h1>暂停中</h1>
      <div class="rule"></div>
      <p>绿色虚线是真实的反弹路径，拐角上的小圈就是反弹点。</p>
      ${settingsPanel()}
      ${controlsForMode()}
      <div class="actions">
        <button class="primary" id="btn-resume">继续</button>
        <button id="btn-restart">重新开始</button>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
      </div>
      <div class="tip"><span class="dot"></span> 按 P 或 Esc 继续 · 更改模式/难度后点“重新开始”生效</div>
    `;
    bindSettings(card);
  } else if (next.kind === 'gameover') {
    card.innerHTML = `
      <div class="kicker">Game Over</div>
      <h1>被击毁了</h1>
      <div class="rule"></div>
      <p>下次记得别停在自己的反弹线上。</p>
      <div class="stateline">
        <span>得分 <b>${next.score}</b></span>
        <span>倒在 <b>${next.level}</b></span>
      </div>
      <div class="actions">
        <button class="primary" id="btn-restart">再玩一次</button>
        <button id="btn-menu">返回菜单</button>
      </div>
    `;
  } else if (next.kind === 'victory') {
    card.innerHTML = `
      <div class="kicker">Mission Complete</div>
      <h1>全部击毁<span class="accent">!</span></h1>
      <div class="rule"></div>
      <p>三关全部清空。想再难一点的话，去菜单换成「困难」试试。</p>
      <div class="stateline"><span>总得分 <b>${next.score}</b></span></div>
      <div class="actions">
        <button class="primary" id="btn-restart">再来一局</button>
        <button id="btn-menu">返回菜单</button>
      </div>
    `;
  } else {
    const p1Wins = next.winner === 'p1';
    card.innerHTML = `
      <div class="kicker">Local Versus</div>
      <h1><span class="${p1Wins ? 'p1' : 'p2'}">${p1Wins ? 'P1' : 'P2'}</span> 获胜<span class="accent">!</span></h1>
      <div class="rule"></div>
      <p>${p1Wins ? 'P1' : 'P2'} 打光了对手的 3 条命。</p>
      <div class="stateline">
        <span class="p1">P1 剩余 <b>${next.p1Lives}</b></span>
        <span class="p2">P2 剩余 <b>${next.p2Lives}</b></span>
      </div>
      <div class="actions">
        <button class="primary" id="btn-restart">再来一局</button>
        <button id="btn-menu">返回菜单</button>
      </div>
    `;
  }

  document.getElementById('btn-start')?.addEventListener('click', startMatch);

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

  document.getElementById('btn-menu')?.addEventListener('click', () => {
    sound.ui();
    game.scene.stop('Game');
    game.scene.start('Menu');
    render({ kind: 'start' });
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

export { settings };
