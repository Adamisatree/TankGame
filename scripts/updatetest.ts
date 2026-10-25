/**
 * Unit tests for the auto-update / version-switching machinery.
 *
 * The interesting failures here are not "does it compile" but: does a dead
 * mirror really fall through, does a corrupt file really get rejected, and does
 * an older version really show up as installable (downgrade). Those are tested
 * against throwaway HTTP servers, not the internet.
 *
 *   npm run test:update
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyMirror,
  classifyAsset,
  compareVersions,
  expectedAssetName,
  findPortableHtml,
  formatBytes,
  groupLocalAssets,
  versionFromAssetName,
  isNewer,
  latestRelease,
  normalizeManifest,
  OFFICIAL,
  parseVersion,
  pickAssetFor,
  urlCandidates,
} from '../shared/update-core.mjs';
import { downloadWithFallback, measureLatency } from '../shared/download.mjs';
import { raceManifestFetch } from '../shared/fetch-manifest.mjs';
import { readFileSync } from 'node:fs';

let passed = 0;
const failures: string[] = [];

// If an unhandled socket error ever slips through, fail loudly with context
// instead of dying with a bare stack trace (CI logs are not always readable).
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason);
  process.exit(1);
});

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

const mirrors = JSON.parse(readFileSync(new URL('../mirrors.json', import.meta.url), 'utf8'));

// ------------------------------------------------------------------ versions
console.log('\nversion comparison');
eq('parse plain', parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: '' });
eq('parse v-prefixed', parseVersion('v0.10.2'), { major: 0, minor: 10, patch: 2, pre: '' });
check('1.2.0 > 1.1.9', compareVersions('1.2.0', '1.1.9') > 0);
check('1.0.10 > 1.0.9 (numeric, not lexicographic)', compareVersions('1.0.10', '1.0.9') > 0);
check('equal with v prefix', compareVersions('v1.1.0', '1.1.0') === 0);
check('release beats its own prerelease', compareVersions('1.2.0', '1.2.0-beta.1') > 0);
check('prerelease sorts below release', compareVersions('1.2.0-beta.1', '1.2.0') < 0);
check('isNewer rejects downgrade', !isNewer('1.1.0', '1.2.0'));
check('isNewer accepts upgrade', isNewer('1.3.0', '1.2.0'));

// ------------------------------------------------------------------ assets
console.log('\nasset names');
eq('installer name', expectedAssetName({ version: '1.2.0', kind: 'installer', arch: 'x64' }), 'TankGame-1.2.0-x64-setup.exe');
eq('portable name', expectedAssetName({ version: '1.2.0', kind: 'portable' }), 'TankGame-1.2.0-portable.exe');
eq('dmg name', expectedAssetName({ version: '1.2.0', kind: 'dmg', arch: 'arm64' }), 'TankGame-1.2.0-arm64.dmg');
eq('html name', expectedAssetName({ version: '1.2.0', kind: 'html' }), 'TankGame-1.2.0-portable.html');
eq('classify universal installer', classifyAsset('TankGame-1.1.0-setup.exe'), { kind: 'installer', platform: 'win32', arch: 'any' });
eq('classify arm64 dmg', classifyAsset('TankGame-1.1.0-arm64.dmg'), { kind: 'dmg', platform: 'darwin', arch: 'arm64' });
eq('classify portable html', classifyAsset('TankGame-1.1.0-portable.html'), { kind: 'html', platform: 'any', arch: 'any' });
eq('classify portable exe', classifyAsset('TankGame-1.1.0-portable.exe'), { kind: 'portable', platform: 'win32', arch: 'any' });

const realAssets: { name: string }[] = [
  'TankGame-1.1.0-setup.exe',
  'TankGame-1.1.0-x64-setup.exe',
  'TankGame-1.1.0-arm64-setup.exe',
  'TankGame-1.1.0-portable.exe',
  'TankGame-1.1.0-arm64.dmg',
  'TankGame-1.1.0-x64.dmg',
  'TankGame-1.1.0-arm64.zip',
  'TankGame-1.1.0-portable.html',
].map((name) => ({ name }));

eq('win arm64 picks arm64 installer', pickAssetFor(realAssets, { platform: 'win32', arch: 'arm64' })?.name, 'TankGame-1.1.0-arm64-setup.exe');
eq('win x64 picks x64 installer', pickAssetFor(realAssets, { platform: 'win32', arch: 'x64' })?.name, 'TankGame-1.1.0-x64-setup.exe');
eq('mac arm64 picks arm64 dmg', pickAssetFor(realAssets, { platform: 'darwin', arch: 'arm64' })?.name, 'TankGame-1.1.0-arm64.dmg');
eq('mac x64 picks x64 dmg', pickAssetFor(realAssets, { platform: 'darwin', arch: 'x64' })?.name, 'TankGame-1.1.0-x64.dmg');
eq('html found for browser play', findPortableHtml(realAssets as never)?.name, 'TankGame-1.1.0-portable.html');
eq('formatBytes MB', formatBytes(75 * 1024 * 1024), '75.0 MB');
eq('formatBytes KB', formatBytes(2048), '2 KB');

// ------------------------------------------------------------------ local copies
console.log('\nlocal version store');
eq('version parsed out of an installer', versionFromAssetName('TankGame-1.1.0-x64-setup.exe'), '1.1.0');
eq('version parsed out of a dmg', versionFromAssetName('TankGame-1.2.0-arm64.dmg'), '1.2.0');
eq('version parsed out of a portable html', versionFromAssetName('TankGame-0.9.4-portable.html'), '0.9.4');
eq('non-tank file is ignored', versionFromAssetName('notes.txt'), '');

const store = groupLocalAssets([
  { name: 'TankGame-1.1.0-x64-setup.exe', size: 100, path: '/store/a' },
  { name: 'TankGame-1.2.0-x64-setup.exe', size: 200, path: '/store/b' },
  { name: 'TankGame-1.2.0-portable.exe', size: 50, path: '/store/c' },
  { name: 'readme.txt', size: 1, path: '/store/d' },
]);
eq('local copies grouped newest first', store.map((entry) => entry.version), ['1.2.0', '1.1.0']);
eq('both 1.2.0 packages are together', store[0].assets.length, 2);
eq('group size is summed', store[0].size, 250);
eq('paths survive, so 安装 can find the file', store[1].assets[0].path, '/store/a');

// ------------------------------------------------------------------ mirrors
console.log('\nmirrors');
check('mirror list is not empty', mirrors.mirrors.length >= 3, JSON.stringify(mirrors.mirrors?.length));
check('raw mirror list is not empty', mirrors.rawMirrors.length >= 1);
check('no dead ghproxy.com mirror', !mirrors.mirrors.some((m: { prefix: string }) => /ghproxy\.com\//.test(m.prefix) && !/gh-proxy\.com/.test(m.prefix)));
eq(
  'mirror prefixes a release url',
  applyMirror(`${OFFICIAL.releaseDownload}/v1.2.0/TankGame-1.2.0-x64-setup.exe`, mirrors.mirrors[0]),
  `${mirrors.mirrors[0].prefix.replace(/\/$/, '')}/${OFFICIAL.releaseDownload}/v1.2.0/TankGame-1.2.0-x64-setup.exe`
);

const candidates = urlCandidates(`${OFFICIAL.releaseDownload}/v1.2.0/a.exe`, mirrors.mirrors, mirrors.mirrors[2].id);
eq('preferred mirror first', candidates[0].id, mirrors.mirrors[2].id);
eq('every mirror is a candidate', candidates.filter((c: { mirrored: boolean }) => c.mirrored).length, mirrors.mirrors.length);
eq('direct github is last resort', candidates[candidates.length - 1].id, 'direct');
check('direct url is unmodified', candidates[candidates.length - 1].url === `${OFFICIAL.releaseDownload}/v1.2.0/a.exe`);

// ------------------------------------------------------------------ manifest
console.log('\nmanifest');
const githubPayload = [
  {
    tag_name: 'v1.1.0',
    name: 'v1.1.0',
    body: 'notes',
    published_at: '2026-10-25T03:35:43Z',
    prerelease: false,
    draft: false,
    assets: [
      {
        name: 'TankGame-1.1.0-x64-setup.exe',
        size: 78762000,
        digest: 'sha256:ABCDEF',
        browser_download_url: `${OFFICIAL.releaseDownload}/v1.1.0/TankGame-1.1.0-x64-setup.exe`,
      },
    ],
  },
  { tag_name: 'v1.0.0', name: 'v1.0.0', published_at: '2026-10-20T00:00:00Z', assets: [{ name: 'TankGame-1.0.0-x64-setup.exe', size: 1, digest: 'sha256:1234' }] },
  { tag_name: 'v0.9.0', name: 'v0.9.0', draft: true, assets: [{ name: 'TankGame-0.9.0-x64-setup.exe', size: 1 }] },
];
const manifest = normalizeManifest(githubPayload);
eq('releases sorted newest first', manifest.releases.map((r) => r.version), ['1.1.0', '1.0.0', '0.9.0']);
eq('digest prefix stripped', manifest.releases[0].assets[0].sha256, 'abcdef');
check('asset kind classified from manifest', manifest.releases[0].assets[0].kind === 'installer');
eq('notes carried through', manifest.releases[0].notes, 'notes');
eq('latest is stable head', latestRelease(manifest)?.version, '1.1.0');
check('empty payload does not throw', normalizeManifest({}).releases.length === 0);
check('object with releases key also works', normalizeManifest({ releases: githubPayload }).releases.length === 3);

const ours = normalizeManifest(
  JSON.parse(
    JSON.stringify({
      app: 'TankGame',
      releases: [
        { tag: 'v1.2.0', version: '1.2.0', publishedAt: '2026-11-01T00:00:00Z', assets: [{ name: 'TankGame-1.2.0-portable.html', size: 10, sha256: 'FF', url: 'https://example/x.html' }] },
      ],
    })
  )
);
eq('our own manifest shape normalises', ours.releases[0].assets[0].sha256, 'ff');
eq('our own manifest keeps url', ours.releases[0].assets[0].url, 'https://example/x.html');

const noisy = normalizeManifest({
  releases: [
    {
      tag: 'v1.2.0',
      assets: [
        { name: 'TankGame-1.2.0-x64-setup.exe', size: 10, digest: 'sha256:AA' },
        { name: 'TankGame-1.2.0-x64-setup.exe.blockmap', size: 1, digest: 'sha256:BB' },
        { name: 'latest.yml', size: 1, digest: 'sha256:CC' },
        { name: 'updates.json', size: 1, digest: 'sha256:DD' },
      ],
    },
    { tag: 'v1.1.0', assets: [{ name: 'latest.yml', size: 1 }] },
  ],
});
eq('only installable files are kept', noisy.releases.length, 1);
eq('blockmap/yml/json are dropped', noisy.releases[0].assets.map((a) => a.name), ['TankGame-1.2.0-x64-setup.exe']);

const prereleaseOnly = normalizeManifest({ releases: [{ tag: 'v2.0.0-rc.1', assets: [{ name: 'TankGame-2.0.0-rc.1-x64-setup.exe', size: 1 }] }] });
eq('prerelease-only falls back to prerelease', latestRelease(prereleaseOnly)?.version, '2.0.0-rc.1');

// ------------------------------------------------------------------ downloads
console.log('\ndownload fallback chain');

const payloadBytes = Buffer.from('tank-game-installer-binary'.repeat(1000));
const goodSha = createHash('sha256').update(payloadBytes).digest('hex');
const workDir = await mkdtemp(join(tmpdir(), 'tankgame-upd-'));

/** Small HTTP server mimicking: dead proxy, lying proxy, truncating proxy, good host. */
function startProxy(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    // Clients abort mid-response on purpose here; swallow the fallout so the
    // fake proxy cannot take the test process down with it.
    req.on('error', () => {});
    res.on('error', () => {});
    const url = req.url ?? '';
    if (url.startsWith('/dead')) {
      req.socket.destroy();
      return;
    }
    if (url.startsWith('/500')) {
      res.writeHead(500).end('nope');
      return;
    }
    if (url.startsWith('/truncated')) {
      res.writeHead(200, { 'content-length': String(payloadBytes.length) });
      res.write(payloadBytes.subarray(0, 500));
      res.end();
      return;
    }
    if (url.startsWith('/corrupt')) {
      const bad = Buffer.from('x'.repeat(payloadBytes.length));
      res.writeHead(200, { 'content-length': String(bad.length) }).end(bad);
      return;
    }
    if (url.startsWith('/slow')) {
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        try {
          res.writeHead(200).end('{}');
        } catch {
          /* the probe already hung up */
        }
      }, 3000);
      return;
    }
    res.writeHead(200, { 'content-length': String(payloadBytes.length), 'content-type': 'application/octet-stream' });
    res.end(payloadBytes);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const { server, port } = await startProxy();
