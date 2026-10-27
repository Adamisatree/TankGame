/**
 * "更新与版本" panel.
 *
 * Works in both worlds:
 *  - desktop app: talks to the updater in the main process (download, verify,
 *    install), so one click really does update – or downgrade.
 *  - plain browser / single-file build: same list, but each version is a link
 *    that already points at the fastest mirror.
 */
import mirrorsJson from '../../mirrors.json';
import {
  applyMirror,
  classifyAsset,
  compareVersions,
  formatBytes,
  OFFICIAL,
  isNewer,
  type AssetInfo,
  type Manifest,
  type Mirror,
  type ReleaseInfo,
} from '../../shared/update-core.mjs';
import { raceManifestFetch } from '../../shared/fetch-manifest.mjs';
import type { LocalVersion } from './types';
import { APP_VERSION } from '../version';
import { sound } from '../game/Sound';

const MIRRORS: Mirror[] = mirrorsJson.mirrors ?? [];
const RAW_MIRRORS: Mirror[] = mirrorsJson.rawMirrors ?? [];
const STORAGE_KEY = 'tankgame.update.mirror';

// The single-file build can be opened straight from disk, where some browsers
// refuse localStorage entirely. A stuck mirror choice is not worth crashing over.
function readStoredMirror(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeMirror(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* opaque origin: keep the choice for this session only */
  }
}

interface State {
  info: { version: string; platform: string; arch: string; mirrorId: string; autoCheck: boolean } | null;
  manifest: Manifest | null;
  source: string;
  errors: string[];
  checking: boolean;
  checkingSlow: boolean;
  probe: Record<string, number | null>;
  downloading: string;
  progress: number;
  message: string;
  error: string;
  expanded: boolean;
  browserMirrorId: string;
  local: LocalVersion[];
}

const state: State = {
  info: null,
  manifest: null,
  source: '',
  errors: [],
  checking: false,
  checkingSlow: false,
  probe: {},
  downloading: '',
  progress: 0,
  message: '',
  error: '',
  expanded: false,
  browserMirrorId: readStoredMirror(),
  local: [],
};

const bridge = () => window.tankGame?.update ?? null;

export const currentVersion = (): string => state.info?.version ?? APP_VERSION;

function mirrorById(id: string): Mirror | null {
  return MIRRORS.find((m) => m.id === id) ?? null;
}

/** Fastest mirror from the last probe, else the user's pick, else the first. */
function preferredMirror(): Mirror | null {
  const pinned = mirrorById(state.browserMirrorId);
  if (pinned) return pinned;
  const ranked = Object.entries(state.probe)
    .filter(([, ms]) => typeof ms === 'number' && ms > 0)
    .sort((a, b) => (a[1] as number) - (b[1] as number));
  return ranked.length ? mirrorById(ranked[0][0]) : MIRRORS[0] ?? null;
}

function downloadUrl(asset: AssetInfo, mirror: Mirror | null, version?: string): string {
  const url = asset.url || `${OFFICIAL.releaseDownload}/v${version ?? ''}/${asset.name}`;
  return mirror ? applyMirror(url, mirror) : url;
}

/** Plain-HTML fallback: the same race, run in the browser. */
async function fetchManifestInBrowser(): Promise<{ manifest: Manifest; label: string } | null> {
  const candidates = [
    ...RAW_MIRRORS.map((m) => ({ id: m.id, label: m.label, url: `${m.prefix}main/updates.json` })),
    ...MIRRORS.map((m) => ({ id: m.id, label: `${m.label} · API`, url: applyMirror(OFFICIAL.releasesApi, m) })),
    { id: 'direct', label: 'github.com（直连）', url: OFFICIAL.releasesApi },
  ];
  const result = await raceManifestFetch(candidates, { graceMs: 1200 });
  return result.manifest ? { manifest: result.manifest, label: result.source?.label ?? '镜像' } : null;
}

