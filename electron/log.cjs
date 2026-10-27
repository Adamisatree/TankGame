/**
 * Local log files for the desktop build (v1.6.4).
 *
 * Why this exists: "the game freezes after the start button" and "the room stays
 * empty" were reported twice and both times there was nothing to look at — the
 * window died (or stopped drawing) and the only trace was on the player's
 * screen. Every serious report from now on should arrive with a file.
 *
 * Where the files go:
 *   1. `<app>\log\` — inside the installation (`resources/app/log`, the build is
 *      `asar: false`, so this is a real folder next to the game);
 *   2. if that is not writable (an install under `C:\Program Files`, a read-only
 *      USB stick), `userData\log`, with a line in the log saying why.
 *
 * Rules:
 *   - writing a log never throws, never blocks the caller for long, and never
 *     turns a crash into a different crash;
 *   - one file per stream (`tankgame-main.log`, `-renderer.log`, `-server.log`),
 *     rotated at 512 KB, five previous files kept.
 *
 * Pure Node (no Electron) so `scripts/desktop-test.ts` can exercise it.
 */
const {
  appendFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} = require('node:fs');
const { basename, dirname, join } = require('node:path');

const MAX_BYTES = 512 * 1024;
const KEEP = 5;

/**
 * @param {{ dir?: string, fallbackDir?: string, maxBytes?: number, keep?: number }} [options]
 */
function createLogger(options = {}) {
  // Callers are crash handlers and IPC: a bad argument must not become a throw.
  const opts = options && typeof options === 'object' ? options : {};
  const preferred = typeof opts.dir === 'string' && opts.dir ? opts.dir : '';
  const fallback = typeof opts.fallbackDir === 'string' && opts.fallbackDir ? opts.fallbackDir : '';
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : MAX_BYTES;
  const keep = Number(opts.keep) >= 0 ? Number(opts.keep) : KEEP;

  /** @type {string | null | undefined} undefined = not resolved yet */
  let resolved;
  /** Why we ended up where we did — '' when the preferred folder worked. */
  let reason = '';

  function resolveDir() {
    if (resolved !== undefined) return resolved;
    const candidates = [preferred, fallback].filter(Boolean);
    for (const candidate of candidates) {
      try {
        mkdirSync(candidate, { recursive: true });
        resolved = candidate;
        reason = candidate === preferred ? '' : `not writable: ${preferred}`;
        return resolved;
      } catch {
        /* try the next one */
      }
    }
    resolved = null;
    reason = 'no writable log folder';
    return resolved;
  }

  /** Rename the file once it passes the size limit and prune old copies. */
  function rotate(file) {
    try {
      if (statSync(file).size <= maxBytes) return;
      const stamped = file.replace(/\.log$/i, '') + `-${Date.now()}.log`;
      renameSync(file, stamped);
      if (keep <= 0) return;
      const folder = dirname(file);
      const prefix = basename(file).replace(/\.log$/i, '');
      const olds = readdirSync(folder)
        .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.log'))
        .sort();
      for (const name of olds.slice(0, Math.max(0, olds.length - keep))) {
        try {
          unlinkSync(join(folder, name));
        } catch {
          /* somebody else's file, or gone already */
        }
      }
    } catch {
      /* first write, or a locked file: appending still works */
    }
  }

  /**
   * Append one line. `line` is prefixed with an ISO timestamp.
   * @param {string} stream file name, e.g. `tankgame-main.log`
   * @param {unknown} line
   * @returns {boolean} whether it landed
   */
  function write(stream, line) {
    try {
      const folder = resolveDir();
      if (!folder) return false;
      const name = String(stream || 'tankgame.log').replace(/[^A-Za-z0-9._-]/g, '_');
      const file = join(folder, name.endsWith('.log') ? name : `${name}.log`);
      rotate(file);
      const text = typeof line === 'string' ? line : String(line);
      appendFileSync(file, `${new Date().toISOString()} ${text}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  return {
    write,
    /** Resolved folder (may be null when nothing is writable). */
    dir: () => resolveDir(),
    /** '' when the preferred folder worked, otherwise why it did not. */
    reason: () => reason,
    file: (stream) => {
      const folder = resolveDir();
      if (!folder) return '';
      const name = String(stream || 'tankgame.log');
      return join(folder, name.endsWith('.log') ? name : `${name}.log`);
    },
  };
}

module.exports = { createLogger, MAX_BYTES, KEEP };