const base = `http://127.0.0.1:${port}`;
const dest = join(workDir, 'TankGame-1.2.0-x64-setup.exe');

const deadFirst = await downloadWithFallback(`${base}/good`, dest, {
  candidates: [
    { id: 'dead', label: 'dead', url: `${base}/dead` },
    { id: '500', label: '500', url: `${base}/500` },
    { id: 'good', label: 'good', url: `${base}/good` },
  ],
  expectedSha: goodSha,
});
check('skips a dead socket and a 500, lands on the good host', deadFirst.ok && deadFirst.source?.id === 'good', JSON.stringify(deadFirst.errors));
eq('records each failed attempt', deadFirst.errors.length, 2);
eq('sha256 matches after download', deadFirst.sha256, goodSha);
eq('file bytes on disk are complete', (await readFile(dest)).length, payloadBytes.length);

const corruptFirst = await downloadWithFallback(`${base}/good`, dest, {
  candidates: [
    { id: 'corrupt', label: 'corrupt', url: `${base}/corrupt` },
    { id: 'good', label: 'good', url: `${base}/good` },
  ],
  expectedSha: goodSha,
});
check('corrupt mirror rejected by checksum', corruptFirst.ok && corruptFirst.source?.id === 'good');
check('checksum failure is reported', corruptFirst.errors.some((e: string) => e.includes('sha256 mismatch')), corruptFirst.errors.join('|'));

