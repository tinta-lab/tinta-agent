import { HAWebSocketClient } from './websocket-ha';

const SUPPORT_NAME = 'Tinta Support';
const SUPPORT_USERNAME = 'tinta-support';
const ADMIN_GROUP = 'system-admin';

const log = (m: string) => console.log(`[HA Security Audit] ${m}`);

export interface AuthSnapshot {
  // admin (system-admin) user ids that existed BEFORE this support session,
  // excluding the tinta-support account itself
  adminUserIds: Set<string>;
  // usernames registered with the built-in `homeassistant` auth provider,
  // excluding tinta-support
  usernames: Set<string>;
  // per pre-existing user: the set of credential ids HA reports for them —
  // used only to notice an existing account's credential got replaced
  // (e.g. an admin-forced password reset via delete+recreate). Best-effort:
  // HA's `config/auth/list` doesn't always include `credentials`, and a
  // same-id in-place password change is invisible to this API either way —
  // see the comment on diffAuthState below.
  credentialIdsByUser: Map<string, Set<string>>;
}

export type AuthAnomaly =
  | { type: 'new_admin_user'; detail: string; userId: string }
  | { type: 'new_credential'; detail: string }
  | { type: 'existing_user_credential_changed'; detail: string; userId: string };

async function listAuthProviderUsernames(haClient: HAWebSocketClient): Promise<string[]> {
  try {
    const result = await haClient.sendCommand<any>({
      type: 'config/auth_provider/homeassistant/list',
    });
    const list: any[] = Array.isArray(result) ? result : (result?.users ?? []);
    return list.map((u) => u.username).filter(Boolean);
  } catch {
    // Command unsupported on this HA version — audit degrades gracefully
    // (loses the "new_credential" signal, keeps the others).
    return [];
  }
}

// Snapshot HA's auth state. Call once right after granting support access
// (so the fresh tinta-support user/credential is the baseline, not an
// "anomaly") and again right before revoking it (so we diff exactly the
// window a system-admin support session was active).
export async function snapshotAuthState(haClient: HAWebSocketClient): Promise<AuthSnapshot> {
  const users = await haClient.sendCommand<any[]>({ type: 'config/auth/list' });

  const adminUserIds = new Set<string>();
  const credentialIdsByUser = new Map<string, Set<string>>();
  for (const u of users) {
    if (u.name === SUPPORT_NAME) continue;
    if (Array.isArray(u.group_ids) && u.group_ids.includes(ADMIN_GROUP)) {
      adminUserIds.add(u.id);
    }
    if (Array.isArray(u.credentials)) {
      credentialIdsByUser.set(u.id, new Set(u.credentials.map((c: any) => c.id ?? c.auth_provider_id ?? JSON.stringify(c))));
    }
  }

  const allUsernames = await listAuthProviderUsernames(haClient);
  const usernames = new Set(allUsernames.filter((u) => u !== SUPPORT_USERNAME));

  return { adminUserIds, usernames, credentialIdsByUser };
}

// Compares the "before" and "after" snapshots of a single support session.
// Everything found here was created or changed while a system-admin account
// (tinta-support) existed on this HA instance. We can't tell whether it was
// the client themselves or the support employee who did it — that ambiguity
// is exactly why every finding is surfaced to a human rather than silently
// dropped or silently trusted.
//
// Known blind spot: an admin can change an EXISTING user's password in place
// via HA's own "reset password" flow without changing that user's id or
// (necessarily) their credential id, and HA's websocket API does not expose
// password hashes or change timestamps to diff against. This audit cannot
// see that case. Mitigation for that gap lives in the RUNBOOK, not code —
// see the "if in doubt, rotate your own password" note added there.
export function diffAuthState(before: AuthSnapshot, after: AuthSnapshot): AuthAnomaly[] {
  const anomalies: AuthAnomaly[] = [];

  for (const id of after.adminUserIds) {
    if (!before.adminUserIds.has(id)) {
      anomalies.push({
        type: 'new_admin_user',
        detail: `Новый администратор HA создан во время сессии поддержки (user_id: ${id})`,
        userId: id,
      });
    }
  }

  for (const username of after.usernames) {
    if (!before.usernames.has(username)) {
      anomalies.push({
        type: 'new_credential',
        detail: `Новый логин/пароль создан во время сессии поддержки: "${username}"`,
      });
    }
  }

  for (const [userId, beforeCreds] of before.credentialIdsByUser) {
    const afterCreds = after.credentialIdsByUser.get(userId);
    if (!afterCreds) continue;
    const changed =
      beforeCreds.size !== afterCreds.size ||
      [...beforeCreds].some((c) => !afterCreds.has(c));
    if (changed) {
      anomalies.push({
        type: 'existing_user_credential_changed',
        detail: `Учётные данные существующего пользователя изменены во время сессии поддержки (user_id: ${userId})`,
        userId,
      });
    }
  }

  return anomalies;
}

// Best-effort auto-remediation: delete admin users created during the
// session so a backdoor account can't outlive the revoke. Deliberately does
// NOT touch existing users or their credentials — we have no way to know
// what a legitimate prior password was, and deleting a real client account
// would lock them out. Those findings are reported, not auto-fixed.
export async function remediateAuthAnomalies(
  haClient: HAWebSocketClient,
  anomalies: AuthAnomaly[],
): Promise<void> {
  for (const a of anomalies) {
    if (a.type !== 'new_admin_user') continue;
    try {
      await haClient.sendCommand({ type: 'config/auth/delete', user_id: a.userId });
      log(`Auto-removed unexpected admin user ${a.userId} created during support session`);
    } catch (e: any) {
      log(`Failed to auto-remove ${a.userId}: ${e.message}`);
    }
  }
}
