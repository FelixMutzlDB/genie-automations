import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AppKit Genie read path', () => {
  it('declares the read-only Genie resource and OBO scope', () => {
    const bundle = readFileSync(new URL('../databricks.yml', import.meta.url), 'utf8');
    const appManifest = readFileSync(new URL('../app.yaml', import.meta.url), 'utf8');

    expect(bundle).toContain('- dashboards.genie');
    expect(bundle).toContain('genie_space:');
    expect(bundle).toContain('permission: CAN_RUN');
    expect(appManifest).toContain('name: DATABRICKS_GENIE_SPACE_ID');
    expect(appManifest).toContain('valueFrom: genie-space');
  });

  it('keeps Genie separate from the reconciliation tool loop and mutation routes', () => {
    const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
    const recon = readFileSync(new URL('./routes/recon.ts', import.meta.url), 'utf8');
    const toolBlock = recon.slice(recon.indexOf('const TOOLS = ['), recon.indexOf('const SYSTEM_PROMPT'));

    expect(server).toContain('genie()');
    expect(server).not.toContain('setupGenieRoutes');
    expect(toolBlock).not.toMatch(/genie|ask_data/i);
  });
});
