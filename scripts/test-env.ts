/**
 * Test-only shim: Vite injects `__APP_VERSION__` into the real build, so headless
 * scripts (tsx) would otherwise see '0.0.0' and the LAN version gate would
 * refuse every guest. Import this FIRST in a test script.
 */
import { readFileSync } from 'node:fs';

try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
  if (pkg.version) (globalThis as unknown as Record<string, unknown>).__APP_VERSION__ = pkg.version;
} catch {
  /* keep the '0.0.0' fallback */
}
