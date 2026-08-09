import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSupportUserActive } from '../ha-support-user';
import type { HAWebSocketClient } from '../websocket-ha';

function makeMockHA() {
  const sendCommand = vi.fn();
  // Duck-type a minimal HAWebSocketClient
  const haClient = { sendCommand } as unknown as HAWebSocketClient;
  return { haClient, sendCommand };
}

describe('setSupportUserActive', () => {
  it('creates tinta-support with system-users (not system-admin)', async () => {
    const { haClient, sendCommand } = makeMockHA();

    sendCommand
      .mockResolvedValueOnce([])                          // config/auth/list → no existing user
      .mockResolvedValueOnce({ user: { id: 'uid-1' } })  // config/auth/create
      .mockResolvedValueOnce({})                          // auth_provider/homeassistant/create
      .mockResolvedValueOnce({ storage: [] });            // person/list

    await setSupportUserActive(haClient, true, 'testpassword');

    const createCall = sendCommand.mock.calls.find(
      call => call[0]?.type === 'config/auth/create',
    );
    expect(createCall, 'config/auth/create was never called').toBeDefined();
    expect(createCall![0].group_ids).toEqual(['system-users']);
    expect(createCall![0].group_ids).not.toContain('system-admin');
  });

  it('deletes support user on disable', async () => {
    const { haClient, sendCommand } = makeMockHA();

    sendCommand
      .mockResolvedValueOnce([{ id: 'uid-1', name: 'Tinta Support', system_generated: false }]) // list
      .mockResolvedValueOnce({}); // delete

    await setSupportUserActive(haClient, false);

    const deleteCall = sendCommand.mock.calls.find(
      call => call[0]?.type === 'config/auth/delete',
    );
    expect(deleteCall, 'config/auth/delete was never called').toBeDefined();
    expect(deleteCall![0].user_id).toBe('uid-1');
  });
});
