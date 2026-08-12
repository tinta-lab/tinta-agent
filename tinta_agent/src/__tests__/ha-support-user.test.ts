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
  it('creates tinta-support with system-admin (client owner accepted the tradeoff)', async () => {
    const { haClient, sendCommand } = makeMockHA();

    sendCommand
      .mockResolvedValueOnce([])                          // config/auth/list → no existing user
      .mockRejectedValueOnce(new Error('not found'))      // auth_provider/homeassistant/delete → no orphaned credential
      .mockResolvedValueOnce({ user: { id: 'uid-1' } })  // config/auth/create
      .mockResolvedValueOnce({})                          // auth_provider/homeassistant/create
      .mockResolvedValueOnce({ storage: [] });            // person/list

    await setSupportUserActive(haClient, true, 'testpassword');

    const createCall = sendCommand.mock.calls.find(
      call => call[0]?.type === 'config/auth/create',
    );
    expect(createCall, 'config/auth/create was never called').toBeDefined();
    expect(createCall![0].group_ids).toEqual(['system-admin']);
  });

  it('frees an orphaned credential before recreating it, even when no user exists', async () => {
    const { haClient, sendCommand } = makeMockHA();

    sendCommand
      .mockResolvedValueOnce([])                          // config/auth/list → no existing user
      .mockResolvedValueOnce({})                          // auth_provider/homeassistant/delete → orphaned credential freed
      .mockResolvedValueOnce({ user: { id: 'uid-2' } })  // config/auth/create
      .mockResolvedValueOnce({})                          // auth_provider/homeassistant/create
      .mockResolvedValueOnce({ storage: [] });            // person/list

    await setSupportUserActive(haClient, true, 'testpassword');

    const deleteCredentialCall = sendCommand.mock.calls.find(
      call => call[0]?.type === 'config/auth_provider/homeassistant/delete',
    );
    expect(deleteCredentialCall, 'auth_provider/homeassistant/delete was never called').toBeDefined();
    expect(deleteCredentialCall![0].username).toBe('tinta-support');

    // Must happen before the credential is (re)created
    const deleteIdx = sendCommand.mock.calls.findIndex(c => c[0]?.type === 'config/auth_provider/homeassistant/delete');
    const createIdx = sendCommand.mock.calls.findIndex(c => c[0]?.type === 'config/auth_provider/homeassistant/create');
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(deleteIdx);
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

  it('cleans up every duplicate orphan user, not just the first', async () => {
    const { haClient, sendCommand } = makeMockHA();

    sendCommand
      .mockResolvedValueOnce([
        { id: 'uid-orphan-1', name: 'Tinta Support', system_generated: false },
        { id: 'uid-orphan-2', name: 'Tinta Support', system_generated: false },
        { id: 'uid-orphan-3', name: 'Tinta Support', system_generated: false },
      ])                                                    // config/auth/list → 3 leftover orphans
      .mockResolvedValueOnce({})                            // delete uid-orphan-1
      .mockResolvedValueOnce({})                            // delete uid-orphan-2
      .mockResolvedValueOnce({})                            // delete uid-orphan-3
      .mockRejectedValueOnce(new Error('not found'))        // auth_provider/homeassistant/delete
      .mockResolvedValueOnce({ user: { id: 'uid-fresh' } }) // config/auth/create
      .mockResolvedValueOnce({})                            // auth_provider/homeassistant/create
      .mockResolvedValueOnce({ storage: [] });              // person/list

    await setSupportUserActive(haClient, true, 'testpassword');

    const deleteCalls = sendCommand.mock.calls.filter(c => c[0]?.type === 'config/auth/delete');
    expect(deleteCalls.map(c => c[0].user_id)).toEqual(['uid-orphan-1', 'uid-orphan-2', 'uid-orphan-3']);
  });
});
