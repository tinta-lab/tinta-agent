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

export interface DiagnosticsReport {
  clientId: string;
  agentVersion: string;
  haVersion: string;
  haConnected: boolean;
  uptimeSeconds: number;
  nodeVersion: string;
  platform: string;
  cpuPercent: number;
  memPercent: number;
  diskPercent: number;
  timestamp: string;
}

type CommandHandler = (cmd: TintaCommand) => Promise<void>;
type TemplateHandler = (template: GoldenTemplate) => Promise<void>;
type DiagnosticsProvider = () => DiagnosticsReport;
type SupportAccessHandler = (enabled: boolean, password?: string) => Promise<void>;

export class TintaCoreSocket {
  private socket!: Socket;
  private commandHandler: CommandHandler | null = null;
  private templateHandler: TemplateHandler | null = null;
  private diagnosticsProvider: DiagnosticsProvider | null = null;
  private supportAccessHandler: SupportAccessHandler | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly coreWsUrl: string,
    private readonly clientId: string,
    private readonly agentToken: string,
    private readonly agentVersion: string,
    private readonly haVersion: string,
  ) {}

  connect() {
    log('Connecting to', this.coreWsUrl);

    this.socket = io(this.coreWsUrl, {
      auth: { token: this.agentToken, clientId: this.clientId },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 30000,
      timeout: 10000,
    });

    this.socket.on('connect', () => {
      log('Connected');
      this.socket.emit('register', {
        clientId: this.clientId,
        jwt: this.agentToken,
        agentVersion: this.agentVersion,
        haVersion: this.haVersion,
      });
      this.startHeartbeat();
    });

    this.socket.on('disconnect', (reason: string) => {
      log('Disconnected:', reason);
      this.stopHeartbeat();
    });

    this.socket.on('connect_error', (err: Error) => {
      log('Connection error:', err.message);
    });

    this.socket.on('command', async (cmd: TintaCommand) => {
      log(`Command: ${cmd.entityType}.${cmd.action} → ${cmd.haEntityId}`);
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
      log('Apply template:', template.slug);
      if (this.templateHandler) {
        try {
          await this.templateHandler(template);
          this.socket.emit('template_result', { success: true, slug: template.slug });
        } catch (err: any) {
          this.socket.emit('template_result', { success: false, slug: template.slug, error: err.message });
        }
      }
    });

    // Remote diagnostics request from Core
    this.socket.on('diagnostics_request', () => {
      log('Diagnostics requested by Core');
      if (this.diagnosticsProvider) {
        const report = this.diagnosticsProvider();
        this.socket.emit('diagnostics_report', report);
        log('Diagnostics sent');
      }
    });

    // Support access toggle from Tinta Core
    this.socket.on('set_support_access', async ({ enabled, password }: { enabled: boolean; password?: string }) => {
      log(`Support access: ${enabled ? 'ENABLE' : 'DISABLE'}`);
      if (this.supportAccessHandler) {
        try { await this.supportAccessHandler(enabled, password); }
        catch (e: any) { log('Support access handler error:', e.message); }
      }
    });

    // Remote log request: return last N lines of stdout (if available)
    this.socket.on('logs_request', ({ lines = 50 }: { lines?: number }) => {
      log(`Log upload requested (${lines} lines)`);
      this.socket.emit('logs_report', {
        clientId: this.clientId,
        message: 'Log streaming not yet implemented — check PM2 logs on host',
        timestamp: new Date().toISOString(),
      });
    });
  }

  onCommand(handler: CommandHandler) { this.commandHandler = handler; }
  onApplyTemplate(handler: TemplateHandler) { this.templateHandler = handler; }
  onDiagnostics(provider: DiagnosticsProvider) { this.diagnosticsProvider = provider; }
  onSupportAccess(handler: SupportAccessHandler) { this.supportAccessHandler = handler; }

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

  isConnected() { return this.socket?.connected ?? false; }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('heartbeat', {
          clientId: this.clientId,
          ts: Date.now(),
        });
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

function log(...args: any[]) {
  console.log(`[Tinta Core] ${args.join(' ')}`);
}
