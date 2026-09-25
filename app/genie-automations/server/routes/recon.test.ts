import { afterEach, describe, expect, it } from 'vitest';
import { coworkerInvocationsUrl } from './recon';

afterEach(() => {
  delete process.env['DATABRICKS_HOST'];
  delete process.env['COWORKER_FM_ENDPOINT'];
});

describe('co-worker Model Serving URL', () => {
  it('normalizes a scheme-less host and removes its trailing slash', () => {
    process.env['DATABRICKS_HOST'] = 'workspace.cloud.databricks.com/';

    expect(coworkerInvocationsUrl()).toBe(
      'https://workspace.cloud.databricks.com/serving-endpoints/databricks-claude-sonnet-4-6/invocations'
    );
  });

  it('uses the endpoint injected by the dedicated app resource binding', () => {
    process.env['DATABRICKS_HOST'] = 'https://workspace.cloud.databricks.com/';
    process.env['COWORKER_FM_ENDPOINT'] = 'configured-coworker-endpoint';

    expect(coworkerInvocationsUrl()).toBe(
      'https://workspace.cloud.databricks.com/serving-endpoints/configured-coworker-endpoint/invocations'
    );
  });
});
