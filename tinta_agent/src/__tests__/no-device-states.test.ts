import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Device names and states stay in the client's home (Tinta Lab Datenschutz).
// The agent used to forward them as `state_update`; this guards against the
// event — or a state forward on Home Assistant events — coming back.
const SRC = join(__dirname, '..');
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(SRC, f), 'utf8') }));

describe('device states never leave the home', () => {
  it('no source emits state_update', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/['"]state_update['"]/);
      expect(text, file).not.toMatch(/sendStateUpdate/);
    }
  });

  it('Home Assistant states are not mapped for sending', () => {
    const agent = sources.find((s) => s.file === 'agent.ts')!.text;
    expect(agent).not.toMatch(/haStateToTintaEntity/);
  });
});