const truncated = await downloadWithFallback(`${base}/good`, join(workDir, 'short.exe'), {
  candidates: [{ id: 'truncated', label: 'truncated', url: `${base}/truncated` }],
  expectedSha: goodSha,
});
check('truncated response is not accepted', !truncated.ok);
check('truncation mentioned in errors', truncated.errors.some((e: string) => e.includes('truncated')), truncated.errors.join('|'));

const allDead = await downloadWithFallback(`${base}/good`, join(workDir, 'never.exe'), {
  candidates: [
    { id: 'dead', label: 'dead', url: `${base}/dead` },
    { id: '500', label: '500', url: `${base}/500` },
  ],
});
check('all-dead falls through to a clean failure', !allDead.ok && allDead.errors.length === 2);

// v1.5.1 / D2: a download without a digest must report itself as unverified,
// so the panel can ask instead of installing silently.
const unchecked = await downloadWithFallback(`${base}/good`, join(workDir, 'unchecked.exe'), {
  candidates: [{ id: 'good', label: 'good', url: `${base}/good` }],
});
check('a download with a digest reports verified', deadFirst.verified === true);
check('a download without a digest reports unverified', unchecked.ok && unchecked.verified === false);

// v1.5.1 / D6: probing the installer path must stop after the first chunk —
// a range-ignoring mirror would otherwise push the whole 160 MB.
const probeStart = Date.now();
const ranged = await measureLatency(`${base}/good`, {
  timeoutMs: 3000,
  headers: { range: 'bytes=0-1023' },
  firstByteOnly: true,
});
check('a first-byte probe answers', typeof ranged === 'number' && ranged >= 0);
check('a first-byte probe does not read the whole file', Date.now() - probeStart < 2000);