/**
 * v1.6.2: everything in a manifest is remote input. The panel pasted version
 * numbers, asset names, digests and dates straight into `innerHTML`, so a
 * mirror (or anything that can answer as one) could put a `<script>` in the
 * update list — and from the desktop shell that chain ends at "run this exe".
 * Escape every value that comes off the wire.
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function releaseRow(release: ReleaseInfo): string {
  const isCurrent = compareVersions(release.version, currentVersion()) === 0;
  const newer = isNewer(release.version, currentVersion());
  const asset = pickForThisMachine(release);
  const html = release.assets.find((a) => classifyAsset(a.name).kind === 'html');
  const date = release.publishedAt ? esc(String(release.publishedAt).slice(0, 10)) : '';
  const size = asset ? formatBytes(asset.size) : '';
  if (!state.browserMirrorId && MIRRORS[0]) state.browserMirrorId = MIRRORS[0].id;
  const mirror = preferredMirror();
  const tag = isCurrent ? '<span class="ver-tag now">当前</span>' : newer ? '<span class="ver-tag new">新版</span>' : '<span class="ver-tag old">旧版</span>';

  return `
    <div class="ver-row ${isCurrent ? 'is-current' : ''}">
      <div class="ver-main">
        <b>v${esc(release.version)}</b>${tag}
        <span class="ver-meta">${date}${size ? ` · ${esc(size)}` : ''}${asset ? ` · ${esc(asset.name)}` : ''}</span>
      </div>
      <div class="ver-actions">
        ${
          asset && !isCurrent
            ? `<button type="button" class="chip" data-ver-download="${esc(release.version)}" data-asset="${esc(asset.name)}" data-sha="${esc(asset.sha256 ?? '')}" data-size="${esc(asset.size)}">
                 ${bridge() ? '下载并安装' : '下载'}
               </button>`
            : ''
        }
        ${
          html
            ? `<a class="chip" href="${esc(downloadUrl(html, mirror, release.version))}" target="_blank" rel="noreferrer">网页版</a>`
            : ''
        }
        ${
          !asset && !isCurrent
            ? `<span class="ver-note" title="这个版本没有适合当前系统的安装包，可以先用网页版或到发布页手动下载">本机无对应安装包</span>`
            : ''
        }
        <a class="chip ghost" href="${esc(`${OFFICIAL.releasePage}/tag/v${release.version}`)}" target="_blank" rel="noreferrer">发布页</a>
      </div>
    </div>`;
}

function pickForThisMachine(release: ReleaseInfo): AssetInfo | null {
  const platform = state.info?.platform ?? guessPlatform();
  const arch = state.info?.arch ?? guessArch();
  const scored = release.assets
    .map((asset) => {
      const meta = classifyAsset(asset.name);
      let score = -1;
      if (meta.platform !== platform) return { asset, score };
      if (platform === 'win32') {
        if (meta.kind === 'installer' && meta.arch === arch) score = 100;
        else if (meta.kind === 'installer' && meta.arch === 'any') score = 90;
        else if (meta.kind === 'portable' && meta.arch === arch) score = 70;
      } else if (platform === 'darwin') {
        if (meta.kind === 'dmg' && meta.arch === arch) score = 100;
        else if (meta.kind === 'zip' && meta.arch === arch) score = 80;
        else if (meta.kind === 'dmg' && meta.arch === 'any') score = 70;
      }
      return { asset, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.asset ?? null;
}

function guessPlatform(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'win32';
  if (ua.includes('mac')) return 'darwin';
  return 'linux';
}

function guessArch(): string {
  const ua = navigator.userAgent.toLowerCase();
  return /arm64|aarch64/.test(ua) ? 'arm64' : 'x64';
}

function compareSummary(): string {
  if (!state.manifest) return '';
  const latest = state.manifest.releases.find((r) => !r.prerelease) ?? state.manifest.releases[0];
  if (!latest) return '';
  if (isNewer(latest.version, currentVersion())) return `发现新版本 v${esc(latest.version)}`;
  if (compareVersions(latest.version, currentVersion()) === 0) return '已是最新版本';
  return `你用的是较新的版本（线上最新 v${esc(latest.version)}）`;
}

export function updaterPanelHtml(): string {
  const version = currentVersion();
  const desktop = !!bridge();
  if (!state.browserMirrorId && MIRRORS[0]) state.browserMirrorId = MIRRORS[0].id;
  const mirror = preferredMirror();
  const mirrorOptions = MIRRORS.map(
    (m) => `<option value="${m.id}" ${m.id === state.browserMirrorId ? 'selected' : ''}>${m.label}</option>`
  ).join('');
  const probeText = Object.entries(state.probe)
    .map(([id, ms]) => `${id === mirror?.id ? '★' : ''}${id}:${ms === null ? '×' : `${ms}ms`}`)
    .join(' ');

  return `
    <details class="updater" ${state.expanded ? 'open' : ''}>
      <summary>
        更新与版本 <span class="ver-current">v${version}</span>
        ${state.message ? `<span class="ver-badge">${esc(state.message)}</span>` : ''}
      </summary>

      <div class="upd-row">
        <button type="button" class="chip" data-upd-check ${state.checking ? 'disabled' : ''}>
          ${state.checking ? '检查中…' : '检查更新'}
        </button>
        <button type="button" class="chip" data-upd-probe ${desktop ? '' : 'disabled'}>镜像测速</button>
        <label class="upd-mirror">
          下载线路
          <select data-upd-mirror>
            <option value="">自动（选最快）</option>
            ${mirrorOptions}
          </select>
        </label>
        ${
          desktop
            ? `<label class="upd-mirror">
                 <input type="checkbox" data-upd-auto ${state.info?.autoCheck === false ? '' : 'checked'} />
                 启动时自动检查
               </label>`
            : ''
        }
      </div>

      <div class="upd-status">
        ${state.checkingSlow ? '<span class="lan-loading">正在从镜像获取版本列表…</span>' : ''}
        ${state.manifest ? `<span>${compareSummary()} · 列表来源 ${esc(state.source || '缓存')}</span>` : ''}
        ${state.error ? `<span class="upd-error">${esc(state.error)}</span>` : ''}
        ${probeText ? `<span class="upd-probe">测速：${esc(probeText)}</span>` : ''}
      </div>

      ${
        state.downloading
          ? `<div class="upd-progress"><div class="bar" style="width:${Math.round(state.progress * 100)}%"></div>
               <span>${esc(state.downloading)} ${Math.round(state.progress * 100)}%</span></div>`
          : ''
      }

      <div class="ver-list">
        ${
          state.manifest
            ? state.manifest.releases.slice(0, 12).map(releaseRow).join('')
            : '<span class="lan-loading">还没检查。点「检查更新」，或者直接在下方按版本号下载。</span>'
        }
      </div>

      ${
        state.local.length
          ? `<div class="ver-list local">
               <span class="ver-subtitle">本机已下载的版本（换回来不用重新下）</span>
               ${state.local
                 .map(
                   (entry) => `
                 <div class="ver-row">
                   <div class="ver-main">
                     <b>v${entry.version}</b>
                     <span class="ver-meta">${formatBytes(entry.size)} · ${entry.assets[0]?.name ?? ''}</span>
                   </div>
                   <div class="ver-actions">
                     <button type="button" class="chip" data-ver-install="${entry.assets[0]?.path ?? ''}">安装</button>
                   </div>
                 </div>`
                 )
                 .join('')}
             </div>`
          : ''
      }

      <p class="lan-hint">
        ${
          desktop
            ? '桌面版会自动下载、校验 SHA-256，然后静默安装并重启。装回旧版本也一样：选一个旧版本下载安装即可。'
            : '浏览器里没法自动覆盖安装，点「下载」会走上面选的镜像线路拿安装包（国内直连 GitHub 很慢，镜像会快很多）。'
        }
        中国网络建议用镜像；镜像偶尔会挂，程序会自动换下一个，也可以手动选。
      </p>

      <p class="lan-hint">
        ⚠️ 局域网联机要求两边版本一致：房主和访客的版本号不同会被直接拒绝并提示，避免打一半不同步。
      </p>
    </details>
  `;
}

let progressBound = false;

/** Binds the panel's buttons. Called after each render of the start menu. */
export function bindUpdaterPanel(root: HTMLElement): void {
  const panel = root.querySelector('.updater');
  if (!panel) return;

  panel.addEventListener('toggle', () => {
    state.expanded = (panel as HTMLDetailsElement).open;
    if (state.expanded) void refreshLocal();
  });

  root.querySelector<HTMLSelectElement>('[data-upd-mirror]')?.addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    state.browserMirrorId = value;
    storeMirror(value);
    void bridge()?.saveSettings({ mirrorId: value });
    sound.ui();
    rerender();
  });

  root.querySelectorAll<HTMLElement>('[data-ver-install]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const api = bridge();
      const filePath = btn.dataset.verInstall ?? '';
      if (!api || !filePath) return;
      state.message = '正在安装本地已下载的版本…';
      rerender();
      void api.installFile({ path: filePath }).then((installed) => {
        if (!installed.ok) state.error = installed.error ?? '安装失败';
        else if (installed.mode === 'manual') state.message = '安装包已打开，拖进 Applications 覆盖即可。';
        rerender();
      });
    });
  });

  root.querySelector('[data-upd-check]')?.addEventListener('click', () => void checkNow(true));

  root.querySelector<HTMLInputElement>('[data-upd-auto]')?.addEventListener('change', (event) => {
    // Desktop only: the main process schedules the checks, so it owns the flag.
    const autoCheck = (event.target as HTMLInputElement).checked;
    if (state.info) state.info.autoCheck = autoCheck;
    void bridge()?.saveSettings({ autoCheck });
  });
  root.querySelector('[data-upd-probe]')?.addEventListener('click', () => void probeNow());

  root.querySelectorAll<HTMLElement>('[data-ver-download]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const version = btn.dataset.verDownload ?? '';
      const assetName = btn.dataset.asset ?? '';
      const sha = btn.dataset.sha && btn.dataset.sha !== 'undefined' ? btn.dataset.sha : '';
      const size = Number(btn.dataset.size ?? 0);
      const asset = state.manifest?.releases
        .find((r) => r.version === version)
        ?.assets.find((a) => a.name === assetName);

      const api = bridge();
      if (!api) {
        // Browser: hand the file to the browser through the chosen mirror.
        if (asset) window.open(downloadUrl(asset, preferredMirror(), version), '_blank', 'noreferrer');
        return;
      }
      void api.download({ version, assetName, url: asset?.url, sha256: sha, size }).then((result) => {
        if (!result.ok) {
          state.error = `下载失败：${(result.errors ?? []).slice(-2).join(' / ')}`;
          state.downloading = '';
          rerender();
          return;
        }
        state.downloading = '';
        state.progress = 1;
        void refreshLocal().then(rerender);
        // A package the manifest gives no digest for cannot be checked. Ask,
        // instead of quietly installing whatever the mirror sent (D2).
        if (result.verified === false) {
          const ok = window.confirm(
            `v${version} 的安装包没有官方校验值（清单里没有 sha256），无法确认它没被改过。\n仍然要运行它吗？`
          );
          if (!ok) {
            state.message = '已停在下载完成这一步：安装包留在本机版本库里，没有运行。';
            rerender();
            return;
          }
        }
        state.message = result.cached ? '这个版本本机已有，直接安装…' : '下载完成，正在安装…';
        rerender();
        void api.install({ allowUnverified: result.verified === false }).then((installed) => {
          if (!installed.ok) {
            state.error = installed.error === 'unverified' ? '安装包没有校验值，安装已取消' : (installed.error ?? '安装失败');
            rerender();
          } else if (installed.mode === 'manual') {
            state.message = '安装包已打开，把它拖进 Applications 覆盖旧版即可。';
            rerender();
          }
        });
      });
      state.downloading = assetName;
      state.progress = 0;
      state.error = '';
      rerender();
    });
  });

  if (!progressBound) {
    progressBound = true;
    bridge()?.onProgress((payload) => {
      state.progress = payload.total ? payload.ratio : Math.min(0.99, payload.received / (200 * 1024 * 1024));
      state.downloading = payload.assetName;
      const bar = document.querySelector<HTMLElement>('.upd-progress .bar');
      const label = document.querySelector<HTMLElement>('.upd-progress span');
      if (bar) bar.style.width = `${Math.round(state.progress * 100)}%`;
      if (label) label.textContent = `${payload.assetName} ${Math.round(state.progress * 100)}%`;
    });
    bridge()?.onProbe((entry) => {
      state.probe[entry.id] = entry.ms;
      const line = document.querySelector<HTMLElement>('.upd-probe');
      if (line) {
        line.textContent = `测速：${Object.entries(state.probe)
          .map(([id, ms]) => `${id === preferredMirror()?.id ? '★' : ''}${id}:${ms === null ? '×' : `${ms}ms`}`)
          .join(' ')}`;
      }
    });
    bridge()?.onAvailable((payload) => {
      state.message = `有新版本 v${payload.version}`;
      state.expanded = true;
      if (document.getElementById('card')?.childElementCount) rerender();
    });
  }
}

