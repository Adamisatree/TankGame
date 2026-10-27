/**
 * Mirror-aware file download with checksum verification.
 *
 * Kept free of Electron so it can be exercised in the test suite against local
 * HTTP servers: the fallback chain, the truncation check and the SHA-256 gate
 * are exactly the bits that break silently in the wild.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
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
 *   allowFinalUrl?: (url: string) => boolean,
 * }} [options]
 */
export async function downloadWithFallback(url, destPath, options = {}) {
  const {
    candidates = [{ id: 'direct', label: 'direct', url }],
    expectedSha = '',
    timeoutMs = 30000,
    onProgress,
    fetchImpl = fetch,
    allowFinalUrl = null,
  } = options;

  /** @type {string[]} */
  const errors = [];
  await mkdir(dirname(destPath), { recursive: true });

  /**
   * Open a temp file next to the destination.
   *
   * Windows hands out EPERM/EBUSY when antivirus or another process still holds
   * a file we just closed, and it does so for *the same path* every time. So:
   * a unique name per attempt, plus a short retry loop. The old code reused
   * `<dest>.part` for every mirror, which is exactly how players ended up with
   * "EPERM: operation not permitted, open '…setup.exe.part'".
   */
  const openPart = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const partPath = `${destPath}.${randomBytes(4).toString('hex')}.part`;
      try {
        const handle = await open(partPath, 'wx');
        return { handle, partPath };
      } catch (err) {
        const code = err && err.code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
        await new Promise((resolve) => setTimeout(resolve, 120 + attempt * 180));
      }
    }
    // Last resort: a sibling name with a timestamp, never reused.
    const partPath = `${destPath}.${Date.now()}.part`;
    return { handle: await open(partPath, 'wx'), partPath };
  };

  for (const candidate of candidates) {
    let partPath = '';
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
      // v1.6.2: `redirect: 'follow'` means the host that answers can point the
      // download anywhere. Re-check where it actually landed before a byte is
      // written, so the whitelist covers redirects too.
      if (allowFinalUrl && res.url && !allowFinalUrl(res.url)) {
        errors.push(`${candidate.id}: 被重定向到不受信任的地址`);
        try {
          await res.body.cancel();
        } catch {
          /* already gone */
        }
        continue;
      }

      const total = Number(res.headers.get('content-length') ?? 0);
      const hash = createHash('sha256');
      let received = 0;

      const opened = await openPart();
      const handle = opened.handle;
      partPath = opened.partPath;
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          hash.update(value);
          await handle.write(Buffer.from(value));
          onProgress?.({ received, total, url: candidate.url, id: candidate.id });
        }
        await handle.close();
      } catch (streamError) {
        // Always close the handle, or the next candidate hits a locked file.
        try {
          await handle.close();
        } catch {
          /* already closed */
        }
        await rm(partPath, { force: true }).catch(() => {});
        throw streamError;
      }

      const sha256 = hash.digest('hex');
      if (expectedSha && expectedSha !== sha256) {
        errors.push(`${candidate.id}: sha256 mismatch`);
        await rm(partPath, { force: true });
        continue;
      }
      // A proxy that drops the connection can still answer 200 with a short
      // body; refuse to install a half file. Mirrors often omit content-length,
      // so the checksum is the real gate: without one we say `verified: false`
      // and the caller asks the player instead of installing silently (D2).
      if (total > 1024 && received < total * 0.98) {
        errors.push(`${candidate.id}: truncated ${received}/${total}`);
        await rm(partPath, { force: true });
        continue;
      }

      // A half-written previous copy may still be locked; retry the swap.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await rm(destPath, { force: true });
          await rename(partPath, destPath);
          break;
        } catch (renameError) {
          const code = renameError && renameError.code;
          if (attempt === 3 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw renameError;
          await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 250));
        }
      }
      return {
        ok: true,
        path: destPath,
        sha256,
        size: received,
        source: candidate,
        verified: !!expectedSha,
        errors,
      };
    } catch (err) {
      errors.push(`${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
      if (partPath) await rm(partPath, { force: true }).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, path: '', sha256: '', size: 0, source: null, verified: false, errors };
}

/**
 * Time to a complete small response, in ms, or null on failure.
 *
 * `firstByteOnly` stops after the first chunk and aborts the rest: that is what
 * makes it safe to measure the *download* path of a 160 MB installer without
 * pulling the whole file (`range` asks for a few bytes, and mirrors that ignore
 * it are hung up on after the first chunk).
 * @param {string} url
 */
export async function measureLatency(url, { timeoutMs = 6000, fetchImpl = fetch, headers = {}, firstByteOnly = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'TankGame-Updater', ...headers },
    });
    if (!res.ok) return null;
    if (firstByteOnly && res.body) {
      const reader = res.body.getReader();
      try {
        await reader.read();
      } finally {
        await reader.cancel().catch(() => {});
      }
      return Date.now() - started;
    }
    await res.arrayBuffer();
    return Date.now() - started;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
