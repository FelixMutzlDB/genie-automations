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
    const geniePlugin = readFileSync(
      new URL('../node_modules/@databricks/appkit/dist/plugins/genie/genie.js', import.meta.url),
      'utf8'
    );
    const pluginBlock = server.slice(server.indexOf('plugins: ['), server.indexOf('onPluginsReady'));
    const toolBlock = recon.slice(recon.indexOf('const TOOLS = ['), recon.indexOf('const SYSTEM_PROMPT'));
    const forbiddenMutationPaths =
      /stage_change|proposed_changes|approve(?:_change)?|commit(?:_change)?|ingest|lakebase\.(?:query|asUser)|\b(?:insert|update|delete|merge)\b/i;

    expect(pluginBlock.match(/\bgenie\(\)/g)).toHaveLength(1);
    expect(pluginBlock).not.toMatch(forbiddenMutationPaths);
    expect(server).not.toContain('setupGenieRoutes');
    expect(toolBlock).not.toMatch(/genie|ask_data/i);
    expect(toolBlock).not.toMatch(/\/api\/genie/i);

    // AppKit owns the isolated /api/genie route tree. Its built-in handlers
    // always enter user context and expose conversation reads only.
    expect(geniePlugin).toContain('path: "/:alias/messages"');
    expect(geniePlugin).toContain('path: "/:alias/conversations/:conversationId"');
    expect(geniePlugin).toContain('this.asUser(req)._handleSendMessage');
    expect(geniePlugin).toContain('this.asUser(req)._handleGetConversation');
    expect(geniePlugin).not.toMatch(forbiddenMutationPaths);
  });

});
