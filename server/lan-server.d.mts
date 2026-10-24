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
}): Promise<LanServerHandle>;

export function lanAddresses(): string[];
