import { io, Socket } from 'socket.io-client';

export interface TintaCommand {
  entityType: string;
  haEntityId: string;
  action: string;
  data?: Record<string, any>;
}

export interface GoldenTemplate {
  slug: string;
  name: string;
  automation: Record<string, any>;
}

type CommandHandler = (cmd: TintaCommand) => Promise<void>;
type TemplateHandler = (template: GoldenTemplate) => Promise<void>;

export class TintaCoreSocket {
  private socket!: Socket;
  private commandHandler: CommandHandler | null = null;
  private templateHandler: TemplateHandler | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly coreWsUrl: string,
    private readonly clientId: string,
    private readonly agentToken: string,
    private readonly agentVersion: string,
    private readonly haVersion: string,
  ) {}

  connect() {
    console.log(`[Tinta Core] Connecting to ${this.coreWsUrl}...`);

    this.socket = io(this.coreWsUrl, {
      auth: { token: this.agentToken, clientId: this.clientId },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
      timeout: 10000,
    });

    this.socket.on('connect', () => {
      console.log('[Tinta Core] Connected');
      this.socket.emit('register', {
        clientId: this.clientId,
        jwt: this.agentToken,
        agentVersion: this.agentVersion,
        haVersion: this.haVersion,
      });
      this.startHeartbeat();
    });

    this.socket.on('disconnect', (reason: string) => {
      console.warn(`[Tinta Core] Disconnected: ${reason}`);
      this.stopHeartbeat();
    });

    this.socket.on('connect_error', (err: Error) => {
      console.error(`[Tinta Core] Connection error: ${err.message}`);
    });

    this.socket.on('command', async (cmd: TintaCommand) => {
      console.log(`[Tinta Core] Command received: ${cmd.entityType}.${cmd.action} → ${cmd.haEntityId}`);
      if (this.commandHandler) {
        try {
          await this.commandHandler(cmd);
          this.socket.emit('result', { success: true, haEntityId: cmd.haEntityId });
        } catch (err: any) {
          this.socket.emit('result', { success: false, error: err.message });
        }
      }
    });

    this.socket.on('apply_template', async (template: GoldenTemplate) => {
      console.log(`[Tinta Core] Apply template: ${template.slug}`);
      if (this.templateHandler) {
        try {
          await this.templateHandler(template);
          this.socket.emit('template_result', { success: true, slug: template.slug });
        } catch (err: any) {
          this.socket.emit('template_result', { success: false, slug: template.slug, error: err.message });
        }
      }
    });
  }

  onCommand(handler: CommandHandler) {
    this.commandHandler = handler;
  }

  onApplyTemplate(handler: TemplateHandler) {
    this.templateHandler = handler;
  }

  sendStateUpdate(entities: Record<string, any>[]) {
    if (this.socket?.connected) {
      this.socket.emit('state_update', { clientId: this.clientId, entities });
    }
  }

  sendMetrics(metrics: {
    clientId: string;
    cpuPercent: number;
    memPercent: number;
    diskPercent: number;
    deviceCount: number;
    automationCount: number;
    uptimeSeconds: number;
  }) {
    if (this.socket?.connected) {
      this.socket.emit('metrics', metrics);
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('heartbeat', { clientId: this.clientId });
      }
    }, 30_000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  disconnect() {
    this.stopHeartbeat();
    this.socket?.disconnect();
  }
}
