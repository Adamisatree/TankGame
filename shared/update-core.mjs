/**
 * Pure update logic shared by the desktop app (Electron main), the menu UI and
 * the test suite. No network, no Electron – everything here is deterministic so
 * it can be unit-tested in Node.
 */

/** @typedef {{ id: string, label: string, prefix: string }} Mirror */

export const REPO = 'Adamisatree/TankGame';
export const REPO_URL = `https://github.com/${REPO}`;

/** Canonical (unmirrored) locations. */
export const OFFICIAL = {
  releasesApi: `https://api.github.com/repos/${REPO}/releases`,
  latestApi: `https://api.github.com/repos/${REPO}/releases/latest`,
  manifestRaw: `https://raw.githubusercontent.com/${REPO}/main/updates.json`,
  releaseDownload: `https://github.com/${REPO}/releases/download`,
  releasePage: `${REPO_URL}/releases`,
};

// ------------------------------------------------------------------ versions

/**
 * "1.2.3" / "v1.2.3" / "1.2.3-beta.1" -> numbers plus an optional prerelease tag.
 * @param {string} value
 * @returns {{ major: number, minor: number, patch: number, pre: string }}
 */
export function parseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '');
  const [core, ...rest] = text.split('-');
  // v1.6.2: `parseInt` accepted trailing junk ("1.6.1beta" → 1.6.1) and the
  // prerelease tag was compared as a plain string, so beta.10 sorted *below*
  // beta.2. Digits are now parsed strictly and the tag compares piecewise.
  const parts = core.split('.').map((p) => {
    const n = /^\d+$/.test(p) ? Number.parseInt(p, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  });
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    pre: rest.join('-'),
  };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1} negative when a < b
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  // A release sorts above any prerelease of the same number.
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return comparePrerelease(x.pre, y.pre);
}

/**
 * Compares `alpha.2` style tags the way semver does: numeric identifiers by
 * value, alphanumeric ones lexically, a shorter list first when it is a prefix.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function comparePrerelease(a, b) {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const left = x[i];
    const right = y[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (leftNum !== rightNum) {
      // Numeric identifiers always have lower precedence than alphanumeric ones.
      return leftNum ? -1 : 1;
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0;
}

// ------------------------------------------------------------------ assets

/**
 * Works out what a release asset is from its file name.
 * electron-builder names them deterministically, which is what makes
 * version switching possible without any server of our own.
 * @param {string} name
 */
export function classifyAsset(name) {
  const lower = String(name).toLowerCase();
  const arch = /arm64|aarch64/.test(lower) ? 'arm64' : /x64|amd64|x86_64/.test(lower) ? 'x64' : 'any';

  /** @type {'installer'|'portable'|'dmg'|'zip'|'html'|'other'} */
  let kind = 'other';
  if (lower.endsWith('.dmg')) kind = 'dmg';
  else if (lower.endsWith('.zip')) kind = 'zip';
  else if (lower.endsWith('.html')) kind = 'html';
  else if (lower.endsWith('-portable.exe')) kind = 'portable';
  else if (lower.endsWith('.exe')) kind = 'installer';

  /** @type {'win32'|'darwin'|'any'} */
  let platform = 'any';
  if (kind === 'installer' || kind === 'portable') platform = 'win32';
  else if (kind === 'dmg') platform = 'darwin';
  else if (kind === 'zip') platform = 'darwin';

  return { kind, platform, arch };
}

/**
 * Picks the asset a given machine should install.
 * @param {{ name: string }[]} assets
 * @param {{ platform: string, arch: string }} target
 */
