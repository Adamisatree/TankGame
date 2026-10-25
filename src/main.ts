import Phaser from 'phaser';
import './style.css';
import { GAME_H, GAME_W } from './game/config';
import { GameScene } from './game/GameScene';
import { MenuScene } from './game/MenuScene';
import { OVERLAY_EVENT, type OverlayState } from './game/events';
import { DIFFICULTIES, settings, type Difficulty, type GameMode } from './game/settings';
import { sound } from './game/Sound';
import { type Level } from './engine/level';
import { levelById, levels } from './maps/registry';
import { SKILLS, isSkillId, skillById, type SkillId } from './game/skills';
import { TEAM_NAMES } from './game/Tank';
import {
  ACTION_LABEL,
  GLOBAL_LABEL,
  defaultBindings,
  eventToKeyCode,
  getBindings,
  keyLabel,
  resetBindings,
  saveBindings,
  SEAT_ACTIONS,
  type BindingsFile,
  type GlobalAction,
  type SeatAction,
} from './game/keybinds';
import { DEFAULT_LAN_PORT } from './net/protocol';
import { CAPACITY_CHOICES, KILL_TARGET_CHOICES, TIME_LIMIT_CHOICES } from './game/rules';
import { bindUpdaterPanel, initUpdater, updaterPanelHtml } from './update/UpdaterPanel';
import { bindTuningPanel, tuningPanelHtml } from './ui/tuningPanel';
import { MapEditor } from './ui/mapEditor';
import { emptyMap, fromLevel, newMapId, normalizeMapFile, type MapFile } from './maps/format';
import { deleteMap, exportFileName, exportMapText, getMap, importMapText, listMaps, saveMap } from './maps/store';
import { refreshLevels } from './maps/registry';
import { APP_VERSION } from './version';
import './update/types';

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

// ---------------------------------------------------------------- map picker

/** Tiny top-down preview drawn from the same data the game uses. */
function mapPreview(level: Level): string {
  const rect = (b: { x: number; y: number; w: number; h: number }, cls: string) =>
    `<rect class="${cls}" x="${(b.x * 100).toFixed(1)}" y="${(b.y * 70).toFixed(1)}" width="${(b.w * 100).toFixed(1)}" height="${(b.h * 70).toFixed(1)}" />`;
  return `
    <svg class="map-svg" viewBox="0 0 100 70" aria-hidden="true">
      <rect class="map-frame" x="0.8" y="0.8" width="98.4" height="68.4" rx="2" />
      ${level.walls.map((b) => rect(b, 'map-wall')).join('')}
      ${level.crates.map((b) => rect(b, 'map-crate')).join('')}
      ${level.pickups.map((p) => `<circle class="map-pickup" cx="${(p.x * 100).toFixed(1)}" cy="${(p.y * 70).toFixed(1)}" r="2.1" />`).join('')}
      <circle class="map-p1" cx="${(level.player.x * 100).toFixed(1)}" cy="${(level.player.y * 70).toFixed(1)}" r="3.4" />
      <circle class="map-p2" cx="${(level.enemy.x * 100).toFixed(1)}" cy="${(level.enemy.y * 70).toFixed(1)}" r="3.4" />
    </svg>`;
}

function mapPicker(): string {
  const cards = levels().map(
    (level) => `
      <button type="button" class="map-card ${settings.mapId === level.id ? 'on' : ''}" data-map="${level.id}" title="${level.blurb}">
        ${mapPreview(level)}
        <span class="map-name">${level.name.replace(/^\d+\s*·\s*/, '')}</span>
      </button>`
  ).join('');

  return `
    <div class="setting-block">
      <div class="setting-head">
        <span class="setting-label">地图</span>
        <span class="setting-hint">${levels().length} 张（含自定义）· 对战前选，单人从这张开始连着打 5 关</span>
      </div>
      <div class="map-grid">
        <button type="button" class="map-card map-random ${settings.mapId === 'random' ? 'on' : ''}" data-map="random">
          <span class="map-dice">随机</span>
          <span class="map-name">每局换一张</span>
        </button>
        ${cards}
      </div>
    </div>`;
}

