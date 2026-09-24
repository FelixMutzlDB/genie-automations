import { describe, expect, it } from 'vitest';
import { moneyToMinorUnits, validateMoney } from './money';

describe('shared receivables money validator', () => {
  it('matches the deterministic parser locale, negative, scale, and NUMERIC(18,2) contract', () => {
    expect(validateMoney('$1,234.50')).toBe('1234.50');
    expect(validateMoney('(1,234.50)')).toBe('-1234.50');
    expect(validateMoney('1,234.50-')).toBe('-1234.50');
    expect(moneyToMinorUnits('-1.20')).toBe(-120n);
    expect(validateMoney('9999999999999999.99')).toBe('9999999999999999.99');
    expect(() => validateMoney('1.234,50')).toThrow();
    expect(() => validateMoney('1.234')).toThrow();
    expect(() => validateMoney('0.001')).toThrow();
    expect(() => validateMoney('10000000000000000')).toThrow();
  });
});
