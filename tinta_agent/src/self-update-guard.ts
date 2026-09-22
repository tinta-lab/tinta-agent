import * as semver from 'semver';

// Defense-in-depth against a downgrade command reaching the Agent from a
// compromised/buggy backend or dashboard — see backend/src/common/agent-version.ts
// for the matching (independent) guard on the Tinta Lab side. This must
// not be the ONLY thing standing between an admin click and a real
// downgrade via HA Supervisor, but it must also not be the only thing
// missing if the backend guard is ever bypassed or has a bug of its own.
//
// An empty/missing targetVersion means "let HA Supervisor pick the latest
// from the store" (its own default behavior) — that's not a downgrade
// request, so it's always allowed through unchanged.
export function isSelfUpdateAllowed(installedVersion: string, targetVersion: string): boolean {
  if (!targetVersion) return true;
  if (semver.valid(installedVersion) === null || semver.valid(targetVersion) === null) {
    // Can't prove it's safe — refuse rather than risk an unvalidated downgrade.
    return false;
  }
  return semver.gte(targetVersion, installedVersion);
}
