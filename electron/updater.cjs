/**
 * Auto-update / version switcher for the desktop build.
 *
 * Deliberately not electron-updater: the whole point here is to download from
 * a *mirror* (Chinese networks reach github.com very slowly), to let the player
 * pick any version – including older ones – and to verify what arrived.
 *
 * Network order: jsDelivr CDN for the manifest, then GitHub proxy mirrors, then
 * github.com itself. Every step falls through to the next candidate on failure.
 */
const { app, shell } = require('electron');
const { createHash } = require('node:crypto');
const { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const MIRRORS_FILE = join(__dirname, '..', 'mirrors.json');
const TIMEOUT_MS = 12000;

/** @type {typeof import('../shared/update-core.mjs') | null} */
let core = null;
async function loadCore() {
  if (!core) core = await import(pathToFileURL(join(__dirname, '..', 'shared', 'update-core.mjs')).href);
  return core;
}

function settingsPath() {
  return join(app.getPath('userData'), 'updater.json');
}

const defaultSettings = () => ({
  autoCheck: true,
  mirrorId: '', // '' = pick the fastest automatically
  lastCheckAt: 0,
  cachedManifest: null,
  skippedVersion: '',
  probeRank: [], // [{ id, ms }] from the last 镜像测速
  probeAt: 0, // when that ranking was measured (used for an hour)
});

async function readSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(await readFile(settingsPath(), 'utf8')) };
  } catch {
    return defaultSettings();
  }
}

