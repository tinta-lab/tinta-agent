import { HAWebSocketClient } from './websocket-ha';

export const ACCESS_TOGGLE_ENTITY = 'input_boolean.tinta_support_access';

const log = (m: string) => console.log(`[HA Toggle] ${m}`);

export async function ensureAccessToggleEntity(haClient: HAWebSocketClient): Promise<void> {
  try {
    const items = await haClient.sendCommand<any[]>({ type: 'input_boolean/list' });
    const existing = (items ?? []).find((item: any) => item.id === 'tinta_support_access');
    if (existing) {
      log('input_boolean.tinta_support_access exists ✓');
      return;
    }
    await haClient.sendCommand({
      type: 'input_boolean/create',
      name: 'Tinta Support Access',
      icon: 'mdi:shield-account',
    });
    log('input_boolean.tinta_support_access created ✓');
  } catch (e: any) {
    log(`Warning: ${e.message}`);
  }
}

export async function setAccessToggle(haClient: HAWebSocketClient, state: boolean): Promise<void> {
  try {
    await haClient.callService(
      'input_boolean',
      state ? 'turn_on' : 'turn_off',
      { entity_id: ACCESS_TOGGLE_ENTITY },
    );
  } catch (e: any) {
    log(`Warning setting toggle to ${state}: ${e.message}`);
  }
}
