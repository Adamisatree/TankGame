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
const { mkdir, readdir, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
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
    // Every raw mirror stores the prefix up to `@`, so `prefix + "main/updates.json"`
    // is the jsDelivr `@main` URL and the ghproxy raw URL at the same time.
    list.push({ id: raw.id, label: raw.label, url: `${raw.prefix}main/updates.json` });
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
 * Measures each mirror with a tiny request; the ranking is cached for an hour.
 * @param {(msg: { mirror: string, ms: number | null }) => void} [onProgress]
 */
async function probeMirrors(onProgress) {
  const { OFFICIAL, applyMirror } = await loadCore();
  const { mirrors } = await readMirrors();
  // Probe with the small raw manifest: same host path the real download proxies use.
  const probeUrl = OFFICIAL.manifestRaw;

  const { measureLatency } = await import(pathToFileURL(join(__dirname, '..', 'shared', 'download.mjs')).href);

  const results = await Promise.all(
    mirrors.map(async (mirror) => {
      const ms = await measureLatency(applyMirror(probeUrl, mirror), { timeoutMs: 6000 });
      const entry = { id: mirror.id, label: mirror.label, ms };
      onProgress?.(entry);
      return entry;
    })
  );

  const ranked = [...results].sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  return { ranked, probeUrl, official: OFFICIAL.releasesApi };
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
  const candidates = core.urlCandidates(url, mirrors, options.mirrorId || settings.mirrorId);
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
      if (!asset.sha256 || sha256 === asset.sha256) {
        return { ok: true, path: dest, sha256, size: info.size, cached: true, errors: [] };
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
  const target = join(app.getPath('downloads'), name);
  // Copy out of the temp dir so the installer survives our own exit.
  await mkdir(app.getPath('downloads'), { recursive: true });
  await rm(target, { force: true });
  await rename(path, target).catch(async () => {
    await writeFile(target, await readFile(path));
    await rm(path, { force: true });
  });

  if (process.platform === 'win32') {
    const { spawn } = require('node:child_process');
    if (kind === 'portable') {
      await shell.openPath(target);
      return { launched: true, file: target, mode: 'portable' };
    }
    const child = spawn(target, ['/S', '--updated'], { detached: true, stdio: 'ignore' });
    child.unref();
    app.quit();
    return { launched: true, file: target, mode: 'silent-install' };
  }

  await shell.openPath(target);
  return { launched: true, file: target, mode: 'manual' };
}

async function openFolder(path) {
  await shell.showItemInFolder(path);
}

module.exports = {
  fetchManifest,
  probeMirrors,
  downloadWithMirrors,
  installDownloaded,
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