async function writeSettings(next) {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

async function readMirrors() {
  try {
    const raw = JSON.parse(await readFile(MIRRORS_FILE, 'utf8'));
    return {
      repo: raw.repo || 'Adamisatree/TankGame',
      mirrors: Array.isArray(raw.mirrors) ? raw.mirrors : [],
      rawMirrors: Array.isArray(raw.rawMirrors) ? raw.rawMirrors : [],
    };
  } catch {
    return { repo: 'Adamisatree/TankGame', mirrors: [], rawMirrors: [] };
  }
}

// ------------------------------------------------------------------ fetching

/** Manifest candidates, most China-friendly first. */
async function manifestCandidates(settings) {
  const { OFFICIAL, urlCandidates } = await loadCore();
  const { mirrors, rawMirrors } = await readMirrors();
  const list = [];

  for (const raw of rawMirrors) {
    // Every raw mirror stores the prefix up to the point where the repo path
    // starts — `…TankGame@` for jsDelivr, `…/TankGame/` for a ghproxy raw URL —
    // so `prefix + "main/updates.json"` works for both. A prefix without either
    // tail would silently build a broken URL, so make the separator explicit (D7).
    const prefix = String(raw.prefix ?? '');
    if (!prefix) continue;
    const joined = prefix.endsWith('@') || prefix.endsWith('/') ? prefix : `${prefix}/`;
    list.push({ id: raw.id, label: raw.label, url: `${joined}main/updates.json` });
  }
  for (const candidate of urlCandidates(OFFICIAL.releasesApi, mirrors, settings.mirrorId)) {
    list.push({ ...candidate, label: `${candidate.label} · API` });
  }
  return list;
}

/**
 * Fetches the release list from every mirror in parallel and keeps the freshest.
 * Never throws: returns { manifest, source, errors, answered }.
 * @param {{ mirrorId?: string }} [options]
 */
async function fetchManifest(options = {}) {
  const settings = await readSettings();
  const merged = { ...settings, ...options };
  const candidates = await manifestCandidates(merged);
  const { raceManifestFetch } = await import(
    pathToFileURL(join(__dirname, '..', 'shared', 'fetch-manifest.mjs')).href
  );
  const result = await raceManifestFetch(candidates, { graceMs: 1500, timeoutMs: TIMEOUT_MS });
  return result;
}

/**
 * Measures each mirror and remembers the ranking for an hour, so "自动（选最快）"
 * really downloads from the fastest host instead of `mirrors.json`'s order.
 *
 * The probe targets the *release download* path (a few bytes of the newest
 * asset), not the raw manifest: those are different upstreams behind the same
 * proxy, and measuring the wrong one ranked the wrong mirror (D5/D6).
 * @param {(msg: { mirror: string, ms: number | null }) => void} [onProgress]
 */
async function probeMirrors(onProgress) {
  const { OFFICIAL, applyMirror } = await loadCore();
  const { mirrors } = await readMirrors();
  const settings = await readSettings();
  const assetUrl = newestAssetUrl(settings.cachedManifest);
  // No cached manifest yet (first run): fall back to the small raw file.
  const probeUrl = assetUrl || OFFICIAL.manifestRaw;
  const range = !!assetUrl;

  const { measureLatency } = await import(pathToFileURL(join(__dirname, '..', 'shared', 'download.mjs')).href);

  const results = await Promise.all(
    mirrors.map(async (mirror) => {
      const ms = await measureLatency(applyMirror(probeUrl, mirror), {
        timeoutMs: 6000,
        // 1 KB of the installer through the same proxy; stops at the first chunk.
        headers: range ? { range: 'bytes=0-1023' } : {},
        firstByteOnly: range,
      });
      const entry = { id: mirror.id, label: mirror.label, ms };
      onProgress?.(entry);
      return entry;
    })
  );

  const ranked = [...results].sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  await writeSettings({
    ...settings,
    probeRank: ranked.map((entry) => ({ id: entry.id, ms: entry.ms })),
    probeAt: Date.now(),
  });
  return { ranked, probeUrl, probeKind: range ? 'asset' : 'manifest', official: OFFICIAL.releasesApi };
}

/** The first download URL in a cached manifest, used as a realistic probe target. */
function newestAssetUrl(manifest) {
  const releases = Array.isArray(manifest?.releases) ? manifest.releases : [];
  for (const release of releases) {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const asset = assets.find((entry) => entry && typeof entry.url === 'string' && entry.url.startsWith('https://'));
    if (asset) return asset.url;
  }
  return '';
}

/** Candidate order honouring a fresh probe ranking (unknown/failed mirrors last). */
function rankCandidates(candidates, settings) {
  const rank = Array.isArray(settings.probeRank) ? settings.probeRank : [];
  const fresh = Number(settings.probeAt ?? 0) > Date.now() - 3600 * 1000;
  if (!fresh || !rank.length) return candidates;
  const position = new Map(rank.map((entry, index) => [entry.id, entry.ms === null ? 1e9 + index : index]));
  return [...candidates].sort(
    (a, b) => (position.get(a.id) ?? 1e8) - (position.get(b.id) ?? 1e8)
  );
}

// ------------------------------------------------------------------ download

/**
 * @param {string} url canonical github url
 * @param {string} destPath
 * @param {{ mirrorId?: string, onProgress?: (p: { received: number, total: number, url: string }) => void, expectedSha?: string }} options
 */
async function downloadWithMirrors(url, destPath, options = {}) {
  const core = await loadCore();
  const settings = await readSettings();
  const { mirrors } = await readMirrors();
  const { downloadWithFallback } = await import(
    pathToFileURL(join(__dirname, '..', 'shared', 'download.mjs')).href
  );
  const preferred = options.mirrorId || settings.mirrorId;
  let candidates = core.urlCandidates(url, mirrors, preferred);
  // When a mirror is chosen by hand, honour it. Quietly falling through to a
  // different host was why the download "was not the source I picked".
  if (preferred) candidates = candidates.filter((candidate) => candidate.id === preferred);
  else candidates = rankCandidates(candidates, settings);
  if (!candidates.length) {
    return { ok: false, path: '', sha256: '', size: 0, source: null, errors: [`所选镜像 ${preferred} 不可用，请在更新面板改为「自动」`] };
  }
  const result = await downloadWithFallback(url, destPath, {
    candidates,
    expectedSha: options.expectedSha,
    onProgress: options.onProgress,
  });
  return result;
}

/** Where downloaded installers are kept, so a version switch is instant later. */
function versionsDir() {
  return join(app.getPath('userData'), 'versions');
}

function versionFileFor(asset) {
  return join(versionsDir(), String(asset.name));
}

/**
 * Downloads unless an intact copy is already on disk. Keeps every version the
 * player has fetched, which is what makes "switch back to 1.1.0" a local copy
 * instead of another 75 MB over a slow link.
 * @param {string} url
 * @param {{ name: string, sha256?: string }} asset
 * @param {{ mirrorId?: string, onProgress?: (p: any) => void }} [options]
 */
async function ensureDownloaded(url, asset, options = {}) {
  const dest = versionFileFor(asset);
  await mkdir(versionsDir(), { recursive: true });
  try {
    const info = await stat(dest);
    if (info.size > 0) {
      const sha256 = await sha256OfFile(dest);
      if (asset.sha256 && sha256 === asset.sha256) {
        return { ok: true, path: dest, sha256, size: info.size, cached: true, verified: true, errors: [] };
      }
      if (!asset.sha256) {
        // Nothing to check the old bytes against. Keep them (re-downloading
        // would not make it any more trustworthy) but tell the caller, which
        // asks the player before launching anything (D2).
        return {
          ok: true,
          path: dest,
          sha256,
          size: info.size,
          cached: true,
          verified: false,
          errors: ['清单里没有这个安装包的 sha256，无法校验'],
        };
      }
      await rm(dest, { force: true }); // corrupt cache: fetch it again
    }
  } catch {
    /* nothing cached yet */
  }
  const result = await downloadWithMirrors(url, dest, { ...options, expectedSha: asset.sha256 });
  return { ...result, cached: false };
}

/** Every package sitting in the local version store, newest first. */
async function localVersions() {
  const core = await loadCore();
  let names = [];
  try {
    names = await readdir(versionsDir());
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (name.endsWith('.part')) continue;
    try {
      const info = await stat(join(versionsDir(), name));
      if (!info.isFile()) continue;
      files.push({ name, size: info.size, path: join(versionsDir(), name) });
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return core.groupLocalAssets(files);
}

async function sha256OfFile(path) {
  const { createReadStream } = require('node:fs');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ------------------------------------------------------------------ install

/**
 * Launches the downloaded installer. Windows: NSIS supports a silent run; the
 * app must quit first so it can be replaced. macOS: open the dmg and tell the
 * user to drag it over (unsigned apps can't self-replace reliably).
 */
async function installDownloaded(path, asset) {
  const name = String(asset?.name ?? path);
  const kind = String(asset?.kind ?? '');
  // A digest in the manifest is a second gate: refuse to launch bytes that do
  // not match it, even if they were already sitting in the cache (D2).
  if (asset?.sha256) {
    const actual = await sha256OfFile(path);
    if (actual !== String(asset.sha256)) {
      return { launched: false, file: path, mode: 'manual', error: '安装包校验失败（sha256 不符），已阻止安装' };
    }
  }
  // The installer is *copied* to Downloads, never moved: `versions/` is the
  // local archive that makes switching back to an older build instant, so the
  // file the panel lists must survive the install (D1).
  const target = join(app.getPath('downloads'), name);
  await mkdir(app.getPath('downloads'), { recursive: true });
  let copy = target;
  try {
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size !== (await stat(path)).size) {
      copy = join(app.getPath('downloads'), `${Date.now()}-${name}`);
    }
    await copyFile(path, copy);
  } catch {
    copy = path; // Downloads not writable: install from the archive instead
  }

  if (process.platform === 'win32') {
    const { spawn } = require('node:child_process');
    if (kind === 'portable') {
      await shell.openPath(path);
      return { launched: true, file: copy, mode: 'portable' };
    }
    const child = spawn(path, ['/S', '--updated'], { detached: true, stdio: 'ignore' });
    child.unref();
    app.quit();
    return { launched: true, file: copy, mode: 'silent-install' };
  }

  await shell.openPath(path);
  return { launched: true, file: copy, mode: 'manual' };
}

/**
 * Hosts an installer may come from: GitHub itself, the jsDelivr CDN and the
 * proxies listed in the *bundled* `mirrors.json`. A manifest (or a mirror that
 * rewrote it) must not be able to point the desktop app at an arbitrary exe
 * (D3) — the mirror list is read from the app directory, never from the network.
 */
async function allowedDownloadHosts() {
  const hosts = new Set([
    'github.com',
    'api.github.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'raw.githubusercontent.com',
    'cdn.jsdelivr.net',
  ]);
  const { mirrors, rawMirrors } = await readMirrors();
  for (const entry of [...mirrors, ...rawMirrors]) {
    try {
      hosts.add(new URL(String(entry.prefix)).hostname.toLowerCase());
    } catch {
      /* a broken entry in mirrors.json simply contributes no host */
    }
  }
  return hosts;
}

/** @param {string} url */
async function isAllowedAssetUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const hosts = await allowedDownloadHosts();
  return hosts.has(parsed.hostname.toLowerCase());
}

async function openFolder(path) {
  await shell.showItemInFolder(path);
}

module.exports = {
  fetchManifest,
  probeMirrors,
  downloadWithMirrors,
  installDownloaded,
  isAllowedAssetUrl,
  sha256OfFile,
  readSettings,
  writeSettings,
  readMirrors,
  versionFileFor,
  versionsDir,
  ensureDownloaded,
  localVersions,
  openFolder,
  manifestCandidates,
};