async function refreshLocal(): Promise<void> {
  const api = bridge();
  if (!api) return;
  try {
    const result = await api.localVersions();
    state.local = result.versions;
  } catch {
    state.local = [];
  }
}

function rerender(): void {
  // The menu owns rendering; ask it to repaint the same state.
  window.dispatchEvent(new CustomEvent('tankgame:rerender'));
}

export async function checkNow(manual = false): Promise<void> {
  if (state.checking) return;
  state.checking = true;
  state.error = '';
  state.checkingSlow = true;
  if (manual) state.expanded = true;
  rerender();

  const api = bridge();
  try {
    if (api) {
      const info = await api.info();
      state.info = { ...info, platform: info.platform, arch: info.arch };
      const result = await api.check();
      if (!result.ok || !result.manifest) {
        state.error = `检查失败（${(result.errors ?? []).slice(-2).join(' / ') || '网络不通'}）`;
      } else {
        state.manifest = result.manifest;
        state.source = result.source?.label ?? '镜像';
        state.message = result.upToDate ? '' : `有新版本 v${result.latest?.version}`;
        state.errors = result.errors ?? [];
      }
    } else {
      const found = await fetchManifestInBrowser();
      if (!found) state.error = '检查失败：镜像和 GitHub 都没连上，稍后再试或手动下载。';
      else {
        state.manifest = found.manifest;
        state.source = found.label;
      }
    }
  } catch (err) {
    state.error = `检查失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    state.checking = false;
    state.checkingSlow = false;
    rerender();
  }
}

async function probeNow(): Promise<void> {
  const api = bridge();
  if (!api) return;
  state.message = '正在测速…';
  rerender();
  try {
    const result = await api.probeMirrors();
    for (const entry of result.ranked) state.probe[entry.id] = entry.ms;
    const best = result.ranked.find((e) => e.ms !== null);
    state.message = best ? `最快线路：${best.label}（${best.ms}ms）` : '所有镜像都没响应，将走直连';
  } catch {
    state.message = '测速失败';
  }
  rerender();
}

/** Called once at startup: refresh the version and quietly look for updates. */
export async function initUpdater(): Promise<void> {
  const api = bridge();
  if (api) {
    try {
      const info = await api.info();
      state.info = info;
      state.browserMirrorId = info.mirrorId || state.browserMirrorId;
      await refreshLocal();
      rerender();
      if (info.autoCheck) void checkNow(false);
      return;
    } catch {
      /* fall through to browser mode */
    }
  }
  rerender();
}
