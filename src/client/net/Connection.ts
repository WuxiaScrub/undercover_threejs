import {
  PROTOCOL_VERSION,
  decode,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '../../shared/net';
import type { Role } from '../../shared/roles';

export type ConnectionStatus = 'offline' | 'connecting' | 'online' | 'error';

const RETRY_DELAY_MS = 2000;

/**
 * Transport only. It knows how to open a socket, say hello and hand typed
 * messages up; it knows nothing about the game. Swapping WebSockets for
 * Steam networking later should not require touching anything above this file.
 */
export class Connection {
  status: ConnectionStatus = 'offline';
  /** Populated on failure, shown in the connect panel. */
  detail = '';

  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (status: ConnectionStatus, detail: string) => void = () => {};

  private socket: WebSocket | null = null;
  private url = '';
  private name = '';
  private role: Role = 'doctor';
  /** True between connect() and disconnect(); drives automatic retries. */
  private wanted = false;
  private retryTimer: number | null = null;

  get connected(): boolean {
    return this.status === 'online';
  }

  connect(url: string, name: string, role: Role): void {
    this.disconnect();
    this.url = url;
    this.name = name;
    this.role = role;
    this.wanted = true;
    this.open();
  }

  disconnect(): void {
    this.wanted = false;
    this.clearRetry();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    this.setStatus('offline', '');
  }

  send(msg: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encode(msg));
  }

  /** Role changes must survive a reconnect, so keep our copy current. */
  setRole(role: Role): void {
    this.role = role;
  }

  private open(): void {
    this.setStatus('connecting', this.url);

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.setStatus('error', 'bad server address');
      this.wanted = false;
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.setStatus('online', '');
      this.send({ t: 'join', protocol: PROTOCOL_VERSION, name: this.name, role: this.role });
    };

    socket.onmessage = (event) => {
      const msg = decode<ServerMessage>(String(event.data));
      if (!msg) return;
      // A rejection is final: retrying would only be refused again.
      if (msg.t === 'reject') {
        this.wanted = false;
        this.detail = msg.reason;
      }
      this.onMessage(msg);
    };

    socket.onerror = () => {
      if (this.status !== 'online') this.setStatus('error', 'no server at that address');
    };

    socket.onclose = () => {
      if (this.socket !== socket) return; // superseded by a newer attempt
      this.socket = null;
      if (this.wanted) {
        this.setStatus('connecting', 'reconnecting…');
        this.retryTimer = window.setTimeout(() => this.open(), RETRY_DELAY_MS);
      } else {
        this.setStatus(this.detail ? 'error' : 'offline', this.detail);
      }
    };
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setStatus(status: ConnectionStatus, detail: string): void {
    this.status = status;
    this.detail = detail;
    this.onStatus(status, detail);
  }
}

/** Default server for this page: whoever served the client is hosting the game. */
export function defaultServerUrl(): string {
  const host = window.location.hostname || 'localhost';
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}:3000`;
}