const slow = await measureLatency(`${base}/slow`, { timeoutMs: 300 });
check('latency probe gives up on a stalled mirror', slow === null);
const fast = await measureLatency(`${base}/good`, { timeoutMs: 3000 });
check('latency probe returns a number for a live mirror', typeof fast === 'number' && fast >= 0);

// ------------------------------------------------------------------ manifest race
console.log('\nmanifest race (freshness vs. mirror latency)');

const freshPayload = {
  generatedAt: '2026-11-02T00:00:00Z',
  releases: [
    { tag: 'v1.2.0', version: '1.2.0', assets: [{ name: 'TankGame-1.2.0-x64-setup.exe', size: 10, sha256: 'aa' }] },
    { tag: 'v1.1.0', version: '1.1.0', assets: [{ name: 'TankGame-1.1.0-x64-setup.exe', size: 10, sha256: 'bb' }] },
  ],
};
const stalePayload = {
  generatedAt: '2026-10-01T00:00:00Z',
  releases: [{ tag: 'v1.1.0', version: '1.1.0', assets: [{ name: 'TankGame-1.1.0-x64-setup.exe', size: 10, sha256: 'bb' }] }],
};

function startManifestServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    const url = req.url ?? '';
    const send = (payload: unknown, delay = 0) => {
      const body = JSON.stringify(payload);
      setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        try {
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
          res.end(body);
        } catch {
          /* client gave up waiting */
        }
      }, delay);
    };
    if (url.startsWith('/fresh')) return send(freshPayload);
    if (url.startsWith('/stale')) return send(stalePayload, 5);
    if (url.startsWith('/slow-fresh')) return send(freshPayload, 2500);
    if (url.startsWith('/dead')) return void req.socket.destroy();
    if (url.startsWith('/empty')) return send({ releases: [] });
    return void res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const manifests = await startManifestServer();
