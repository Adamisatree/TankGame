/**
 * Renderer-side logging (v1.6.4).
 *
 * A player reporting "it freezes after I press start" is impossible to act on
 * without the machine's own account of what happened. Inside the desktop app the
 * three hooks below hand everything to the main process, which appends it to
 * `log\tankgame-renderer.log` next to the installation (see electron/log.cjs).
 *
 * The browser / single-file build has no filesystem, so it keeps a ring buffer in
 * localStorage instead: the next launch folds it into the log (desktop) or prints
 * it in the console, which is still better than nothing.
 */
import type { GameScene } from './game/GameScene';

type LogBridge = {
  write?: (entry: { level?: string; source?: string; message?: string; stack?: string }) => void;
  heartbeat?: (state: string) => void;
  folder?: () => Promise<{ dir: string; reason: string }>;
  reveal?: () => Promise<boolean>;
};

const STORE_KEY = 'tankduel.errors';
const KEEP = 50;

const bridge = (): LogBridge | null => window.tankGame?.log ?? null;

function remember(text: string): void {
  try {
    const previous = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    const list = Array.isArray(previous) ? previous : [];
    list.push(`${new Date().toISOString()} ${text}`.slice(0, 4000));
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-KEEP)));
  } catch {
    /* private mode, quota, disabled storage: the console still gets it */
  }
}

/** One line, with a stack when there is one. Never throws. */
export function logLine(entry: { level?: string; source?: string; message?: string; stack?: string }): void {
  const payload = {
    level: entry.level ?? 'error',
    source: entry.source ?? 'renderer',
    message: String(entry.message ?? '').slice(0, 2000),
    stack: String(entry.stack ?? '').slice(0, 8000),
  };
  try {
    const api = bridge();
    if (api?.write) api.write(payload);
    else remember(`[${payload.level}] ${payload.source} ${payload.message} ${payload.stack}`.trim());
  } catch {
    /* logging must never be the reason something breaks */
  }
}

/** `window.onerror` + `unhandledrejection`, installed once at boot. */
export function installErrorHooks(): void {
  window.addEventListener('error', (event) => {
    const err = (event as ErrorEvent).error as Error | undefined;
    logLine({
      level: 'error',
      source: 'window.onerror',
      message: (event as ErrorEvent).message || String(err ?? 'unknown error'),
      stack: err?.stack ?? '',
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason as { stack?: string; message?: string } | undefined;
    logLine({
      level: 'unhandled',
      source: 'window.unhandledrejection',
      message: reason?.message ?? String(reason ?? 'unknown rejection'),
      stack: reason?.stack ?? '',
    });
  });
}

/**
 * Sends `state` once a second. When the renderer stops sending, the main process
 * writes `[freeze] renderer silent for Ns — last state: …`, which is what tells
 * us whether the picture stopped in the lobby, in the countdown or mid-match.
 */
export function startHeartbeat(scene: () => GameScene | null): void {
  const tick = (): void => {
    try {
      const api = bridge();
      if (!api?.heartbeat) return;
      const live = scene();
      api.heartbeat(live ? live.logState() : 'menu');
    } catch {
      /* ignore */
    }
  };
  tick();
  window.setInterval(tick, 1000);
}

/** Errors from a previous run (browser build only — the desktop already has files). */
export function drainPreviousErrors(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    localStorage.removeItem(STORE_KEY);
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.slice(-KEEP).map(String) : [];
  } catch {
    return [];
  }
}

/** Where the desktop build is writing, for the error card / support answers. */
export async function logFolder(): Promise<string> {
  try {
    const api = bridge();
    if (!api?.folder) return '';
    const info = await api.folder();
    return info?.dir ?? '';
  } catch {
    return '';
  }
}

/** Opens the log folder in the OS file manager (desktop only). */
export async function revealLogs(): Promise<boolean> {
  try {
    return (await bridge()?.reveal?.()) ?? false;
  } catch {
    return false;
  }
}
