/**
 * What the updater is allowed to download and launch.
 *
 * v1.6.2: these checks used to live inside `electron/updater.cjs`, where nothing
 * could unit-test them without an Electron binary — and both of them were wrong
 * in a way that mattered:
 *
 *   - `isAllowedAssetUrl` only looked at the *hostname*, so a mirror prefix
 *     (`https://ghfast.top/`) happily fronted `https://attacker.example/x.exe`;
 *   - the asset name from the manifest was used as a path, so `..\..\evil.exe`
 *     was written outside the version store and then executed.
 *
 * Kept dependency-free (no Electron, no fs) so the test suite can exercise them.
 */

/** A file name we are willing to write into the version store. */
export function safeAssetName(name) {
  const text = String(name ?? '');
  if (!text || text.length > 120) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) return '';
  if (text.includes('..')) return '';
  return text;
}

/** `…/releases/download/` for the given repo. */
function releasePrefix(repo) {
  return `https://github.com/${repo}/releases/download/`;
}

/**
 * True when `url` is either the official release-asset URL or a known mirror
 * prefix in front of it.
 *
 * @param {string} url
 * @param {{ hosts: Set<string> | string[], repo: string }} options
 */
export function assetUrlAllowed(url, options) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;

  const hosts = options.hosts instanceof Set ? options.hosts : new Set(options.hosts ?? []);
  const host = parsed.hostname.toLowerCase();
  if (!hosts.has(host)) return false;

  const official = releasePrefix(options.repo);
  // Case 1: this *is* the canonical asset URL.
  if (parsed.origin === 'https://github.com' && parsed.pathname.startsWith(`/${options.repo}/releases/download/`)) {
    return true;
  }
  // Case 2: a mirror prefix in front of it. Everything after the prefix must
  // itself be that canonical URL — a mirror may not wrap another host.
  const rest = `${parsed.pathname}${parsed.search}`.replace(/^\/+/, '');
  let inner;
  try {
    inner = new URL(rest.startsWith('https://') || rest.startsWith('http://') ? rest : `https://${rest}`);
  } catch {
    return false;
  }
  return inner.protocol === 'https:' && inner.origin === 'https://github.com' && `${inner.origin}${inner.pathname}`.startsWith(official);
}