export function pickAssetFor(assets, target) {
  const platform = target.platform === 'win32' ? 'win32' : target.platform === 'darwin' ? 'darwin' : target.platform;
  const arch = target.arch === 'arm64' ? 'arm64' : 'x64';
  const scored = assets
    .map((asset) => {
      const meta = classifyAsset(asset.name);
      let score = -1;
      if (meta.platform !== platform) return { asset, meta, score };
      // 100 = exact installer, 80 = universal installer, 60 = portable, 40 = archive.
      if (platform === 'win32') {
        if (meta.kind === 'installer' && meta.arch === arch) score = 100;
        else if (meta.kind === 'installer' && meta.arch === 'any') score = 90;
        else if (meta.kind === 'portable' && meta.arch === arch) score = 70;
        else if (meta.kind === 'portable' && meta.arch === 'any') score = 60;
      } else {
        if (meta.kind === 'dmg' && meta.arch === arch) score = 100;
        else if (meta.kind === 'zip' && meta.arch === arch) score = 80;
        else if (meta.kind === 'dmg' && meta.arch === 'any') score = 70;
        else if (meta.kind === 'zip' && meta.arch === 'any') score = 60;
      }
      return { asset, meta, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0] ? { ...scored[0].asset, ...scored[0].meta } : null;
}

/** Assets worth showing as "you can also just play this" (the single-file build). */
export function findPortableHtml(assets) {
  return assets.find((a) => classifyAsset(a.name).kind === 'html') ?? null;
}

// ------------------------------------------------------------------ mirrors

/** @param {string} url */
export function isGithubUrl(url) {
  return /^https?:\/\/(github\.com|api\.github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com)\//i.test(url);
}

/**
 * Prefix mirrors take the *whole* original URL: `<prefix><url>`.
 * @param {string} url
 * @param {Mirror} mirror
 */
export function applyMirror(url, mirror) {
  if (!mirror || !mirror.prefix) return url;
  const base = mirror.prefix.endsWith('/') ? mirror.prefix : `${mirror.prefix}/`;
  return `${base}${url}`;
}

/**
 * Ordered download candidates for one canonical URL: the chosen mirror first,
 * then every other mirror, then the official host as the last resort.
 * @param {string} url
 * @param {Mirror[]} mirrors
 * @param {string} [preferredId]
 */
export function urlCandidates(url, mirrors, preferredId) {
  const list = [];
  const ordered = [...mirrors].sort((a, b) => (a.id === preferredId ? -1 : b.id === preferredId ? 1 : 0));
  for (const mirror of ordered) {
    list.push({ id: mirror.id, label: mirror.label, url: applyMirror(url, mirror), mirrored: true });
  }
  list.push({ id: 'direct', label: 'github.com（直连）', url, mirrored: false });
  return list;
}

// ------------------------------------------------------------------ manifest

/**
 * Normalises either our own `updates.json` or the raw GitHub API payload into
 * one shape the UI can render.
 * @param {any} payload
 */
export function normalizeManifest(payload) {
  const source = Array.isArray(payload) ? payload : Array.isArray(payload?.releases) ? payload.releases : [];
  const releases = source
    .map((release) => {
      const tag = String(release.tag ?? release.tag_name ?? '');
      const version = String(release.version ?? tag).replace(/^v/i, '');
      const assets = (release.assets ?? []).map((asset) => {
        const meta = classifyAsset(asset.name ?? '');
        const digest = String(asset.sha256 ?? asset.digest ?? '');
        return {
          name: String(asset.name ?? ''),
          size: Number(asset.size ?? 0),
          sha256: digest.replace(/^sha256:/i, '').toLowerCase(),
          url: String(asset.url ?? asset.browser_download_url ?? ''),
          ...meta,
        };
      });
      return {
        tag,
        version,
        name: String(release.name ?? tag),
        notes: String(release.notes ?? release.body ?? ''),
        publishedAt: String(release.publishedAt ?? release.published_at ?? ''),
        prerelease: Boolean(release.prerelease ?? release.draft === true),
        // `.blockmap` / `latest.yml` / our own `updates.json` are not installable;
        // dropping them keeps the version list clean and the download picker sane.
        assets: assets.filter((asset) => asset.name && asset.kind !== 'other'),
      };
    })
    .filter((release) => !!release.version && release.assets.length > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return { generatedAt: String(payload?.generatedAt ?? new Date().toISOString()), releases };
}

/**
 * Newest release, ignoring prereleases unless nothing else exists.
 * @param {{ releases: any[] }} manifest
 */
export function latestRelease(manifest) {
  const stable = manifest.releases.filter((r) => !r.prerelease);
  return stable[0] ?? manifest.releases[0] ?? null;
}

// ------------------------------------------------------------------ helpers

/** @param {number} bytes */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Reads the version back out of an installer file name, so downloaded packages
 * kept on disk can be listed (and re-installed) without any manifest.
 * @param {string} name
 */
export function versionFromAssetName(name) {
  // `-arm64` / `-portable` are arch and packaging, not version, so only real
  // prerelease words are allowed to extend the number.
  const match = /^TankGame[-_]v?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|pre)[0-9A-Za-z.]*)?)/i.exec(String(name ?? ''));
  return match ? match[1] : '';
}

/**
 * Groups on-disk packages by version, newest first: this is the "local copies"
 * list – switching back to a previous version must not need a fresh download.
 * @param {{ name: string, size?: number, path?: string }[]} files
 */
export function groupLocalAssets(files) {
  /** @type {Record<string, any>} */
  const byVersion = {};
  for (const file of files) {
    const version = versionFromAssetName(file.name);
    if (!version) continue;
    const meta = classifyAsset(file.name);
    const entry = (byVersion[version] ??= { version, assets: [], size: 0 });
    entry.assets.push({ name: file.name, size: Number(file.size ?? 0), path: file.path ?? '', ...meta });
    entry.size += Number(file.size ?? 0);
    // Installers first, so the UI always offers the most useful file.
    entry.assets.sort((a, b) => (a.kind === 'installer' ? -1 : b.kind === 'installer' ? 1 : 0));
  }
  return Object.values(byVersion).sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * File name electron-builder produces for a release – kept here so the CI
 * manifest generator and the app agree.
 * @param {{ version: string, kind: string, arch?: string }} options
 */
export function expectedAssetName({ version, kind, arch }) {
  const suffix = arch && arch !== 'any' ? `-${arch}` : '';
  switch (kind) {
    case 'installer':
      return `TankGame-${version}${suffix}-setup.exe`;
    case 'portable':
      return `TankGame-${version}-portable.exe`;
    case 'dmg':
      return `TankGame-${version}${suffix}.dmg`;
    case 'zip':
      return `TankGame-${version}${suffix}.zip`;
    case 'html':
      return `TankGame-${version}-portable.html`;
    default:
      return `TankGame-${version}`;
  }
}
