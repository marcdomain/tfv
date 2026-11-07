import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, cronMatches, nextRun } from '../src/cron.ts';

const at = (iso: string) => new Date(iso);

test('weekday mornings in a time zone, across daylight saving', () => {
  const c = parseCron('0 6 * * 1-5');
  // 06:00 in Berlin is 05:00 UTC in winter...
  assert.equal(cronMatches(c, at('2026-11-09T05:00:00Z'), 'Europe/Berlin'), true);
  assert.equal(cronMatches(c, at('2026-11-09T06:00:00Z'), 'Europe/Berlin'), false);
  // ...and 04:00 UTC in summer.
  assert.equal(cronMatches(c, at('2026-07-06T04:00:00Z'), 'Europe/Berlin'), true);
  // Saturday is skipped.
  assert.equal(cronMatches(c, at('2026-11-07T05:00:00Z'), 'Europe/Berlin'), false);
});

test('steps, lists, ranges, names and 7 = Sunday', () => {
  const c = parseCron('*/15 9-17 * jan,jul sun');
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.equal(c.hour.size, 9);
  assert.deepEqual([...c.month], [1, 7]);
  assert.deepEqual([...parseCron('0 0 * * 7').dow], [0]);
});

test('day-of-month OR day-of-week when both are set (standard cron)', () => {
  const c = parseCron('0 0 1 * mon');
  assert.equal(cronMatches(c, at('2026-12-01T00:00:00Z')), true);  // the 1st (a Tuesday)
  assert.equal(cronMatches(c, at('2026-12-07T00:00:00Z')), true);  // a Monday
  assert.equal(cronMatches(c, at('2026-12-08T00:00:00Z')), false);
});

test('shortcuts and next run', () => {
  assert.equal(parseCron('@daily').minute.has(0), true);
  assert.equal(nextRun(parseCron('30 2 * * *'), at('2026-11-07T20:00:00Z'))?.toISOString(), '2026-11-08T02:30:00.000Z');
  assert.equal(nextRun(parseCron('0 6 * * 1-5'), at('2026-11-07T20:00:00Z'), 'Europe/Berlin')?.toISOString(), '2026-11-09T05:00:00.000Z');
});

test('clear errors for bad expressions', () => {
  assert.throws(() => parseCron('0 6 * *'), /needs 5 fields/);
  assert.throws(() => parseCron('61 * * * *'), /"61" is out of range 0-59/);
  assert.throws(() => parseCron('0 5-2 * * *'), /runs backwards/);
  assert.throws(() => parseCron('*/0 * * * *'), /bad step/);
});
