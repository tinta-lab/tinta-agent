import { describe, it, expect } from 'vitest';
import { isSelfUpdateAllowed } from '../self-update-guard';

// Defense-in-depth guard, independent of the backend's own downgrade
// protection (tinta-lab backend/src/common/agent-version.ts). Even if the
// backend ever sends a bad target, the Agent itself must refuse to
// downgrade via HA Supervisor.
describe('isSelfUpdateAllowed', () => {
  it('allows a real update: 2026.9.1 → 2026.9.2', () => {
    expect(isSelfUpdateAllowed('2026.9.1', '2026.9.2')).toBe(true);
  });

  it('allows a no-op update to the same version', () => {
    expect(isSelfUpdateAllowed('2026.9.2', '2026.9.2')).toBe(true);
  });

  it('blocks the real-world regression: 2026.9.2 → 2026.8.3', () => {
    expect(isSelfUpdateAllowed('2026.9.2', '2026.8.3')).toBe(false);
  });

  it('blocks downgrade even across a major-looking jump: 2026.10.0 → 2026.9.2', () => {
    expect(isSelfUpdateAllowed('2026.10.0', '2026.9.2')).toBe(false);
  });

  it('compares numerically, not lexicographically: 2026.9.10 vs 2026.9.2', () => {
    expect(isSelfUpdateAllowed('2026.9.2', '2026.9.10')).toBe(true);
    expect(isSelfUpdateAllowed('2026.9.10', '2026.9.2')).toBe(false);
  });

  it('an empty target means "let Supervisor pick the latest" — always allowed', () => {
    expect(isSelfUpdateAllowed('2026.9.2', '')).toBe(true);
  });

  it('refuses when the target is malformed', () => {
    expect(isSelfUpdateAllowed('2026.9.2', 'not-a-version')).toBe(false);
  });

  it('refuses when the installed version itself is unparseable', () => {
    expect(isSelfUpdateAllowed('garbage', '2026.9.2')).toBe(false);
  });
});
