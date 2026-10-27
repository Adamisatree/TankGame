/**
 * Zero-configuration LAN discovery.
 *
 * The host broadcasts a tiny UDP beacon; a guest listens for one second and
 * gets the IP + port of every room on the network. That is what powers the
 * "扫描局域网房间" button, so nobody has to know their own IP address.
 */
const dgram = require('node:dgram');
const os = require('node:os');

const DISCOVERY_PORT = 41234;
const MAGIC = 'tankgame-lan-v1';

/** @param {number} gamePort */
function startBeacon(gamePort) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  });

  socket.bind(() => {
    try {
      socket.setBroadcast(true);
    } catch {
      /* some networks disallow it */
    }
  });

  const payload = JSON.stringify({ magic: MAGIC, name: os.hostname(), port: gamePort });

  const announce = () => {
    for (const address of broadcastAddresses()) {
      try {
        socket.send(payload, DISCOVERY_PORT, address);
      } catch {
        /* keep trying the other targets */
      }
    }
  };

  announce();
  const timer = setInterval(announce, 2000);
  timer.unref?.();

  return {
    close() {
      clearInterval(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * The address a friend should type. Prefer a routable IPv4 over the machine
 * name: plenty of home/DHCP setups cannot resolve `<hostname>` from another
 * computer, which made the copied LAN address useless (E3).
 */
function localIPv4() {
  const interfaces = os.networkInterfaces();
  const entries = Object.values(interfaces).flatMap((list) => list || []);
  // v1.6.2: WSL / Hyper-V / VPN adapters (172.x) are often listed first, so the
  // "copy my LAN address" menu item handed out an address no other machine on
  // the Wi-Fi can reach. Ask the OS which interface the default route uses and
  // prefer that one; fall back to the old heuristic when there is no route.
  const primary = primaryInterfaceName();
  if (primary) {
    const hit = (interfaces[primary] || []).find((net) => net.family === 'IPv4' && !net.internal && net.address);
    if (hit) return hit.address;
  }
  const usable = entries.find((net) => net.family === 'IPv4' && !net.internal && net.address);
  if (usable) {
    // Prefer the private (192.168/10.x/172.16) ones Windows/macOS hand out first.
    const priv = entries.find(
      (net) => net.family === 'IPv4' && !net.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(net.address)
    );
    return (priv ?? usable).address;
  }
  return os.hostname();
}

/** Name of the interface carrying the default route, or '' when unknown. */
function primaryInterfaceName() {
  try {
    // `os.networkInterfaces()` is unordered, but the routing table is not: the
    // interface with a 0.0.0.0 route is the one the internet (and the LAN)
    // actually uses.
    const { execFileSync } = require('node:child_process');
    if (process.platform === 'win32') {
      const out = execFileSync('route', ['print', '-4'], { encoding: 'utf8', timeout: 1500 });
      const line = out.split('\n').find((row) => /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\S+)/.test(row));
      const match = line?.match(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+\S+\s+(\S+)/);
      if (match) {
        const address = match[1];
        for (const [name, list] of Object.entries(os.networkInterfaces())) {
          if ((list || []).some((net) => net.address === address)) return name;
        }
      }
      return '';
    }
    const out = execFileSync('sh', ['-c', "ip route show default 2>/dev/null || route -n get default 2>/dev/null"], {
      encoding: 'utf8',
      timeout: 1500,
    });
    const dev = out.match(/dev\s+(\S+)/)?.[1] ?? out.match(/interface:\s*(\S+)/)?.[1] ?? '';
    if (dev && os.networkInterfaces()[dev]) return dev;
    return '';
  } catch {
    return '';
  }
}

function broadcastAddresses() {
  const out = new Set(['255.255.255.255', '127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // Derive the /24 broadcast address – good enough for home networks.
      const parts = net.address.split('.').map(Number);
      if (parts.length === 4) out.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    }
  }
  return [...out];
}

/**
 * Listens briefly for host beacons.
 * @param {number} timeoutMs
 * @returns {Promise<{ name: string, host: string, port: number }[]>}
 */
function scanForHosts(timeoutMs = 1300) {
  return new Promise((resolve) => {
    /** @type {Map<string, { name: string, host: string, port: number }>} */
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const finish = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      // One entry per host+port: prefer a routable address over loopback.
      // v1.6.2: the old key was `name:port`, so two identical names on different
      // machines (or one machine renaming itself) collapsed into one entry.
      const byRoom = new Map();
      for (const item of found.values()) {
        const key = `${item.host}:${item.port}`;
        const prev = byRoom.get(key);
        if (!prev || (prev.host === '127.0.0.1' && item.host !== '127.0.0.1')) byRoom.set(key, item);
      }
      resolve([...byRoom.values()]);
    };

    socket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(String(msg));
        if (!data || data.magic !== MAGIC) return;
        // v1.6.2: the port used to be taken as-is (a beacon could claim 0 or
        // 99999 and the join dialog would build a dead address), and the name was
        // whatever the sender felt like sending, at any length.
        const port = Number(data.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return;
        const name = String(data.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 48) || 'TankGame 房间';
        const host = rinfo.address;
        // One room per address+port; loopback beats nothing, nothing beats it.
        const key = `${host}:${port}`;
        if (host !== '127.0.0.1' || !found.has(key)) {
          found.set(key, { name, host, port });
        }
      } catch {
        /* not ours */
      }
    });

    socket.on('error', () => finish());
    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
      // Nudge loopback hosts (two windows on one machine).
      try {
        socket.send(JSON.stringify({ magic: 'tankgame-query' }), DISCOVERY_PORT, '127.0.0.1');
      } catch {
        /* ignore */
      }
    });

    const timer = setTimeout(finish, timeoutMs);
  });
}

module.exports = { startBeacon, scanForHosts, localIPv4, DISCOVERY_PORT, MAGIC };
