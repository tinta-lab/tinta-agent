import * as http from 'http';
import * as https from 'https';

// HA WebSocket API client using native ws
// home-assistant-js-websocket requires ESM, so we implement a minimal client
import { WebSocket } from 'ws';

interface HAConfig {
  host: string;
  port: number;
  token: string;
  ssl?: boolean;
}

type HAStateCallback = (states: Record<string, any>[]) => void;
type HAEventCallback = (event: Record<string, any>) => void;

export class HAWebSocketClient {
  private ws!: WebSocket;
  private msgId = 1;
  private pendingMap = new Map<number, { resolve: Function; reject: Function }>();
  private stateCallbacks: HAStateCallback[] = [];
  private eventCallbacks: HAEventCallback[] = [];
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly config: HAConfig) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = this.config.ssl ? 'wss' : 'ws';
      const url = `${proto}://${this.config.host}:${this.config.port}/api/websocket`;
      this.ws = new WebSocket(url);

      this.ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg, resolve, reject);
      });

      this.ws.on('error', (err: Error) => {
        console.error('[HA WS] Error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        this.connected = false;
        console.warn('[HA WS] Disconnected. Reconnecting in 5s...');
        this.reconnectTimer = setTimeout(() => this.connect().catch(console.error), 5000);
      });
    });
  }

  private handleMessage(msg: Record<string, any>, resolve?: Function, reject?: Function) {
    if (msg.type === 'auth_required') {
      this.ws.send(JSON.stringify({ type: 'auth', access_token: this.config.token }));
      return;
    }

    if (msg.type === 'auth_ok') {
      this.connected = true;
      resolve && resolve();
      return;
    }

    if (msg.type === 'auth_invalid') {
      reject && reject(new Error('HA auth invalid'));
      return;
    }

    if (msg.type === 'result') {
      const pending = this.pendingMap.get(msg.id);
      if (pending) {
        this.pendingMap.delete(msg.id);
        if (msg.success) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error?.message ?? 'HA error'));
      }
      return;
    }

    if (msg.type === 'event') {
      if (msg.event?.event_type === 'state_changed') {
        this.eventCallbacks.forEach(cb => cb(msg.event));
      }
    }
  }

  private send<T = any>(payload: Record<string, any>): Promise<T> {
    const id = this.msgId++;
    return new Promise((resolve, reject) => {
      this.pendingMap.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, id }));
    });
  }

  async getStates(): Promise<Record<string, any>[]> {
    return this.send({ type: 'get_states' });
  }

  async callService(domain: string, service: string, serviceData: Record<string, any>): Promise<any> {
    return this.send({
      type: 'call_service',
      domain,
      service,
      service_data: serviceData,
    });
  }

  async subscribeEvents(eventType = 'state_changed'): Promise<void> {
    await this.send({ type: 'subscribe_events', event_type: eventType });
  }

  onEvent(cb: HAEventCallback) {
    this.eventCallbacks.push(cb);
  }

  onStates(cb: HAStateCallback) {
    this.stateCallbacks.push(cb);
  }

  isConnected() {
    return this.connected;
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

// Get HA long-lived token via Supervisor API
export async function getSupervisorToken(): Promise<string> {
  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  if (!supervisorToken) throw new Error('SUPERVISOR_TOKEN not set');

  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: 'supervisor', port: 80, path: '/core/api/config', headers: { Authorization: `Bearer ${supervisorToken}` } },
      res => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data?.access_token) resolve(data.access_token);
            else resolve(supervisorToken); // fallback
          } catch {
            resolve(supervisorToken);
          }
        });
      },
    );
    req.on('error', () => resolve(supervisorToken));
  });
}