const mbase = `http://127.0.0.1:${manifests.port}`;

const staleFirst = await raceManifestFetch(
  [
    { id: 'cdn', label: 'CDN', url: `${mbase}/stale` },
    { id: 'api', label: 'API', url: `${mbase}/fresh` },
  ],
  { graceMs: 800 }
);
eq('a stale CDN answer loses to the fresh one', staleFirst.manifest?.releases[0].version, '1.2.0');
eq('the fresher source is reported', staleFirst.source?.id, 'api');
check('both mirrors answered', staleFirst.answered.length === 2, JSON.stringify(staleFirst.answered));

const startedAt = Date.now();
const fastWins = await raceManifestFetch(
  [
    { id: 'fast', label: 'fast', url: `${mbase}/fresh` },
    { id: 'slow', label: 'slow', url: `${mbase}/slow-fresh` },
  ],
  { graceMs: 400 }
);
const elapsed = Date.now() - startedAt;
check('a slow mirror cannot hold the check hostage', elapsed < 2500, `${elapsed}ms`);
eq('the fast answer is used', fastWins.source?.id, 'fast');

const withDead = await raceManifestFetch(
  [
    { id: 'dead', label: 'dead', url: `${mbase}/dead` },
    { id: 'empty', label: 'empty', url: `${mbase}/empty` },
    { id: 'fresh', label: 'fresh', url: `${mbase}/fresh` },
  ],
  { graceMs: 400 }
);
check('dead and empty mirrors are skipped', withDead.manifest?.releases.length === 2, JSON.stringify(withDead.errors));
eq('errors mention the failures', withDead.errors.length, 2);
eq('the good mirror is the source', withDead.source?.id, 'fresh');

const allBad = await raceManifestFetch(
  [
    { id: 'dead', label: 'dead', url: `${mbase}/dead` },
    { id: '404', label: '404', url: `${mbase}/nope` },
  ],
  { graceMs: 300, timeoutMs: 2000 }
);
check('no reachable mirror yields no manifest', allBad.manifest === null && allBad.errors.length === 2);

const timedOut = await raceManifestFetch([{ id: 'dead', url: `${mbase}/dead` }], { timeoutMs: 500 });
check('a hanging mirror times out instead of hanging forever', timedOut.manifest === null);

manifests.server.close();
server.close();
await rm(workDir, { recursive: true, force: true });

// ------------------------------------------------------------------ version gate
console.log('\nLAN version gate');
const lanServerSource = await readFile(new URL('../server/lan-server.mjs', import.meta.url), 'utf8');
check('server reads its version from package.json', /package\.json/.test(lanServerSource) && /TANK_VERSION/.test(lanServerSource));
check('server compares versions on join', /reject/.test(lanServerSource) && /hostVersion/.test(lanServerSource));
check('server reports version in /info', /version/.test(lanServerSource));
const protocolSource = await readFile(new URL('../src/net/protocol.ts', import.meta.url), 'utf8');
// Bumping the protocol is expected (v3 → v4 for HP, v5 for ten seats and heat),
// so this asserts the floor instead of one exact number.
const protocolVersion = Number(/PROTOCOL_VERSION\s*=\s*(\d+)/.exec(protocolSource)?.[1] ?? 0);
check('protocol version is at least 3', protocolVersion >= 3, `got ${protocolVersion}`);
check(
  'snapshots carry barrel heat in the protocol',
  /heat:\s*number/.test(protocolSource) && /heatLocked:\s*number/.test(protocolSource)
);

// ------------------------------------------------------------------ summary
console.log('');
if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`${passed} passed`);
