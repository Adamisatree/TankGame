import {
  PROTOCOL_VERSION,
  resolveSocketUrl,
  type HostMessage,
  type NetRole,
  type ServerMessage,
  type Snapshot,
  type TankInput,
} from './protocol';
import { APP_VERSION } from '../version';

export type LanStatus = 'idle' | 'connecting' | 'waiting' | 'playing' | 'closed' | 'error' | 'rejected';

export interface LanHandlers {
  onStatus?: (status: LanStatus, detail?: string) => void;
  onSnapshot?: (snap: Snapshot) => void;
  onInput?: (input: TankInput) => void;
  onHostMessage?: (msg: HostMessage) => void;
  /** Fired when the other player joins or leaves. */
  onPeer?: (state: 'joined' | 'left') => void;
  /** The other player's summoner skill choice, announced when pairing. */
  onPeerSkill?: (skill: string) => void;
  onLog?: (line: string) => void;
  /** The other side quit on purpose (not a dropped connection). */
  onSurrender?: (by: string) => void;
}

/**
 * Thin WebSocket wrapper. The host pushes snapshots and consumes `onInput`;
 * the guest consumes `onSnapshot` and pushes input. No game logic lives here.
 */
export class LanClient {
  readonly role: NetRole;
  private ws: WebSocket | null = null;
  private handlers: LanHandlers;
  private seq = 0;
  private status: LanStatus = 'idle';
  private retry = 0;
  private closedByUser = false;
  private retryTimer: number | null = null;
  private url: string;
  /** Summoner skill this machine picked; sent with the join message. */
  skill = '';

  constructor(role: NetRole, serverAddress: string, handlers: LanHandlers = {}) {
    this.role = role;
    this.url = resolveSocketUrl(serverAddress);
    this.handlers = handlers;
  }

  get address(): string {
    return this.url;
  }

  get currentStatus(): LanStatus {
    return this.status;
  }

  private setStatus(status: LanStatus, detail?: string): void {
    this.status = status;
    this.handlers.onStatus?.(status, detail);
  }

  connect(): void {
    this.clearRetry();
    this.closedByUser = false;
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.setStatus('error', String(err));
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      ws.send(
        JSON.stringify({
          t: 'join',
          role: this.role,
          skill: this.skill || undefined,
          version: APP_VERSION,
          protocol: PROTOCOL_VERSION,
        })
      );
      this.setStatus('waiting');
      this.handlers.onLog?.(`已连接 ${this.url}`);
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'reject':
          // Different build: refuse clearly instead of desyncing five seconds in.
          this.closedByUser = true;
          this.setStatus(
            'rejected',
            msg.reason === 'version'
              ? `版本不一致：房主 ${msg.hostVersion ?? '?'}，你是 ${msg.yourVersion ?? APP_VERSION}。请两边用同一版本。`
              : '房间拒绝了这次连接。'
          );
          try {
            this.ws?.close();
          } catch {
            /* already gone */
          }
          break;
        case 'surrender':
          // Relayed by the server when the other side quits on purpose.
          this.handlers.onSurrender?.(msg.by);
          break;
        case 'joined':
          if (msg.skill) this.handlers.onPeerSkill?.(msg.skill);
          if (this.role === 'guest' && msg.host) this.setStatus('playing');
          break;
        case 'paired':
          if (msg.skill) this.handlers.onPeerSkill?.(msg.skill);
          this.setStatus('playing');
          this.handlers.onPeer?.('joined');
          this.handlers.onLog?.('对手已加入');
          break;
        case 'peer':
          if (msg.skill) this.handlers.onPeerSkill?.(msg.skill);
          this.handlers.onPeer?.(msg.state);
          if (msg.state === 'joined') this.setStatus('playing');
          if (msg.state === 'left') this.setStatus('waiting', '对手已离开');
          break;
        case 'input':
          this.handlers.onInput?.(msg.input);
          break;
        case 'bye':
          this.handlers.onLog?.('连接结束');
          break;
        case 'replaced':
          this.handlers.onLog?.('房间被同一角色的新连接取代');
          break;
        default:
          break;
      }

      // Host messages (state/start/restart/chat) reach guests here.
      const maybe = msg as unknown as HostMessage;
      if (maybe && (maybe.t === 'state' || maybe.t === 'start' || maybe.t === 'restart' || maybe.t === 'chat')) {
        if (maybe.t === 'state') this.handlers.onSnapshot?.(maybe);
        else this.handlers.onHostMessage?.(maybe);
      }
    };

    ws.onerror = () => {
      this.setStatus('error', '无法连接，请检查地址 / 防火墙');
    };

    ws.onclose = () => {
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      // One quick automatic retry keeps a flaky Wi-Fi hiccup from ending the match.
      if (this.retry < 2) {
        this.retry += 1;
        this.setStatus('connecting', `连接中断，重试中 (${this.retry}/2)`);
        this.clearRetry();
        this.retryTimer = window.setTimeout(() => {
          this.retryTimer = null;
          if (!this.closedByUser) this.connect();
        }, 900);
      } else {
        this.setStatus('closed', '连接已断开');
      }
    };
  }

  /** 30Hz guest → host. */
  sendInput(input: TankInput): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.role !== 'guest') return;
    this.seq += 1;
    this.ws.send(JSON.stringify({ t: 'input', input, seq: this.seq }));
  }

  /** 30Hz host → guest. */
  sendSnapshot(snap: Snapshot): void {
    this.send(snap);
  }

  send(message: HostMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  close(): void {
    this.closedByUser = true;
    this.clearRetry();
    const ws = this.ws;
    this.ws = null;
    // Drop the handlers first: a socket closing during teardown must not trigger
    // a reconnect or touch a scene that is already shutting down.
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    this.status = 'closed';
  }
}

/** Best-effort LAN address list, used by the host panel to tell friends where to go. */
export async function fetchLanInfo(
  serverAddress: string
): Promise<{ addresses: string[]; players: number; port?: number } | null> {
  try {
    const socket = resolveSocketUrl(serverAddress);
    const base = socket.replace(/^ws/, 'http').replace(/\/ws$/, '');
    const res = await fetch(`${base}/info`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { addresses: string[]; players: number; port?: number };
  } catch {
    return null;
  }
}
