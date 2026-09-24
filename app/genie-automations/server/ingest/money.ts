export interface MoneyConfig {
  decimalSeparator: '.' | ',';
  thousandsSeparator: ',' | '.' | '';
  scale: number;
  precision: number;
  acceptParenthesesNegative: boolean;
}

// Mirrors ingest_job/parser/parse.py CONFIG + _parse_money. This is the one
// server-side validator used for both extracted previews and confirmation.
export const RECEIVABLES_MONEY_CONFIG: Readonly<MoneyConfig> = Object.freeze({
  decimalSeparator: '.',
  thousandsSeparator: ',',
  scale: 2,
  precision: 18,
  acceptParenthesesNegative: true,
});

export class MoneyValidationError extends Error {}

export function validateMoney(value: unknown, config: MoneyConfig = RECEIVABLES_MONEY_CONFIG): string {
  if (value === null || typeof value === 'boolean' || (typeof value !== 'string' && typeof value !== 'number'))
    throw new MoneyValidationError('empty, boolean, or unsupported money value');
  let raw = String(value).normalize('NFKC').replace(/\p{Z}/gu, '').trim().replace(/^[€$£¥]+|[€$£¥]+$/gu, '');
  let negative = false;
  if (config.acceptParenthesesNegative && raw.startsWith('(') && raw.endsWith(')')) {
    negative = true;
    raw = raw.slice(1, -1);
  }
  if (raw.endsWith('-')) {
    negative = true;
    raw = raw.slice(0, -1);
  }
  if (raw.startsWith('-') || raw.startsWith('−')) {
    negative = true;
    raw = raw.slice(1);
  }
  if (config.thousandsSeparator) raw = raw.split(config.thousandsSeparator).join('');
  if (config.decimalSeparator !== '.') {
    if (raw.includes('.')) throw new MoneyValidationError('inconsistent decimal separator');
    raw = raw.replace(config.decimalSeparator, '.');
  }
  if (!/^\d+(?:\.\d+)?$/u.test(raw)) throw new MoneyValidationError('not a plain number under the configured locale');
  const [rawWhole, fraction = ''] = raw.split('.');
  if (fraction.length > config.scale) throw new MoneyValidationError(`scale exceeds ${config.scale}`);
  const whole = rawWhole.replace(/^0+(?=\d)/u, '');
  const maximumWholeDigits = config.precision - config.scale;
  if (whole.length > maximumWholeDigits)
    throw new MoneyValidationError(`overflow for NUMERIC(${config.precision},${config.scale})`);
  const canonical = `${whole}${fraction ? `.${fraction}` : ''}`;
  return negative && !/^0(?:\.0+)?$/u.test(canonical) ? `-${canonical}` : canonical;
}

export function moneyToMinorUnits(value: string, config: MoneyConfig = RECEIVABLES_MONEY_CONFIG): bigint {
  const canonical = validateMoney(value, config);
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = BigInt(whole) * 10n ** BigInt(config.scale) + BigInt(fraction.padEnd(config.scale, '0'));
  return negative ? -minor : minor;
}
