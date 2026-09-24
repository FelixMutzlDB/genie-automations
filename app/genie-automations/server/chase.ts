export type ChaseState = 'scheduled' | 'approaching_due' | 'overdue' | 'resolved';

export interface ChasePolicy {
  cadence: 'daily' | 'weekly';
  dueOffsetDays: number;
  defaultDueAt: string | null;
  approachOffsets: number[];
  postDueOffsets: number[];
  timezone: string;
}

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

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localDateTimeAt(value: Date, timezone: string): LocalDateTime {
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
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

function zonedDateTime(local: LocalDateTime, timezone: string): Date {
  const nominalUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const represented = localDateTimeAt(new Date(nominalUtc), timezone);
  const representedAsUtc = Date.UTC(
    represented.year,
    represented.month - 1,
    represented.day,
    represented.hour,
    represented.minute,
    represented.second
  );
  return new Date(nominalUtc - (representedAsUtc - nominalUtc));
}

function shiftCalendarDays(value: Date, days: number, timezone: string): Date {
  const local = localDateTimeAt(value, timezone);
  const shifted = new Date(
    Date.UTC(local.year, local.month - 1, local.day + days, local.hour, local.minute, local.second)
  );
  return zonedDateTime(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: shifted.getUTCSeconds(),
    },
    timezone
  );
}

export function dueAtFor(accountingPeriod: string, policy: ChasePolicy): Date | null {
  const base = calendarBase(accountingPeriod);
  if (base) {
    const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day + policy.dueOffsetDays));
    return zonedDateTime(
      {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      },
      policy.timezone
    );
  }
  if (!policy.defaultDueAt) return null;
  const fallback = new Date(policy.defaultDueAt);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function stateAt(now: Date, dueAt: Date, approachOffsets: number[], timezone: string): ChaseState {
  if (now.getTime() >= dueAt.getTime()) return 'overdue';
  const leadDays = Math.max(...approachOffsets);
  return now.getTime() >= shiftCalendarDays(dueAt, -leadDays, timezone).getTime() ? 'approaching_due' : 'scheduled';
}

export function nextCheckAt(now: Date, dueAt: Date, policy: ChasePolicy): Date | null {
  const nextPolicyCheckpoint = [
    ...policy.approachOffsets.map((days) => shiftCalendarDays(dueAt, -days, policy.timezone).getTime()),
    dueAt.getTime(),
    ...policy.postDueOffsets.map((days) => shiftCalendarDays(dueAt, days, policy.timezone).getTime()),
  ]
    .sort((left, right) => left - right)
    .find((checkpoint) => checkpoint > now.getTime());
  const cadenceCheckpoint = shiftCalendarDays(now, policy.cadence === 'daily' ? 1 : 7, policy.timezone).getTime();
  if (nextPolicyCheckpoint === undefined) return null;
  return new Date(Math.min(nextPolicyCheckpoint, cadenceCheckpoint));
}
