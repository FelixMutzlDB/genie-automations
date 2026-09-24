import type { Request } from 'express';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractImage } from './imageExtraction';
import { validateMoney } from './money';

afterEach(() => {
  delete process.env['IMAGE_EXTRACTION_ENDPOINT'];
  delete process.env['DATABRICKS_HOST'];
});

describe('image extraction financial gates', () => {
  it('has no stage_change or guarded-procedure mutation capability', () => {
    const source = readFileSync(new URL('./imageExtraction.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('stage_change');
    expect(source).not.toMatch(/(?:approve_change|commit_change)\s*\(/);
  });

  it.each<[unknown, string | null]>([
    ['1,234.56', '1234.56'],
    ['(1,234.56)', '-1234.56'],
    ['10', '10'],
    ['12.345', null],
    ['1e3', null],
    ['12.999', null],
    ['10000000000000000.00', null],
  ])('re-validates model money %s with the shared deterministic grammar', (raw, expected) => {
    if (expected === null) expect(() => validateMoney(raw)).toThrow();
    else expect(validateMoney(raw)).toBe(expected);
  });

  it('returns only typed review data and performs no staging call', async () => {
    process.env['IMAGE_EXTRACTION_ENDPOINT'] = 'configured-vision-endpoint';
    process.env['DATABRICKS_HOST'] = 'example.databricks.com';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  rows: [{ remittance_id: 'R1', invoice_id: 'I1', amount: '10.00' }],
                  stated_total: '11.00',
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const req = {
      header: (name: string) => (name === 'x-forwarded-access-token' ? 'obo-token' : undefined),
    } as Request;
    const artifact = await extractImage(
      req,
      {
        raw: Buffer.from('image'),
        mimeType: 'image/png',
        parseId: '98e06e87-9d56-4e92-a530-4bd4ad5b1264',
        configVersion: 'v1',
        sha256: 'a'.repeat(64),
      },
      fetchMock
    );
    expect(artifact).toMatchObject({
      status: 'rejected',
      extraction_kind: 'probabilistic_image',
      requires_human_confirmation: true,
      rows: [],
    });
    expect(artifact.rejected_rows).toContainEqual(expect.objectContaining({ code: 'IG_CROSS_FOOT_MISMATCH' }));
    expect(JSON.stringify(artifact)).not.toContain('OCR');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('stage_change');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.databricks.com/serving-endpoints/configured-vision-endpoint/invocations',
      expect.any(Object)
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(typeof request.body).toBe('string');
    expect(JSON.parse(request.body as string)).not.toHaveProperty('response_format');
  });
});
