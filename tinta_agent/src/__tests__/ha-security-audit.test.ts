import { describe, it, expect, vi } from 'vitest';
import { snapshotAuthState, diffAuthState, remediateAuthAnomalies } from '../ha-security-audit';
import type { HAWebSocketClient } from '../websocket-ha';

function makeMockHA() {
  const sendCommand = vi.fn();
  const haClient = { sendCommand } as unknown as HAWebSocketClient;
  return { haClient, sendCommand };
}

describe('snapshotAuthState', () => {
  it('excludes the tinta-support user/username from the snapshot', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand
      .mockResolvedValueOnce([
        { id: 'owner-1', name: 'Owner', group_ids: ['system-admin'] },
        { id: 'support-1', name: 'Tinta Support', group_ids: ['system-admin'] },
      ])
      .mockResolvedValueOnce([{ username: 'owner' }, { username: 'tinta-support' }]);

    const snap = await snapshotAuthState(haClient);

    expect(snap.adminUserIds.has('owner-1')).toBe(true);
    expect(snap.adminUserIds.has('support-1')).toBe(false);
    expect(snap.usernames.has('owner')).toBe(true);
    expect(snap.usernames.has('tinta-support')).toBe(false);
  });

  it('degrades gracefully when config/auth_provider/homeassistant/list is unsupported', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand
      .mockResolvedValueOnce([{ id: 'owner-1', name: 'Owner', group_ids: [] }])
      .mockRejectedValueOnce(new Error('unknown_command'));

    const snap = await snapshotAuthState(haClient);
    expect(snap.usernames.size).toBe(0);
  });
});

describe('diffAuthState', () => {
  it('flags a new admin user created during the session', () => {
    const before = { adminUserIds: new Set(['owner-1']), usernames: new Set(['owner']), credentialIdsByUser: new Map() };
    const after = {
      adminUserIds: new Set(['owner-1', 'backdoor-1']),
      usernames: new Set(['owner']),
      credentialIdsByUser: new Map(),
    };

    const anomalies = diffAuthState(before, after);
    expect(anomalies).toEqual([
      expect.objectContaining({ type: 'new_admin_user', userId: 'backdoor-1' }),
    ]);
  });

  it('flags a new login credential created during the session', () => {
    const before = { adminUserIds: new Set<string>(), usernames: new Set(['owner']), credentialIdsByUser: new Map() };
    const after = { adminUserIds: new Set<string>(), usernames: new Set(['owner', 'sneaky']), credentialIdsByUser: new Map() };

    const anomalies = diffAuthState(before, after);
    expect(anomalies).toEqual([
      expect.objectContaining({ type: 'new_credential' }),
    ]);
  });

  it('flags an existing user whose credential set changed', () => {
    const before = {
      adminUserIds: new Set<string>(),
      usernames: new Set<string>(),
      credentialIdsByUser: new Map([['owner-1', new Set(['cred-a'])]]),
    };
    const after = {
      adminUserIds: new Set<string>(),
      usernames: new Set<string>(),
      credentialIdsByUser: new Map([['owner-1', new Set(['cred-b'])]]),
    };

    const anomalies = diffAuthState(before, after);
    expect(anomalies).toEqual([
      expect.objectContaining({ type: 'existing_user_credential_changed', userId: 'owner-1' }),
    ]);
  });

  it('reports nothing when nothing changed', () => {
    const state = { adminUserIds: new Set(['owner-1']), usernames: new Set(['owner']), credentialIdsByUser: new Map() };
    expect(diffAuthState(state, state)).toEqual([]);
  });
});

describe('remediateAuthAnomalies', () => {
  it('deletes only new_admin_user findings, leaves everything else untouched', async () => {
    const { haClient, sendCommand } = makeMockHA();
    sendCommand.mockResolvedValue({});

    await remediateAuthAnomalies(haClient, [
      { type: 'new_admin_user', detail: 'x', userId: 'backdoor-1' },
      { type: 'new_credential', detail: 'y' },
      { type: 'existing_user_credential_changed', detail: 'z', userId: 'owner-1' },
    ]);

    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({ type: 'config/auth/delete', user_id: 'backdoor-1' });
  });
});
