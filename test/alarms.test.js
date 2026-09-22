// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextLocalOccurrence, shouldCatchUp } from '../src/core/alarms.js';
import { defaultSettings } from '../src/core/schema.js';
import { dayKey } from '../src/core/run.js';

/** Local-time constructor, so these tests mean the same thing in any timezone. */
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const at = (h, min = 0) => local(2026, 9, 21, h, min);

const settings = (over = {}) => ({ ...defaultSettings(), schedule: { hour: 3, minute: 30 }, ...over });
const state = (key = null) => ({ lastCompletedDayKey: key });

test('nextLocalOccurrence picks today when the time is still ahead', () => {
  assert.equal(nextLocalOccurrence({ hour: 3, minute: 30 }, at(1)), at(3, 30));
});

test('nextLocalOccurrence rolls to tomorrow once the time has passed', () => {
  const next = nextLocalOccurrence({ hour: 3, minute: 30 }, at(9));
  assert.equal(next, local(2026, 9, 22, 3, 30));
});

test('nextLocalOccurrence rolls forward when exactly on the minute', () => {
  const next = nextLocalOccurrence({ hour: 3, minute: 30 }, at(3, 30));
  assert.equal(next, local(2026, 9, 22, 3, 30), 'must not re-fire immediately');
});

test('nextLocalOccurrence crosses a month boundary', () => {
  const next = nextLocalOccurrence({ hour: 3, minute: 0 }, local(2026, 9, 30, 12));
  assert.equal(next, local(2026, 10, 1, 3, 0));
});

test('nextLocalOccurrence is always in the future', () => {
  for (const h of [0, 3, 4, 12, 23]) {
    for (const nowH of [0, 3, 12, 23]) {
      const now = at(nowH, 30);
      assert.ok(nextLocalOccurrence({ hour: h, minute: 0 }, now) > now, `h=${h} now=${nowH}`);
    }
  }
});

test('does not run before the scheduled time', () => {
  const v = shouldCatchUp({ runState: state(), settings: settings(), now: at(2) });
  assert.equal(v.run, false);
  assert.match(v.reason, /not yet due/);
});

test('runs shortly after the scheduled time', () => {
  const v = shouldCatchUp({ runState: state(), settings: settings(), now: at(3, 31) });
  assert.equal(v.run, true);
});

test('does not run twice in one day', () => {
  const today = dayKey(new Date(at(9)));
  const v = shouldCatchUp({ runState: state(today), settings: settings(), now: at(9) });
  assert.equal(v.run, false);
  assert.match(v.reason, /already ran today/);
});

test('yesterday’s completion does not block today', () => {
  const v = shouldCatchUp({ runState: state('2026-09-20'), settings: settings(), now: at(4) });
  assert.equal(v.run, true);
});

test('shadow mode catches up all day', () => {
  // 3:30am scheduled, now 10:30pm = 19h late, under the 24h shadow cap.
  const v = shouldCatchUp({ runState: state(), settings: settings({ shadowMode: true }), now: at(22, 30) });
  assert.equal(v.run, true);
  assert.ok(v.hoursLate > 18);
});

test('live mode refuses a stale catch-up', () => {
  // Same 19h-late wake, but closing 25 tabs at 10:30pm is not what you signed up for.
  const v = shouldCatchUp({ runState: state(), settings: settings({ shadowMode: false }), now: at(22, 30) });
  assert.equal(v.run, false);
  assert.match(v.reason, /past the 6h cap/);
});

test('live mode accepts a fresh catch-up', () => {
  const v = shouldCatchUp({ runState: state(), settings: settings({ shadowMode: false }), now: at(8) });
  assert.equal(v.run, true, '4.5h late is within the 6h live cap');
});

test('the live cap is the only difference between the modes', () => {
  const now = at(12); // 8.5h late: over the live cap, under the shadow cap
  assert.equal(shouldCatchUp({ runState: state(), settings: settings({ shadowMode: true }), now }).run, true);
  assert.equal(shouldCatchUp({ runState: state(), settings: settings({ shadowMode: false }), now }).run, false);
});

test('a schedule at midnight behaves', () => {
  const s = settings({ schedule: { hour: 0, minute: 0 } });
  assert.equal(shouldCatchUp({ runState: state(), settings: s, now: at(0, 1) }).run, true);
  assert.equal(nextLocalOccurrence(s.schedule, at(0, 1)), local(2026, 9, 22, 0, 0));
});

test('caps are configurable', () => {
  const s = settings({ shadowMode: false, catchUp: { shadowMaxLateHours: 24, liveMaxLateHours: 1 } });
  assert.equal(shouldCatchUp({ runState: state(), settings: s, now: at(4, 0) }).run, true, '0.5h late');
  assert.equal(shouldCatchUp({ runState: state(), settings: s, now: at(5, 0) }).run, false, '1.5h late');
});

test('dayKey is local and zero-padded', () => {
  assert.equal(dayKey(new Date(local(2026, 1, 5, 12))), '2026-01-05');
  assert.equal(dayKey(new Date(local(2026, 12, 31, 23, 59))), '2026-12-31');
});
