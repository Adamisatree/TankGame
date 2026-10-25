#!/usr/bin/env node
/**
 * Regenerates `updates.json`, the release manifest the app reads through a CDN
 * mirror (jsDelivr / ghproxy) instead of hitting the GitHub API directly.
 *
 * Runs in CI right after a release is published, and locally with a token:
 *   GITHUB_TOKEN=$(gh auth token) node scripts/gen-update-manifest.mjs
 *
 * Only stdlib: no dependencies, so CI can run it before `npm ci`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { classifyAsset, normalizeManifest, OFFICIAL, REPO } from '../shared/update-core.mjs';

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const target = new URL('../updates.json', import.meta.url);

async function github(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'TankGame-manifest',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// A pre-fetched payload can be passed in (handy locally, where `gh api` already
// has working TLS and a token).
const inputFile = process.argv[2];
const releases = inputFile ? JSON.parse(await readFile(inputFile, 'utf8')) : await github('releases?per_page=30');

/** Trim the payload to what the app needs, keeping GitHub's sha256 digests. */
const slim = releases
  .filter((release) => !release.draft)
  .map((release) => ({
    tag: release.tag_name,
    version: String(release.tag_name).replace(/^v/i, ''),
    name: release.name,
    notes: release.body,
    publishedAt: release.published_at,
    prerelease: release.prerelease,
    assets: (release.assets ?? []).map((asset) => ({
      name: asset.name,
      size: asset.size,
      sha256: String(asset.digest ?? '').replace(/^sha256:/i, ''),
      url: asset.browser_download_url || `${OFFICIAL.releaseDownload}/${release.tag_name}/${asset.name}`,
      ...classifyAsset(asset.name),
    })),
  }));

const manifest = {
  app: 'TankGame',
  repo: REPO,
  generatedAt: new Date().toISOString(),
  // Sorted newest-first so the app can pick releases[0] without extra work.
  releases: normalizeManifest({ releases: slim }).releases,
};

await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const missingHash = manifest.releases.flatMap((r) => r.assets.filter((a) => !a.sha256).map((a) => a.name));
console.log(`updates.json: ${manifest.releases.length} releases`);
for (const release of manifest.releases) {
  const kinds = release.assets.map((a) => a.kind).join(',');
  console.log(`  v${release.version}: ${release.assets.length} assets (${kinds})`);
}
if (missingHash.length) {
  console.warn(`warning: assets without a sha256 digest: ${missingHash.join(', ')}`);
}
