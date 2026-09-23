export function humanizeActor(actor: unknown): string {
  if (typeof actor !== 'string' || !actor.trim() || actor === 'unknown') return 'Someone';
  const localPart = actor.trim().split('@')[0] ?? '';
  const words = localPart
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'Someone';
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function currency(value: unknown): string | null {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return null;
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(amount);
}

function longDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function summarizeChange(changeType: unknown, input: unknown): string {
  const diff = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (changeType === 'allocation' || changeType === 'allocation_upsert') {
    const allocation =
      Array.isArray(diff.allocations) && diff.allocations[0] && typeof diff.allocations[0] === 'object'
        ? (diff.allocations[0] as Record<string, unknown>)
        : diff;
    const allocationId = text(allocation.allocation_id, 'the allocation');
    const remittanceId = text(diff.remittance_id, text(allocation.remittance_id, 'the remittance'));
    const next = currency(allocation.amount ?? allocation.new_amount ?? diff.amount ?? diff.new_amount);
    const prior = currency(allocation.prior_amount ?? allocation.old_amount ?? diff.prior_amount ?? diff.old_amount);
    if (prior && next) return `Change allocation ${allocationId} on ${remittanceId} from ${prior} to ${next}.`;
    if (next) return `Set allocation ${allocationId} on ${remittanceId} to ${next}.`;
    return `Proposed change to allocation ${allocationId}.`;
  }

  if (changeType === 'vendor_bank' || changeType === 'vendor_bank_update') {
    const vendorId = text(diff.vendor_id, 'the vendor');
    const iban = text(diff.iban ?? diff.new_iban, '');
    const ending = iban ? iban.slice(-4) : null;
    const effective = longDate(diff.effective_date);
    const details = [ending ? `IBAN ending ${ending}` : null, effective ? `effective ${effective}` : null].filter(
      Boolean
    );
    return details.length
      ? `Update ${vendorId} bank details — ${details.join(', ')}.`
      : `Proposed change to ${vendorId} bank details.`;
  }

  const target = text(diff.target ?? diff.vendor_id ?? diff.remittance_id, 'this automation');
  return `Proposed change to ${target}.`;
}
