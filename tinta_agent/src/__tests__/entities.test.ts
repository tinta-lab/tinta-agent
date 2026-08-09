import { describe, it, expect } from 'vitest';
import { buildHACommand } from '../entities';

describe('buildHACommand', () => {
  it('maps light domain correctly', () => {
    const cmd = buildHACommand('light.living_room', 'on');
    expect(cmd.domain).toBe('light');
    expect(cmd.service).toBe('turn_on');
  });

  it('throws on unknown entity type instead of forwarding arbitrary service', () => {
    expect(() => buildHACommand('shell_command.dangerous', 'exec'))
      .toThrow('Unknown entity type: shell_command');

    expect(() => buildHACommand('script.malicious', 'turn_on'))
      .toThrow('Unknown entity type: script');
  });

  it('does not return a command object for unknown domains', () => {
    expect(() => buildHACommand('notify.mobile_app', 'send'))
      .toThrow();
  });
});
