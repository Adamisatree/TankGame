/**
 * Mirror-aware file download with checksum verification.
 *
 * Kept free of Electron so it can be exercised in the test suite against local
 * HTTP servers: the fallback chain, the truncation check and the SHA-256 gate
 * are exactly the bits that break silently in the wild.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * @param {string} url
 * @param {string} destPath
 * @param {{
 *   candidates?: { id: string, label?: string, url: string }[],
 *   expectedSha?: string,
 *   timeoutMs?: number,
 *   onProgress?: (info: { received: number, total: number, url: string, id: string }) => void,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 */
export async function downloadWithFallback(url, destPath, options = {}) {
  const {
    candidates = [{ id: 'direct', label: 'direct', url }],
    expectedSha = '',
    timeoutMs = 30000,
    onProgress,
    fetchImpl = fetch,
  } = options;

  /** @type {string[]} */
  const errors = [];
  await mkdir(dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;

  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(candidate.url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'TankGame-Updater' },
      });
      if (!res.ok || !res.body) {
        errors.push(`${candidate.id}: HTTP ${res.status}`);
        continue;
      }

      const total = Number(res.headers.get('content-length') ?? 0);
      const hash = createHash('sha256');
      let received = 0;

      await rm(partPath, { force: true });
      const out = createWriteStream(partPath);
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          hash.update(value);
          if (!out.write(Buffer.from(value))) {
            await new Promise((resolve) => out.once('drain', resolve));
          }
          onProgress?.({ received, total, url: candidate.url, id: candidate.id });
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      } catch (streamError) {
        // A proxy that hangs up mid-file leaves the handle open; close it before
        // the next candidate writes to the same .part path (Windows locks files).
        out.destroy();
        if (!out.closed) await new Promise((resolve) => out.once('close', resolve));
        throw streamError;
      }

      const sha256 = hash.digest('hex');
      if (expectedSha && expectedSha !== sha256) {
        errors.push(`${candidate.id}: sha256 mismatch`);
        await rm(partPath, { force: true });
        continue;
      }
      // A proxy that drops the connection can still answer 200 with a short
      // body; refuse to install a half file.
      if (total > 1024 && received < total * 0.98) {
        errors.push(`${candidate.id}: truncated ${received}/${total}`);
        await rm(partPath, { force: true });
        continue;
      }

      await rm(destPath, { force: true });
      await rename(partPath, destPath);
      return { ok: true, path: destPath, sha256, size: received, source: candidate, errors };
    } catch (err) {
      errors.push(`${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  await rm(partPath, { force: true });
  return { ok: false, path: '', sha256: '', size: 0, source: null, errors };
}

/** @param {string} url @returns {Promise<number | null>} latency in ms, null on failure */
export async function measureLatency(url, { timeoutMs = 6000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { 'user-agent': 'TankGame-Updater' } });
    if (!res.ok) return null;
    await res.arrayBuffer();
    return Date.now() - started;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
