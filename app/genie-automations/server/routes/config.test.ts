import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('config governance database contract', () => {
  const migration = readFileSync(new URL('../../migrations/002_config_governance.sql', import.meta.url), 'utf8');

  it('computes hashes in the database and makes published payload/hash immutable', () => {
    expect(migration).toContain("digest(convert_to(NEW.payload::text, 'UTF8'), 'sha256')");
    expect(migration).toContain('published config payload and hash are immutable');
    expect(migration).toContain("OLD.status = 'published' AND NEW.status NOT IN ('published', 'retired')");
  });

  it('enforces maker-checker for binding and config approval', () => {
    expect(migration).toContain('approved_by IS DISTINCT FROM proposed_by');
    expect(migration).toContain('approved_by IS DISTINCT FROM created_by');
  });

  it('is additive and leaves the guarded mutation procedures untouched', () => {
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(migration).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+genie_spike\.(?:stage_change|approve_change|commit_change)/i
    );
  });
});
