import { describe, expect, it } from 'vitest';
import { shouldShowAdminSurface } from '../lib/governanceState';

describe('DetailsPanel admin visibility', () => {
  it('does not render the admin surface for a non-admin', () => {
    expect(shouldShowAdminSurface(false)).toBe(false);
    expect(shouldShowAdminSurface(true)).toBe(true);
  });
});
