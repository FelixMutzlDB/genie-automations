export type ChaseState = 'scheduled' | 'approaching_due' | 'overdue' | 'resolved';

export interface ChasePolicy {
  cadence: 'daily' | 'weekly';
  dueOffsetDays: number;
  defaultDueAt: string | null;
  approachOffsets: number[];
  postDueOffsets: number[];
  timezone: string;
}

const DAY_MS = 86_400_000;

function calendarBase(accountingPeriod: string): { year: number; month: number; day: number } | null {
  const month = /^(\d{4})-(\d{2})$/.exec(accountingPeriod);
  if (month) {
    const year = Number(month[1]);
    const monthIndex = Number(month[2]);
    if (monthIndex >= 1 && monthIndex <= 12) {
      const end = new Date(Date.UTC(year, monthIndex, 0));
      return { year, month: monthIndex, day: end.getUTCDate() };
    }
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(accountingPeriod);
  if (!day) return null;
  const parsed = new Date(`${accountingPeriod}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== accountingPeriod
    ? null
    : { year: parsed.getUTCFullYear(), month: parsed.getUTCMonth() + 1, day: parsed.getUTCDate() };
}

function zonedMidnight(year: number, month: number, day: number, timezone: string): Date {
  const nominalUtc = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(nominalUtc))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  const representedAsUtc = Date.UTC(
    parts['year'] ?? year,
    (parts['month'] ?? month) - 1,
    parts['day'] ?? day,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0
  );
  return new Date(nominalUtc - (representedAsUtc - nominalUtc));
}

export function dueAtFor(accountingPeriod: string, policy: ChasePolicy): Date | null {
  const base = calendarBase(accountingPeriod);
  if (base) {
    const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + policy.dueOffsetDays));
    return zonedMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), policy.timezone);
  }
  if (!policy.defaultDueAt) return null;
  const fallback = new Date(policy.defaultDueAt);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function stateAt(now: Date, dueAt: Date, approachOffsets: number[]): ChaseState {
  if (now.getTime() >= dueAt.getTime()) return 'overdue';
  const leadDays = Math.max(...approachOffsets);
  return now.getTime() >= dueAt.getTime() - leadDays * DAY_MS ? 'approaching_due' : 'scheduled';
}

export function nextCheckAt(now: Date, dueAt: Date, policy: ChasePolicy): Date | null {
  const nextPolicyCheckpoint = [
    ...policy.approachOffsets.map((days) => dueAt.getTime() - days * DAY_MS),
    dueAt.getTime(),
    ...policy.postDueOffsets.map((days) => dueAt.getTime() + days * DAY_MS),
  ]
    .sort((left, right) => left - right)
    .find((checkpoint) => checkpoint > now.getTime());
  const cadenceCheckpoint = now.getTime() + (policy.cadence === 'daily' ? DAY_MS : 7 * DAY_MS);
  if (nextPolicyCheckpoint === undefined) return null;
  return new Date(Math.min(nextPolicyCheckpoint, cadenceCheckpoint));
}
