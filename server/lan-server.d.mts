import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';

export interface LanServerHandle {
  server: Server;
  wss: WebSocketServer;
  port: number;
  addresses: string[];
  close: () => Promise<void>;
  stats: () => { players: number; totalPlayers: number };
}

export function createLanServer(options?: {
  port?: number;
  host?: string;
  quiet?: boolean;
  /**
   * v1.5.4 backpressure watermarks (bytes of queued socket data).
   * Deltas stop for a connection past `coalesceBacklog`; past `slowBacklog`
   * the connection is dropped and its client reconnects. Production uses
   * 64 KB / 1 MB; tests inject tiny values.
   */
  coalesceBacklog?: number;
  slowBacklog?: number;
  /**
   * v1.6: how often (ms) sockets that stopped answering pings are culled.
   * Default 15 s. The backpressure tests raise it, because they stall a client
   * on purpose (which also stops its pong replies).
   */
  heartbeatMs?: number;
}): Promise<LanServerHandle>;

export function lanAddresses(): string[];
