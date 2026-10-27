/**
 * Boots the bundled LAN server from inside the desktop build.
 * Kept separate from main.cjs so it can be tested without Electron.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * @param {{ appRoot: string, ports?: number[], logLine?: (line: string) => void }} options
 * @returns {Promise<{ server: import('node:http').Server, port: number, addresses: string[], close: () => Promise<void> }>}
 */
async function startLanServer({ appRoot, ports = [8787, 8788, 8789, 0], logLine }) {
  process.env.TANK_DIST = path.join(appRoot, 'dist');
  const entry = path.join(appRoot, 'server', 'lan-server.mjs');
  const mod = await import(pathToFileURL(entry).href);

  let lastError = null;
  for (const port of ports) {
    try {
      // v1.6.4: refusals, disconnects and crashes go to `log\tankgame-server.log`.
      return await mod.createLanServer({ port, host: '0.0.0.0', quiet: true, logLine });
    } catch (err) {
      lastError = err;
      // EADDRINUSE means "try the next port"; anything else is fatal.
      if (err && err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastError ?? new Error('could not start the LAN server');
}

module.exports = { startLanServer };
