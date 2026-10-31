// ---------------------------------------------------------------------
// Date buckets for a collection's timeline: the finest of day, month, year
// or decade that keeps the bars countable, with empty periods included so
// that gaps show. Periods are in UTC, like the search date filter.
// ---------------------------------------------------------------------
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 62;
const MAX_MONTHS = 60;
const MAX_YEARS = 120;

// An index date as epoch milliseconds, or null if it's missing or absurd
// (bad metadata can claim any year; these would stretch the axis uselessly).
function parseDocDate(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null || first === '') return null;
  const d = new Date(first);
  const year = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || year < 1 || year > 9000 ? null : d.getTime();
}

function chooseUnit(min, max) {
  const [a, b] = [new Date(min), new Date(max)];
  const years = b.getUTCFullYear() - a.getUTCFullYear();
  const months = years * 12 + b.getUTCMonth() - a.getUTCMonth();
  if ((max - min) / DAY_MS <= MAX_DAYS) return 'day';
  if (months <= MAX_MONTHS) return 'month';
  return years <= MAX_YEARS ? 'year' : 'decade';
}

// The setters rather than Date.UTC, which reads years 0-99 as 19xx.
function periodStart(ms, unit) {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
  if (unit === 'day') return d.getTime();
  d.setUTCDate(1);
  if (unit === 'month') return d.getTime();
  d.setUTCMonth(0);
  if (unit === 'decade') d.setUTCFullYear(d.getUTCFullYear() - d.getUTCFullYear() % 10);
  return d.getTime();
}

function nextPeriod(ms, unit) {
  const d = new Date(ms);
  if (unit === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + (unit === 'decade' ? 10 : 1));
  return d.getTime();
}

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

// times: epoch milliseconds. Each bucket covers start up to, not including,
// end (both YYYY-MM-DD).
function timelineBuckets(times) {
  if (!times.length) return { unit: null, buckets: [] };
  const min = times.reduce((a, b) => Math.min(a, b));
  const max = times.reduce((a, b) => Math.max(a, b));
  const unit = chooseUnit(min, max);
  const counts = new Map();
  for (const t of times) {
    const start = periodStart(t, unit);
    counts.set(start, (counts.get(start) || 0) + 1);
  }
  const buckets = [];
  for (let start = periodStart(min, unit); start <= max; start = nextPeriod(start, unit)) {
    buckets.push({ start: isoDay(start), end: isoDay(nextPeriod(start, unit)), count: counts.get(start) || 0 });
  }
  return { unit, buckets };
}

// Documents per day, for the days that have any, oldest first.
function timelineDays(times) {
  const counts = new Map();
  for (const t of times) {
    const date = isoDay(t);
    counts.set(date, (counts.get(date) || 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, count]) => ({ date, count }));
}

module.exports = { parseDocDate, timelineBuckets, timelineDays };
