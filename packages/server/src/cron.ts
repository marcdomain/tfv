// Five-field cron ("min hour day-of-month month day-of-week") with timezones.
// Supports *, lists, ranges, steps, month/day names, 7 = Sunday and the
// @hourly / @daily / @weekly / @monthly shortcuts.

export interface Cron {
  source: string;
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SHORTCUTS: Record<string, string> = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *',
};

const field = (text: string, min: number, max: number, names: string[] = [], nameBase = 0): Set<number> => {
  const out = new Set<number>();
  const num = (s: string): number => {
    const i = names.indexOf(s.toLowerCase());
    const n = i >= 0 ? i + nameBase : Number(s);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`"${s}" is out of range ${min}-${max}`);
    return n;
  };
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number, hi: number;
    if (range === '*') { lo = min; hi = max; } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = num(a); hi = num(b);
      if (lo > hi) throw new Error(`range "${range}" runs backwards`);
    } else {
      lo = num(range); hi = stepText === undefined ? lo : max;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
};

export const parseCron = (expr: string): Cron => {
  const source = expr.trim();
  const fields = (SHORTCUTS[source.toLowerCase()] ?? source).split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron "${expr}" needs 5 fields (minute hour day month weekday)`);
  try {
    const dow = field(fields[4], 0, 7, DAYS);
    if (dow.has(7)) { dow.delete(7); dow.add(0); }
    return {
      source,
      minute: field(fields[0], 0, 59),
      hour: field(fields[1], 0, 23),
      dom: field(fields[2], 1, 31),
      month: field(fields[3], 1, 12, MONTHS, 1),
      dow,
      domAny: fields[2] === '*',
      dowAny: fields[4] === '*',
    };
  } catch (err) {
    throw new Error(`cron "${expr}": ${(err as Error).message}`);
  }
};

const formatters = new Map<string, Intl.DateTimeFormat>();

// Wall-clock parts of `date` in `timeZone`.
export const zonedParts = (date: Date, timeZone = 'UTC') => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return {
    minute: Number(p.minute), hour: Number(p.hour), day: Number(p.day), month: Number(p.month),
    weekday: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)),
  };
};

export const validTimeZone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
};

export const cronMatches = (cron: Cron, date: Date, timeZone = 'UTC'): boolean => {
  const t = zonedParts(date, timeZone);
  if (!cron.minute.has(t.minute) || !cron.hour.has(t.hour) || !cron.month.has(t.month)) return false;
  // Standard cron: when both day fields are restricted, either may match.
  const domOk = cron.dom.has(t.day);
  const dowOk = cron.dow.has(t.weekday);
  if (cron.domAny && cron.dowAny) return true;
  if (cron.domAny) return dowOk;
  if (cron.dowAny) return domOk;
  return domOk || dowOk;
};

// Next matching minute after `from` (within about a year), for display.
export const nextRun = (cron: Cron, from: Date, timeZone = 'UTC'): Date | null => {
  const d = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 60 * 24 * 370; i++) {
    if (cronMatches(cron, d, timeZone)) return d;
    d.setTime(d.getTime() + 60_000);
  }
  return null;
};
