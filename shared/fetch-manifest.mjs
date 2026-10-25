/**
 * Fetches the release list from several places *at the same time* and keeps the
 * freshest answer.
 *
 * Why the race: the cache-friendly mirrors (jsDelivr especially) can serve a
 * response that is minutes or hours old, while a proxy in front of the GitHub
 * API always has the truth. Asking one after another would either be slow (every
 * dead mirror adds its timeout) or stale (the CDN answers first and we stop).
 * Racing them, then waiting a short grace period for the others, keeps updates
 * prompt without letting a slow mirror hold the check hostage.
 */
import { normalizeManifest } from './update-core.mjs';

/**
 * @param {{ id: string, label?: string, url: string }[]} candidates
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   graceMs?: number,
 *   timeoutMs?: number,
 *   normalize?: (payload: any) => { generatedAt: string, releases: any[] },
 * }} [options]
 */
export async function raceManifestFetch(candidates, options = {}) {
  const {
    fetchImpl = fetch,
    graceMs = 1200,
    timeoutMs = 12000,
    normalize = normalizeManifest,
  } = options;

  /** @type {{ candidate: any, manifest?: any, ms?: number, error?: string }[]} */
  const results = [];
  let firstSuccessAt = 0;

  const attempts = candidates.map(async (candidate) => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(candidate.url, {
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'follow',
        headers: { 'user-agent': 'TankGame-Updater', accept: 'application/json, text/plain, */*' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const manifest = normalize(JSON.parse(await res.text()));
      if (!manifest.releases.length) throw new Error('empty manifest');
      results.push({ candidate, manifest, ms: Date.now() - started });
      if (!firstSuccessAt) firstSuccessAt = Date.now();
    } catch (err) {
      results.push({ candidate, error: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
    }
  });

  // Wait for everyone, but never much longer than the first success.
  await new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const done = results.length === candidates.length;
      const graceOver = firstSuccessAt > 0 && Date.now() - firstSuccessAt > graceMs;
      // Absolute cap so a wall of dead mirrors cannot hang the check.
      const capOver = Date.now() - started > timeoutMs + 500;
      if (done || graceOver || capOver) {
        clearInterval(poll);
        resolve(undefined);
      }
    }, 40);
  });

  const successes = results.filter((entry) => entry.manifest);
  successes.sort((a, b) => {
    const ageA = Date.parse(a.manifest.generatedAt) || 0;
    const ageB = Date.parse(b.manifest.generatedAt) || 0;
    if (ageA !== ageB) return ageB - ageA;
    return b.manifest.releases.length - a.manifest.releases.length;
  });

  return {
    manifest: successes[0]?.manifest ?? null,
    source: successes[0]?.candidate ?? null,
    errors: results.filter((entry) => entry.error).map((entry) => `${entry.candidate.id}: ${entry.error}`),
    answered: successes.map((entry) => entry.candidate.id),
  };
}