/** Custom map library: create, edit, duplicate, export, delete. */
function customMapsPanel(): string {
  const maps = listMaps();
  const rows = maps
    .map(
      (map) => `
      <li class="custom-map ${settings.mapId === map.id ? 'is-picked' : ''}">
        <div class="custom-map-main">
          <b>${escapeHtml(map.name)}</b>
          <span class="custom-map-meta">
            ${map.size.w}×${map.size.h} · 墙 ${map.walls.length} · 道具 ${map.pickups.length} ·
            ${map.source === 'received' ? '来自联机' : '本机'} · rev ${map.rev}
          </span>
        </div>
        <div class="custom-map-actions">
          <button type="button" class="chip tiny" data-map-play="${map.id}">用这张</button>
          <button type="button" class="chip tiny" data-map-edit="${map.id}">编辑</button>
          <button type="button" class="chip tiny ghost" data-map-export="${map.id}">导出</button>
          <button type="button" class="chip tiny ghost" data-map-delete="${map.id}">删除</button>
        </div>
      </li>`
    )
    .join('');

  return `
    <div class="setting-block custom-maps">
      <div class="setting-head">
        <span class="setting-label">自定义地图</span>
        <span class="setting-hint">${maps.length} 张 · 联机收到过的图都会存在这里</span>
      </div>
      ${maps.length ? `<ul class="custom-map-list">${rows}</ul>` : '<p class="lan-hint">还没有自定义地图，点下面按钮画一张。</p>'}
      <div class="custom-map-tools">
        <button type="button" class="chip" id="map-new">＋ 新建地图</button>
        <button type="button" class="chip" id="map-copy-builtin">从内置地图复制一张</button>
        <button type="button" class="chip ghost" id="map-import">导入 .tankmap.json</button>
      </div>
    </div>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

// ---------------------------------------------------------------- skill picker

function skillPicker(): string {
  const cards = (seat: 1 | 2): string => {
    const current = seat === 1 ? settings.skillP1 : settings.skillP2;
    return SKILLS.map(
      (s) => `
        <button type="button" class="skill-card ${current === s.id ? 'on' : ''}" data-skill="${s.id}" data-seat="${seat}">
          <b>${s.name}</b>
          <em>冷却 ${s.cooldown}s</em>
          <span>${s.blurb}</span>
        </button>`
    ).join('');
  };

  // LAN: you pick *your* skill here; everyone chooses for themselves in the
  // room. Showing both seats let the host edit the guest's pick, which was wrong.
  if (settings.mode === 'lan') {
    const seat: 1 | 2 = settings.lanRole === 'host' ? 1 : 2;
    return `
      <div class="setting-block">
        <div class="setting-head">
          <span class="setting-label">你的召唤师技能</span>
          <span class="setting-hint">只在房间界面里生效，别人改不了你的</span>
        </div>
        <div class="skill-cards">${cards(seat)}</div>
      </div>`;
  }

  const twoSeats = settings.mode === 'versus';
  return `
    <div class="setting-block">
      <div class="setting-head">
        <span class="setting-label">召唤师技能</span>
        <span class="setting-hint">开局前选一个，对局中按技能键释放</span>
      </div>
      ${
        twoSeats
          ? `<div class="skill-row"><span class="seat-tag p1">P1 / 房主</span><div class="skill-cards">${cards(1)}</div></div>
             <div class="skill-row"><span class="seat-tag p2">P2 / 访客</span><div class="skill-cards">${cards(2)}</div></div>`
          : `<div class="skill-cards">${cards(1)}</div>`
      }
    </div>`;
}

// ---------------------------------------------------------------- LAN panel

/** Full-width IME punctuation is why "192.168.1.10" used to be untypable. */
function normalizeAddress(raw: string): string {
  return raw
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[。．｡]/g, '.')
    .replace(/[：]/g, ':')
    .replace(/[\uFF0E]/g, '.')
    .replace(/[^\w.:-]/g, '')
    .slice(0, 48);
}

function lanPanel(): string {
  const devPorts = ['5173', '4173'];
  const servedByLanServer = location.protocol.startsWith('http') && !devPorts.includes(location.port);
  const isDesktop = !!(window.tankGame?.isDesktop);

  const host = `
    <div class="lan-block">
      <p class="lan-lead">点「开始游戏」就会开好房间。<b>你的房间地址</b>会显示在下面，也会显示在游戏画面顶部。</p>
      <div class="lan-room" id="lan-room"><span class="lan-loading">正在检测本机局域网地址…</span></div>
      <p class="lan-hint">把上面的地址发给朋友：他在浏览器里直接打开就能加入，或者在自己客户端的「加入房间」里点「扫描 / 粘贴」。</p>
    </div>`;

  const guest = `
    <div class="lan-block">
      <div class="setting-row lan-address-row">
        <span class="setting-label">房主地址</span>
        <input id="lan-address" class="lan-input" type="text" spellcheck="false" autocomplete="off"
          inputmode="url"
          placeholder="${servedByLanServer ? location.host : '192.168.1.10'}"
          value="${settings.lanAddress}" />
      </div>
      <div class="lan-quick">
        ${
          servedByLanServer
            ? `<button type="button" class="chip" id="lan-use-here">用当前网页的服务器（留空即可）</button>`
            : ''
        }
        ${isDesktop ? `<button type="button" class="chip" id="lan-scan">扫描局域网房间</button>` : ''}
        <button type="button" class="chip" id="lan-paste">粘贴剪贴板</button>
      </div>
      <div class="lan-scan-list" id="lan-scan-list"></div>
      <p class="lan-hint">
        不用记 IP：可以只填 <b>192.168.1.10</b>（端口默认 ${DEFAULT_LAN_PORT}），也可以直接粘贴房主给你的完整网址。
        中文输入法打出的「。」会自动变成「.」。
      </p>
    </div>`;

  return `
    <div class="lan-panel">
      <div class="setting-row">
        <span class="setting-label">身份</span>
        <div class="segmented">
          <button type="button" data-lanrole="host" class="${settings.lanRole === 'host' ? 'on' : ''}">创建房间（房主）</button>
          <button type="button" data-lanrole="guest" class="${settings.lanRole === 'guest' ? 'on' : ''}">加入房间（访客）</button>
        </div>
      </div>
      ${settings.lanRole === 'host' ? host : guest}
      ${matchSettings()}
    </div>`;
}

/** v1.3 pre-match rules: mode, head count, win conditions, damage switches. */
function matchSettings(): string {
  const m = settings.match;
  const hostOnly = settings.lanRole !== 'host';
  const chipRow = (name: 'capacity' | 'killTarget' | 'timeLimit', values: number[], labels: (v: number) => string): string =>
    values
      .map(
        (value) =>
          `<button type="button" class="chip ${Number(m[name as keyof typeof m]) === value ? 'on' : ''}"
             data-match="${name}" data-value="${value}" ${hostOnly ? 'disabled' : ''}>${labels(value)}</button>`
      )
      .join('');

  return `
    <div class="match-panel">
      <div class="setting-row">
        <span class="setting-label">玩法</span>
        <div class="segmented">
          <button type="button" data-match="mode" data-value="ffa" class="${m.mode === 'ffa' ? 'on' : ''}" ${hostOnly ? 'disabled' : ''}>乱斗（各打各的）</button>
          <button type="button" data-match="mode" data-value="team" class="${m.mode === 'team' ? 'on' : ''}" ${hostOnly ? 'disabled' : ''}>团队（红蓝对抗）</button>
        </div>
      </div>
      <div class="setting-row">
        <span class="setting-label">人数上限</span>
        <div class="chip-row">${chipRow('capacity', CAPACITY_CHOICES, (v) => `${v} 人`)}</div>
      </div>
      <div class="setting-row">
        <span class="setting-label">结束方式</span>
        <div class="chip-row">
          ${(['kills', 'time', 'both'] as const)
            .map(
              (kind) =>
                `<button type="button" class="chip ${m.winCondition === kind ? 'on' : ''}" data-match="winCondition" data-value="${kind}" ${hostOnly ? 'disabled' : ''}>${
                  kind === 'kills' ? '打到人头' : kind === 'time' ? '时间到' : '两者任一'
                }</button>`
            )
            .join('')}
        </div>
      </div>
      <div class="setting-row">
        <span class="setting-label">人头目标</span>
        <div class="chip-row">${chipRow('killTarget', KILL_TARGET_CHOICES, (v) => (v === 0 ? '不限' : `${v} 杀`))}</div>
      </div>
      <div class="setting-row">
        <span class="setting-label">时间上限</span>
        <div class="chip-row">${chipRow('timeLimit', TIME_LIMIT_CHOICES, (v) => (v === 0 ? '不限时' : `${v / 60} 分钟`))}</div>
      </div>
      <div class="setting-row">
        <span class="setting-label">伤害开关</span>
        <div class="toggle-row">
          <button type="button" class="chip ${m.friendlyFire ? 'on' : ''}" data-match="friendlyFire" data-value="${m.friendlyFire ? '0' : '1'}" ${hostOnly ? 'disabled' : ''}>
            友伤：${m.friendlyFire ? '开' : '关'}
          </button>
          <button type="button" class="chip ${m.selfDamage ? 'on' : ''}" data-match="selfDamage" data-value="${m.selfDamage ? '0' : '1'}" ${hostOnly ? 'disabled' : ''}>
            自伤（自己被弹打到自己）：${m.selfDamage ? '开' : '关'}
          </button>
        </div>
      </div>
      <p class="lan-hint">
        ${hostOnly
          ? '这些由房主设置，进房间后会同步给你，所有人看到的规则和人头都一样。'
          : '你可以在开局前决定：人数 2–10、人头目标、时间上限，以及友伤和自伤两个独立开关；时间到人头相同就是平局。'}
      </p>
    </div>`;
}

/** Fills in the host's own addresses, with a one-click copy. */
async function initHostRoom(): Promise<void> {
  const box = document.getElementById('lan-room');
  if (!box) return;
  try {
    const res = await fetch('/info', { cache: 'no-store' });
    if (!res.ok) throw new Error('no info');
    const info = (await res.json()) as { addresses?: string[]; port?: number };
    const port = info.port ?? DEFAULT_LAN_PORT;
    const addresses = (info.addresses ?? []).slice(0, 4);
    if (!addresses.length) throw new Error('no address');
    box.innerHTML = addresses
      .map(
        (ip) => `
        <button type="button" class="lan-copy" data-copy="http://${ip}:${port}">
          <b>http://${ip}:${port}</b><span>点击复制</span>
        </button>`
      )
      .join('');
    box.querySelectorAll<HTMLButtonElement>('.lan-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const text = btn.dataset.copy ?? '';
        void navigator.clipboard?.writeText(text);
        settings.lanAddress = '';
        btn.classList.add('copied');
        const label = btn.querySelector('span');
        if (label) label.textContent = '已复制！';
        window.setTimeout(() => {
          btn.classList.remove('copied');
          if (label) label.textContent = '点击复制';
        }, 1400);
      });
    });
  } catch {
    box.innerHTML = `<span class="lan-loading">这个页面不是由局域网服务托管的。<br>
      用桌面客户端或 <code>npm run lan</code> 启动后，这里会显示你的房间地址。</span>`;
  }
}

function initGuestTools(): void {
  const input = document.getElementById('lan-address') as HTMLInputElement | null;
  if (input) {
    input.addEventListener('input', () => {
      const clean = normalizeAddress(input.value);
      if (clean !== input.value) input.value = clean;
      settings.lanAddress = clean;
    });
  }

  document.getElementById('lan-use-here')?.addEventListener('click', () => {
    settings.lanAddress = '';
    if (input) input.value = '';
    sound.ui();
  });

  document.getElementById('lan-paste')?.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      const clean = normalizeAddress(text);
      if (input) input.value = clean;
      settings.lanAddress = clean;
      sound.ui();
    } catch {
      input?.focus();
    }
  });

  const list = document.getElementById('lan-scan-list');
  document.getElementById('lan-scan')?.addEventListener('click', async () => {
    const api = window.tankGame;
    if (!api?.scanLan || !list) return;
    list.innerHTML = '<span class="lan-loading">正在扫描局域网…</span>';
    try {
      const hosts = await api.scanLan();
      if (!hosts.length) {
        list.innerHTML =
          '<span class="lan-loading">没扫到房间。让房主先点「开始游戏」，或让他把地址发给你直接粘贴。</span>';
        return;
      }
      list.innerHTML = hosts
        .map(
          (h) =>
            `<button type="button" class="lan-host" data-host="${h.host}:${h.port}">
               <b>${h.name || 'TankGame 房间'}</b><span>${h.host}:${h.port}</span>
             </button>`
        )
        .join('');
      list.querySelectorAll<HTMLButtonElement>('.lan-host').forEach((btn) => {
        btn.addEventListener('click', () => {
          const value = btn.dataset.host ?? '';
          if (input) input.value = value;
          settings.lanAddress = value;
          list.innerHTML = `<span class="lan-loading">已选中 ${value}，点「开始游戏」加入。</span>`;
          sound.ui();
        });
      });
    } catch {
      list.innerHTML = '<span class="lan-loading">扫描失败，请手动输入房主地址。</span>';
    }
  });
}

// ---------------------------------------------------------------- bindings UI

type BindingScope = 'solo' | 'versus.p1' | 'versus.p2' | 'lan.host' | 'lan.guest' | 'global';

let keyTab: BindingScope = 'solo';

const KEY_TABS: { id: BindingScope; label: string }[] = [
  { id: 'solo', label: '单人闯关' },
  { id: 'versus.p1', label: '双人 P1' },
  { id: 'versus.p2', label: '双人 P2' },
  { id: 'lan.host', label: '联机房主' },
  { id: 'lan.guest', label: '联机访客' },
  { id: 'global', label: '系统' },
];

function scopeSeat(scope: BindingScope): { group: Record<SeatAction, number>; prefix: string } | null {
  const b = getBindings();
  switch (scope) {
    case 'solo':
      return { group: b.solo, prefix: '单人' };
    case 'versus.p1':
      return { group: b.versus.p1, prefix: '双人 P1' };
    case 'versus.p2':
      return { group: b.versus.p2, prefix: '双人 P2' };
    case 'lan.host':
      return { group: b.lan.host, prefix: '联机房主' };
    case 'lan.guest':
      return { group: b.lan.guest, prefix: '联机访客' };
    default:
      return null;
  }
}

function keyRowsHtml(): string {
  const b = getBindings();
  const rows: string[] = [];
  const seat = scopeSeat(keyTab);
  if (seat) {
    for (const action of SEAT_ACTIONS) {
      rows.push(`
        <div class="key-row">
          <span>${ACTION_LABEL[action]}</span>
          <button type="button" class="key-btn" data-bind-scope="${keyTab}" data-bind-action="${action}">
            ${keyLabel(seat.group[action])}
          </button>
        </div>`);
    }
  } else {
    for (const action of ['pause', 'mute', 'autoDodge'] as GlobalAction[]) {
      rows.push(`
        <div class="key-row">
          <span>${GLOBAL_LABEL[action]}</span>
          <button type="button" class="key-btn" data-bind-scope="global" data-bind-action="${action}">
            ${keyLabel(b.global[action])}
          </button>
        </div>`);
    }
  }
  return rows.join('');
}

function setBinding(scope: BindingScope, action: string, code: number): void {
  const b: BindingsFile = getBindings();
  const clean = Math.max(1, Math.min(255, code));
  switch (scope) {
    case 'solo':
      b.solo[action as SeatAction] = clean;
      break;
    case 'versus.p1':
      b.versus.p1[action as SeatAction] = clean;
      break;
    case 'versus.p2':
      b.versus.p2[action as SeatAction] = clean;
      break;
    case 'lan.host':
      b.lan.host[action as SeatAction] = clean;
      break;
    case 'lan.guest':
      b.lan.guest[action as SeatAction] = clean;
      break;
    default:
      b.global[action as GlobalAction] = clean;
  }
  saveBindings(b);
}

function bindKeyEditor(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('[data-keytab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      keyTab = (btn.dataset.keytab as BindingScope) ?? 'solo';
      sound.ui();
      root.querySelectorAll<HTMLButtonElement>('[data-keytab]').forEach((b) => b.classList.toggle('on', b === btn));
      const rows = root.querySelector('.key-rows');
      if (rows) rows.innerHTML = keyRowsHtml();
      bindKeyRows(root);
    });
  });

  bindKeyRows(root);

  root.querySelector<HTMLButtonElement>('[data-keyreset]')?.addEventListener('click', () => {
    resetBindings();
    sound.ui();
    const rows = root.querySelector('.key-rows');
    if (rows) rows.innerHTML = keyRowsHtml();
    bindKeyRows(root);
    render(state);
  });
}

/** Click a key, then press the key you want – no text entry anywhere. */
function bindKeyRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLButtonElement>('.key-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('capturing')) return;
      const scope = btn.dataset.bindScope as BindingScope;
      const action = btn.dataset.bindAction ?? '';
      const previous = btn.textContent ?? '';
      btn.classList.add('capturing');
      btn.textContent = '请按键…';

      const finish = (code: number | null): void => {
        window.removeEventListener('keydown', onKey, true);
        btn.classList.remove('capturing');
        if (code === null) {
          btn.textContent = previous;
          return;
        }
        setBinding(scope, action, code);
        btn.textContent = keyLabel(code);
        sound.ui();
        // Re-render the footer + start card hints with the new key.
        refreshControlHints();
      };

      const onKey = (event: KeyboardEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const code = eventToKeyCode(event);
        finish(code === 27 ? null : code);
      };

      window.addEventListener('keydown', onKey, true);
    });
  });
}

function keyEditor(): string {
  return `
    <details class="keybinds">
      <summary>按键设置 · 点一下键位，再按你想用的键</summary>
      <div class="key-tabs">
        ${KEY_TABS.map(
          (t) => `<button type="button" data-keytab="${t.id}" class="${keyTab === t.id ? 'on' : ''}">${t.label}</button>`
        ).join('')}
      </div>
      <div class="key-rows">${keyRowsHtml()}</div>
      <div class="key-foot">
        <span>每个模式各有一套键位，改了立刻生效（下一局开始）。Esc 取消。</span>
        <button type="button" data-keyreset>恢复默认</button>
      </div>
    </details>`;
}

// ---------------------------------------------------------------- settings

function settingsPanel(): string {
  const d = DIFFICULTIES[settings.difficulty];
  const versus = settings.mode === 'versus' || settings.mode === 'lan';
  return `
    <div class="settings">
      <div class="setting-row">
        <span class="setting-label">模式</span>
        <div class="segmented" role="group" aria-label="游戏模式">
          <button type="button" data-mode="solo" class="${settings.mode === 'solo' ? 'on' : ''}">单人闯关</button>
          <button type="button" data-mode="versus" class="${settings.mode === 'versus' ? 'on' : ''}">本地双人</button>
          <button type="button" data-mode="lan" class="${settings.mode === 'lan' ? 'on' : ''}">局域网联机</button>
        </div>
      </div>
      <div class="setting-row ${versus ? 'is-muted' : ''}">
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
      <div class="setting-note">${versus ? '对战模式：双方各 100 血，先被打空的一方输掉这一局。' : d.blurb}</div>
      ${mapPicker()}
      ${skillPicker()}
      ${settings.mode === 'lan' ? lanPanel() : ''}
      <label class="setting-row toggle ${versus ? 'is-muted' : ''}">
        <input type="checkbox" id="auto-dodge" ${settings.autoDodge ? 'checked' : ''} ${versus ? 'disabled' : ''} />
        <span class="switch" aria-hidden="true"></span>
        <span class="toggle-text">
          <b>自动躲弹</b>
          <em>车身自动躲炮弹、自动贴墙找角度，你只管瞄准和开火（游戏中按 <kbd>${keyLabel(getBindings().global.autoDodge)}</kbd> 可随时切换）</em>
        </span>
      </label>
      ${keyEditor()}
      ${updaterPanelHtml()}
    </div>
  `;
}

function controlsForMode(): string {
  const b = getBindings();
  const k = (code: number): string => `<kbd>${keyLabel(code)}</kbd>`;
  if (settings.mode === 'versus') {
    const a = b.versus.p1;
    const c = b.versus.p2;
    return `
      <ul class="controls two-col">
        <li><b class="p1">P1</b> ${k(a.up)}${k(a.left)}${k(a.down)}${k(a.right)} 驾驶（炮口跟着车体转） · ${k(a.fire)} 开火 · ${k(a.skill)} 技能</li>
        <li><b class="p2">P2</b> ${k(c.up)}${k(c.left)}${k(c.down)}${k(c.right)} 驾驶（炮口跟着车体转） · ${k(c.fire)} 开火 · ${k(c.skill)} 技能</li>
      </ul>`;
  }
  const s = b.solo;
  return `
    <ul class="controls">
      <li>${k(s.up)}${k(s.left)}${k(s.down)}${k(s.right)} 驾驶 / 转向（炮口跟着车体转）</li>
      <li><kbd>鼠标</kbd> 瞄准（炮口只能在车头 ±72° 内偏转，车体转了炮口就跟着转）</li>
      <li>${k(s.fire)} 或 <kbd>左键</kbd> 开火 · ${k(s.slow)} 慢速微调</li>
      <li>${k(s.skill)} 召唤师技能 · <kbd>P</kbd> 暂停</li>
    </ul>`;
}

function refreshControlHints(): void {
  const host = document.getElementById('controls-host');
  if (host) host.innerHTML = controlsForMode();
}

/** Saves a map file to disk as `<name>.tankmap.json`. */
function downloadMap(map: MapFile): void {
  const blob = new Blob([exportMapText(map)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(map);
  link.click();
  URL.revokeObjectURL(url);
}

/** Opens the editor for a working copy of `map`. */
function openEditor(map: MapFile): void {
  render({ kind: 'mapEditor', map: normalizeMapFile({ ...map, minAppVersion: map.minAppVersion || APP_VERSION }) });
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
  root.querySelectorAll<HTMLButtonElement>('[data-map]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.mapId = btn.dataset.map ?? 'random';
      sound.ui();
      render({ kind: 'start' });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-skill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.skill as SkillId;
      if (btn.dataset.seat === '2') settings.skillP2 = id;
      else settings.skillP1 = id;
      sound.ui();
      render({ kind: 'start' });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-match]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.match as
        | 'mode'
        | 'winCondition'
        | 'capacity'
        | 'killTarget'
        | 'timeLimit'
        | 'friendlyFire'
        | 'selfDamage';
      const raw = btn.dataset.value ?? '';
      if (key === 'mode') settings.match.mode = raw === 'team' ? 'team' : 'ffa';
      else if (key === 'winCondition')
        settings.match.winCondition = raw === 'kills' || raw === 'time' ? raw : 'both';
      else if (key === 'friendlyFire' || key === 'selfDamage') settings.match[key] = raw === '1';
      else settings.match[key] = Number(raw);
      sound.ui();
      render(state);
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-lanrole]').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.lanRole = btn.dataset.lanrole === 'guest' ? 'guest' : 'host';
      sound.ui();
      render({ kind: 'start' });
    });
  });

  const auto = root.querySelector<HTMLInputElement>('#auto-dodge');
  auto?.addEventListener('change', () => {
    settings.autoDodge = auto.checked;
    sound.ui();
  });

  // Custom maps: create / edit / play / export / delete.
  root.querySelector<HTMLButtonElement>('#map-new')?.addEventListener('click', () => {
    sound.ui();
    openEditor(emptyMap({ name: '我的地图', author: '本机', sizeId: 'screen' }));
  });
  root.querySelector<HTMLButtonElement>('#map-copy-builtin')?.addEventListener('click', () => {
    sound.ui();
    // Copy whatever is picked; random falls back to the first built-in.
    const picked = levels().find((level) => level.id === settings.mapId);
    const base = picked ?? levels().find((level) => !level.id.startsWith('custom-')) ?? levels()[0];
    const label = base.name.split('·').pop()?.trim() || base.name;
    openEditor(fromLevel(base, { name: `${label} 副本` }));
  });
  root.querySelector<HTMLButtonElement>('#map-import')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        const result = importMapText(text);
        refreshLevels();
        if (result.ok) {
          render({ kind: 'start' });
        } else {
          window.alert(`导入失败：${result.error ?? '未知错误'}`);
        }
      });
    });
    input.click();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-map-play]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      settings.mapId = btn.dataset.mapPlay ?? 'random';
      render({ kind: 'start' });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-map-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      const map = getMap(btn.dataset.mapEdit ?? '');
      if (map) openEditor(map);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-map-export]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      const map = getMap(btn.dataset.mapExport ?? '');
      if (map) downloadMap(map);
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-map-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const map = getMap(btn.dataset.mapDelete ?? '');
      if (!map) return;
      if (!window.confirm(`删除「${map.name}」？这一步不能撤销。`)) return;
      sound.ui();
      deleteMap(map.id);
      refreshLevels();
      if (settings.mapId === map.id) settings.mapId = 'random';
      render({ kind: 'start' });
    });
  });

  bindKeyEditor(root);
  bindUpdaterPanel(root);

  if (settings.mode === 'lan') {
    if (settings.lanRole === 'host') void initHostRoom();
    else initGuestTools();
  }
}

function startMatch(): void {
  sound.resume();
  sound.ui();
  game.scene.stop('Menu');
  if (game.scene.isActive('Game')) {
    // Re-entering with a different mode has to rebuild the scene.
    game.scene.stop('Game');
  }
  game.scene.start('Game');
  render({ kind: 'hidden' });
}


// ---------------------------------------------------------------- room lobby

/**
 * The room screen. Everyone lands here after joining: seats, each player's own
 * skill, and (in team mode) hand-picked sides. The host starts the match; nobody
 * is dropped into the arena before that.
 */
function lobbyHtml(state: Extract<OverlayState, { kind: 'lobby' }>): string {
  const me = state.roster.find((seat) => seat.id === state.myId);
  const teams = state.mode === 'team';
  const readyCount = state.roster.filter((seat) => seat.ready).length;
  const teamCount = state.teams ?? 2;

  // Team sizes drive the "no empty team" warning right in the lobby.
  const sizes = new Array(teamCount).fill(0);
  for (const seat of state.roster) {
    const team = Math.max(0, Math.min(teamCount - 1, seat.team));
    sizes[team] += 1;
  }
  const emptyTeams = sizes.map((size, index) => (size === 0 ? index : -1)).filter((index) => index >= 0);

  const seatCards = state.roster
    .map((seat) => {
      const isMe = seat.id === state.myId;
      const teamTone = teams ? `team-${Math.min(seat.team, 5)}` : '';
      // Skills are private: you see your own pick, everyone else is just "已选".
      const skill = isMe
        ? isSkillId(seat.skill)
          ? skillById(seat.skill).name
          : '还没选'
        : seat.hasSkill
          ? '已选择（保密）'
          : '未选择';
      const teamButtons = state.isHost && teams
        ? `<div class="lobby-teams">
             ${Array.from({ length: teamCount }, (_, team) => team)
               .map(
                 (team) =>
                   `<button type="button" class="chip tiny team-${team} ${seat.team === team ? 'on' : ''}"
                      data-lobby-team="${team}" data-lobby-id="${seat.id}">${TEAM_NAMES[team] ?? `第${team + 1}队`}</button>`
               )
               .join('')}
           </div>`
        : teams
          ? `<div class="lobby-seat-team">${TEAM_NAMES[seat.team] ?? `第${seat.team + 1}队`}</div>`
          : '';
      return `
        <div class="lobby-seat ${isMe ? 'is-me' : ''} ${teamTone}">
          <div class="lobby-seat-head">
            <b>${seat.name}</b>
            ${seat.host ? '<span class="lobby-tag">房主</span>' : ''}
            ${isMe ? '<span class="lobby-tag me">你</span>' : ''}
            <span class="lobby-ready ${seat.ready ? 'on' : ''}">${seat.ready ? '已准备' : '等待中'}</span>
          </div>
          <div class="lobby-seat-skill">技能：${skill}</div>
          ${teamButtons}
        </div>`;
    })
    .join('');

  // Your own skill picker (never anyone else's – each player owns their choice).
  const mySkills = SKILLS.map(
    (skill) => `
      <button type="button" class="skill-card compact ${me?.skill === skill.id ? 'on' : ''}" data-lobby-skill="${skill.id}">
        <b>${skill.name}</b>
        <span>${skill.blurb}</span>
      </button>`
  ).join('');

  const teamTools = state.isHost
    ? `<div class="setting-row">
         <span class="setting-label">队伍</span>
         <div class="chip-row">
           <button type="button" class="chip" id="lobby-team-less" ${teamCount <= 2 ? 'disabled' : ''}>− 减队</button>
           <span class="lobby-team-count">${teamCount} 队</span>
           <button type="button" class="chip" id="lobby-team-more" ${teamCount >= 6 ? 'disabled' : ''}>+ 加队</button>
           <button type="button" class="chip" id="lobby-auto-teams">自动分队</button>
           <button type="button" class="chip" id="lobby-fill-teams" ${emptyTeams.length ? '' : 'disabled'}>补齐空队</button>
         </div>
       </div>
       ${
         emptyTeams.length
           ? `<p class="tune-hint lobby-warn">${
               emptyTeams.map((index) => TEAM_NAMES[index] ?? `第${index + 1}队`).join('、')
             }还没有人，开始对局前每队至少要有 1 人。</p>`
           : ''
       }`
    : '';

  const ruleButtons = state.isHost
    ? `
      <div class="setting-row">
        <span class="setting-label">玩法</span>
        <div class="segmented">
          <button type="button" data-lobby-mode="ffa" class="${state.mode === 'ffa' ? 'on' : ''}">乱斗</button>
          <button type="button" data-lobby-mode="team" class="${state.mode === 'team' ? 'on' : ''}">分队</button>
        </div>
      </div>
      ${state.mode === 'team' ? teamTools : ''}
      <div class="setting-row">
        <span class="setting-label">结束方式</span>
        <div class="chip-row">
          ${(['kills', 'time', 'both'] as const)
            .map(
              (kind) =>
                `<button type="button" class="chip ${state.match.winCondition === kind ? 'on' : ''}" data-lobby-win="${kind}">${
                  kind === 'kills' ? '打到人头' : kind === 'time' ? '时间到' : '两者任一'
                }</button>`
            )
            .join('')}
        </div>
      </div>
      <div class="setting-row">
        <span class="setting-label">人头目标</span>
        <div class="chip-row">
          ${KILL_TARGET_CHOICES.map(
            (value) =>
              `<button type="button" class="chip ${state.match.killTarget === value ? 'on' : ''}" data-lobby-kills="${value}">${
                value === 0 ? '不限' : `${value} 杀`
              }</button>`
          ).join('')}
        </div>
      </div>
      <div class="setting-row">
        <span class="setting-label">时间上限</span>
        <div class="chip-row">
          ${TIME_LIMIT_CHOICES.map(
            (value) =>
              `<button type="button" class="chip ${state.match.timeLimit === value ? 'on' : ''}" data-lobby-time="${value}">${
                value === 0 ? '不限时' : `${value / 60} 分钟`
              }</button>`
          ).join('')}
        </div>
      </div>
      <div class="setting-row">
        <span class="setting-label">伤害开关</span>
        <div class="toggle-row">
          <button type="button" class="chip ${state.match.friendlyFire ? 'on' : ''}" data-lobby-ff="${state.match.friendlyFire ? 0 : 1}">友伤：${state.match.friendlyFire ? '开' : '关'}</button>
          <button type="button" class="chip ${state.match.selfDamage ? 'on' : ''}" data-lobby-sd="${state.match.selfDamage ? 0 : 1}">自伤：${state.match.selfDamage ? '开' : '关'}</button>
        </div>
      </div>`
    : `<p class="lan-hint">规则由房主设置，进对局前会同步给你。</p>`;

  return `
    <div class="kicker">Room · ${state.roster.length}/${state.capacity}</div>
    <h1>房间<span class="accent">!</span></h1>
    <p class="lan-lead">${
      state.isHost
        ? '把房间地址发给朋友；选技能（别人看不到）、分好队伍、都准备好后点「开始对局」。'
        : '等人齐；选好你的技能（别人看不到）后点「准备」，房主开始对局。'
    }</p>
    ${state.roomUrl ? `<div class="lobby-url">房间地址 <b>${state.roomUrl}</b></div>` : ''}
    ${lobbyMapBlock(state)}
    <div class="lobby-seats">${seatCards || '<p class="lan-hint">还没有人加入…</p>'}</div>
    <div class="setting-block">
      <div class="setting-head">
        <span class="setting-label">你的技能</span>
        <span class="setting-hint">只有你自己看得到；对手只会在对局里吃到它</span>
      </div>
      <div class="skill-cards">${mySkills}</div>
    </div>
    ${ruleButtons}
    ${tuningPanelHtml(!state.isHost)}
    <div class="actions">
      ${
        state.isHost
          ? `<button class="primary" id="lobby-start" ${
              emptyTeams.length || (state.map?.custom && !state.map.synced) ? 'disabled' : ''
            }>开始对局</button>`
          : `<button class="primary" id="lobby-ready">${me?.ready ? '取消准备' : '准备'}</button>`
      }
      <button class="ghost" id="lobby-leave">离开房间</button>
      <span class="hint">${readyCount}/${state.roster.length} 已准备</span>
    </div>
    ${
      emptyTeams.length && state.isHost
        ? '<div class="tip"><span class="dot"></span> 每支队伍至少要有 1 人才能开始（点「补齐空队」最快）。</div>'
        : ''
    }
  `;
}

/** One tidy row: which map the room plays and whether everyone has it yet. */
function lobbyMapBlock(state: Extract<OverlayState, { kind: 'lobby' }>): string {
  const map = state.map;
  if (!map) return '';
  const needSync = map.custom && map.total > 0;
  const progress = needSync
    ? state.isHost
      ? `地图确认 ${map.ready}/${map.total}`
      : map.synced
        ? '地图已同步'
        : '正在接收地图…'
    : '';
  const tone = !needSync || map.synced ? 'map-ok' : 'map-wait';
  return `
    <div class="lobby-map ${tone}">
      <span class="lobby-map-label">地图</span>
      <b class="lobby-map-name">${escapeHtml(map.name)}</b>
      <span class="lobby-map-tag">${map.custom ? '房主自建' : '内置'}</span>
      ${progress ? `<span class="lobby-map-sync">${escapeHtml(progress)}</span>` : ''}
      ${
        state.isHost && needSync && !map.synced
          ? '<button type="button" class="chip tiny" id="lobby-map-resend">重发地图</button>'
          : ''
      }
    </div>`;
}

function bindLobby(root: HTMLElement, state: Extract<OverlayState, { kind: 'lobby' }>): void {
  const scene = gameScene();
  if (!scene) return;
  const repaint = () => render({ ...state, roster: state.roster });

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-skill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      const id = btn.dataset.lobbySkill;
      if (!id || !isSkillId(id)) return;
      scene.setMySkill(id);
      state.roster = state.roster.map((seat) => (seat.id === state.myId ? { ...seat, skill: id } : seat));
      repaint();
    });
  });

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-team]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.isHost) return;
      sound.ui();
      const id = btn.dataset.lobbyId;
      const team = Number(btn.dataset.lobbyTeam ?? 0);
      if (id) scene.setTeamOf(id, team);
      state.roster = state.roster.map((seat) => (seat.id === id ? { ...seat, team } : seat));
      repaint();
    });
  });

  root.querySelector<HTMLButtonElement>('#lobby-map-resend')?.addEventListener('click', () => {
    sound.ui();
    scene.resendRoomMap();
  });

  root.querySelector<HTMLButtonElement>('#lobby-auto-teams')?.addEventListener('click', () => {
    sound.ui();
    scene.autoTeams();
  });

  root.querySelector<HTMLButtonElement>('#lobby-fill-teams')?.addEventListener('click', () => {
    sound.ui();
    scene.fillTeams();
  });

  root.querySelector<HTMLButtonElement>('#lobby-team-more')?.addEventListener('click', () => {
    sound.ui();
    scene.setTeamCount((state.teams ?? 2) + 1);
    state.teams = (state.teams ?? 2) + 1;
    repaint();
  });

  root.querySelector<HTMLButtonElement>('#lobby-team-less')?.addEventListener('click', () => {
    sound.ui();
    const next = Math.max(2, (state.teams ?? 2) - 1);
    scene.setTeamCount(next);
    state.teams = next;
    // Seats on a removed team fall back to the last remaining one.
    state.roster = state.roster.map((seat) => ({ ...seat, team: Math.min(seat.team, next - 1) }));
    repaint();
  });

  // The room doubles as the internal-test bench: the host can tune every number
  // here and it ships with the room config; guests see it read-only.
  bindTuningPanel(root, () => {
    scene.applyRoomConfig(state.match);
    window.dispatchEvent(new Event('tankgame:rerender'));
  });

  const setMatch = (patch: Partial<typeof state.match>) => {
    state.match = { ...state.match, ...patch };
    scene.applyRoomConfig(state.match);
    repaint();
  };
  root.querySelectorAll<HTMLButtonElement>('[data-lobby-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      setMatch({ mode: btn.dataset.lobbyMode === 'team' ? 'team' : 'ffa' });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-lobby-win]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      setMatch({ winCondition: (btn.dataset.lobbyWin ?? 'both') as 'kills' | 'time' | 'both' });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-lobby-kills]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      setMatch({ killTarget: Number(btn.dataset.lobbyKills ?? 0) });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-lobby-time]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      setMatch({ timeLimit: Number(btn.dataset.lobbyTime ?? 0) });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-lobby-ff]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      setMatch({ friendlyFire: btn.dataset.lobbyFf === '1' });
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-lobby-sd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.ui();
      setMatch({ selfDamage: btn.dataset.lobbySd === '1' });
    });
  });

  root.querySelector<HTMLButtonElement>('#lobby-ready')?.addEventListener('click', () => {
    sound.ui();
    const me = state.roster.find((seat) => seat.id === state.myId);
    const next = !me?.ready;
    scene.setReady(next);
    state.roster = state.roster.map((seat) => (seat.id === state.myId ? { ...seat, ready: next } : seat));
    repaint();
  });

  root.querySelector<HTMLButtonElement>('#lobby-start')?.addEventListener('click', () => {
    sound.ui();
    // Everyone has to be ready – the host waits instead of yanking people in.
    const waiting = state.roster.filter((seat) => !seat.ready && !seat.host);
    if (waiting.length) {
      window.alert(`还有 ${waiting.length} 人没准备：${waiting.map((seat) => seat.name).join('、')}`);
      return;
    }
    // ...and every team needs at least one player.
    if (state.mode === 'team') {
      const empty = scene.emptyTeams();
      if (empty.length) {
        window.alert(
          `${empty.map((index) => TEAM_NAMES[index] ?? `第${index + 1}队`).join('、')}还没有人，每队至少 1 人才能开始。`
        );
        return;
      }
    }
    scene.startRoomMatch();
  });

  root.querySelector<HTMLButtonElement>('#lobby-leave')?.addEventListener('click', () => {
    sound.ui();
    scene.quitMatch();
  });
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

  // The editor needs the full card width; every other screen stays narrow.
  card.classList.toggle('wide', next.kind === 'mapEditor');

  if (next.kind === 'mapEditor') {
    card.innerHTML = '';
    const host = document.createElement('div');
    card.appendChild(host);
    new MapEditor(host, next.map, {
      onSave: (map) => {
        // Saving keeps this editing session alive: no re-render, no lost undo.
        const saved = saveMap(map);
        if (saved) {
          refreshLevels();
          settings.mapId = saved.id;
        }
        return saved;
      },
      onSaveCopy: (map) => {
        // A copy gets a fresh id and name, so the original stays intact.
        const copy = saveMap({ ...map, id: newMapId(), rev: 1, name: `${map.name} 副本` });
        if (copy) refreshLevels();
        return copy;
      },
      onDelete: (map) => {
        if (!window.confirm(`删除「${map.name}」？`)) return;
        deleteMap(map.id);
        refreshLevels();
        if (settings.mapId === map.id) settings.mapId = 'random';
        render({ kind: 'start' });
      },
      onPlay: (map) => {
        settings.mapId = map.id;
        startMatch();
      },
      onExport: (map) => downloadMap(map),
      onClose: () => render({ kind: 'start' }),
    });
    return;
  }

  if (next.kind === 'lobby') {
    card.innerHTML = lobbyHtml(next);
    bindLobby(card, next);
    return;
  }

  if (next.kind === 'start') {
    const mapName = settings.mapId === 'random' ? '随机地图' : levelById(settings.mapId).name;
    card.innerHTML = `
      <div class="kicker">Sketch Tank · Ricochet · v${APP_VERSION}</div>
      <h1>坦克大作战<span class="accent">!</span></h1>
      ${DOODLE}
      <div class="rule"></div>
      <p>子弹碰到任何墙壁都会<strong>反弹</strong>——包括你自己的炮弹。地上散落的道具碰到就吃，想不想吃由不得你。</p>
      ${settingsPanel()}
      ${customMapsPanel()}
      <div id="controls-host">${controlsForMode()}</div>
      <div class="actions">
        <button class="primary" id="btn-start">开始游戏</button>
        <span class="hint">或按 Enter</span>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
        <button class="ghost" id="btn-tuning" title="内测参数（需要密码）">内测</button>
      </div>
      ${tuningPanelHtml(settings.mode === 'lan' && settings.lanRole === 'guest')}
      <div class="tip"><span class="dot"></span> ${
        settings.mode === 'lan'
          ? settings.lanRole === 'host'
            ? '联机：开好后把房间地址发给朋友（浏览器直接打开即可）· 2–10 人，各 100 血'
            : '联机：填房主地址，或点「扫描局域网房间」自动找到 · 2–10 人，各 100 血'
          : settings.mode === 'versus'
            ? `双人：各 100 血，先被打空的一方输 · 当前地图 ${mapName}`
            : `单人：100 血对抗 AI（${DIFFICULTIES[settings.difficulty].label}），从「${mapName}」开始连打 5 关`
      }</div>
    `;
    bindSettings(card);
    bindTuningPanel(card, () => {
      // Balance changed: refresh the mode label / tip without losing focus.
      window.dispatchEvent(new Event('tankgame:rerender'));
    });
    card.querySelector<HTMLButtonElement>('#btn-tuning')?.addEventListener('click', () => {
      const body = card.querySelector<HTMLElement>('#tuning-body');
      if (body && body.hidden) card.querySelector<HTMLButtonElement>('#tuning-toggle')?.click();
      else card.querySelector<HTMLElement>('#tuning-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  } else if (next.kind === 'paused') {
    card.innerHTML = `
      <div class="kicker">Paused</div>
      <h1>暂停中</h1>
      <div class="rule"></div>
      <p>绿色虚线是真实的反弹路径，拐角上的小圈就是反弹点。</p>
      ${keyEditor()}
      <div class="actions">
        <button class="primary" id="btn-resume">继续</button>
        <button id="btn-restart">重新开始</button>
        <button class="ghost" id="btn-quit">退出对局</button>
        <button class="ghost" id="btn-mute">${sound.muted ? '取消静音' : '静音'}</button>
        <button class="ghost" id="btn-tuning">内测</button>
      </div>
      ${tuningPanelHtml(settings.mode === 'lan' && settings.lanRole === 'guest')}
      <div class="tip"><span class="dot"></span> 按 P 或 Esc 继续 · 退出对局会直接结束这一局${settings.mode === 'lan' ? '，对手会看到「你已经投降」' : ''}</div>
    `;
    bindKeyEditor(card);
    bindTuningPanel(card, () => window.dispatchEvent(new Event('tankgame:rerender')));
    card.querySelector<HTMLButtonElement>('#btn-tuning')?.addEventListener('click', () => {
      const body = card.querySelector<HTMLElement>('#tuning-body');
      if (body) body.hidden = !body.hidden;
    });
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
      <p>五关全部清空。想再难一点的话，去菜单换成「困难」试试。</p>
      <div class="stateline"><span>总得分 <b>${next.score}</b></span></div>
      <div class="actions">
        <button class="primary" id="btn-restart">再来一局</button>
        <button id="btn-menu">返回菜单</button>
      </div>
    `;
  } else if (next.kind === 'matchOver') {
    const rows = next.scoreboard
      .slice()
      .sort((a, b) => b.kills - a.kills)
      .map(
        (line, index) => `
        <div class="score-row ${next.winners.includes(line.id) ? 'winner' : ''}">
          <span class="rank">${index + 1}</span>
          <span class="name">${line.name}</span>
          <span class="kills">${line.kills} 杀</span>
          <span class="deaths">${line.deaths} 死</span>
        </div>`
      )
      .join('');
    const title = next.draw
      ? '平局'
      : next.surrenderBy
        ? `${next.scoreboard.find((l) => l.id === next.surrenderBy)?.name ?? '对手'} 已经投降`
        : `${next.winners
            .map((id) => next.scoreboard.find((l) => l.id === id)?.name ?? id)
            .join(' / ')} 获胜`;
    const reason = next.draw ? '时间到，双方人头相同' : next.reason === 'kills' ? '达到人头目标' : next.reason === 'time' ? '时间到，人头领先' : '对手退出对局，本局判为投降';
    card.innerHTML = `
      <div class="kicker">Match Over</div>
      <h1>${title}<span class="accent">${next.draw ? '' : '!'}</span></h1>
      <div class="rule"></div>
      <p>${reason}</p>
      <div class="scoreboard">${rows}</div>
      <div class="actions">
        <button class="primary" id="btn-restart">再来一局</button>
        <button id="btn-menu">返回菜单</button>
      </div>
    `;
  } else if (next.kind === 'versusOver') {
    const p1Wins = next.winner === 'p1';
    card.innerHTML = `
      <div class="kicker">Versus</div>
      <h1><span class="${p1Wins ? 'p1' : 'p2'}">${p1Wins ? 'P1' : 'P2'}</span> 获胜<span class="accent">!</span></h1>
      <div class="rule"></div>
      <p>${p1Wins ? 'P1' : 'P2'} 把对手的血打空了。</p>
      <div class="stateline">
        <span class="p1">P1 剩余血量 <b>${next.p1Lives}</b></span>
        <span class="p2">P2 剩余血量 <b>${next.p2Lives}</b></span>
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
    gameScene()?.quitMatch();
    game.scene.stop('Game');
    game.scene.start('Menu');
    render({ kind: 'start' });
  });

  // "退出对局" in the pause menu: solo/versus just end, LAN reports a surrender
  // and the opponent sees it in their own match-over screen.
  document.getElementById('btn-quit')?.addEventListener('click', () => {
    sound.ui();
    gameScene()?.quitMatch();
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

game.events.once(Phaser.Core.Events.READY, () => {
  render({ kind: 'start' });
  void initUpdater();
});
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
  // F9: the internal balance panel, from the menu or from a paused match.
  if (event.key === 'F9') {
    event.preventDefault();
    if (state.kind === 'start' || state.kind === 'paused') {
      const body = document.querySelector<HTMLElement>('#tuning-body');
      if (body && body.hidden) document.querySelector<HTMLButtonElement>('#tuning-toggle')?.click();
      body?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return;
  }
  if (state.kind !== 'start') return;
  if (document.querySelector('.key-btn.capturing')) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    document.getElementById('btn-start')?.click();
  }
});

// The updater panel asks for a repaint instead of re-rendering itself.
window.addEventListener('tankgame:rerender', () => {
  if (state.kind === 'start') render(state);
});

// Unlock audio on the first interaction (browsers require a gesture).
window.addEventListener('pointerdown', () => sound.resume(), { once: true });
window.addEventListener('keydown', () => sound.resume(), { once: true });

export { settings, defaultBindings };
