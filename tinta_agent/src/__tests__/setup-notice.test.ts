import { describe, it, expect } from 'vitest';
import { buildSetupNotice, installPageUrl, pickLang } from '../setup-notice';

describe('setup notice', () => {
  it('follows the HA language and falls back to English', () => {
    expect(pickLang('de')).toBe('de');
    expect(pickLang('ru-RU')).toBe('ru');
    expect(pickLang('fr')).toBe('en');
    expect(pickLang(undefined)).toBe('en');
  });

  it('derives the install page from the Core API host', () => {
    expect(installPageUrl('https://api.tinta-lab.de', 'abc')).toBe('https://app.tinta-lab.de/install/abc');
  });

  it('puts the consent link into the waiting-for-consent notice', () => {
    const n = buildSetupNotice('de', { kind: 'waiting_consent' }, 'https://app.tinta-lab.de/install/abc');
    expect(n.notification_id).toBe('tinta_agent_setup');
    expect(n.message).toContain('https://app.tinta-lab.de/install/abc');
    expect(n.message).toContain('bestätigen');
  });
});
