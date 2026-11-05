import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTimestamp } from '../../components/UI/format.ts';
import { formatDate } from '../../services/i18n/core.ts';

const time = { hour: 'numeric', minute: '2-digit' } as const;
const weekdayAndTime = { weekday: 'short', hour: 'numeric', minute: '2-digit' } as const;

test('a bare time means today; yesterday evening shows its weekday just after midnight', () => {
  const now = new Date(2026, 10, 5, 1, 27).getTime();
  const earlierToday = new Date(2026, 10, 5, 0, 10);
  const yesterdayEvening = new Date(2026, 10, 4, 19, 43);
  assert.equal(formatTimestamp(earlierToday.getTime(), now), formatDate(earlierToday, time));
  assert.equal(formatTimestamp(yesterdayEvening.getTime(), now), formatDate(yesterdayEvening, weekdayAndTime));
});

test('the same weekday a week back shows the date, not a weekday that reads as this week', () => {
  const now = new Date(2026, 10, 5, 1, 0).getTime();
  const lastWeek = new Date(2026, 9, 29, 2, 0);
  const sixDaysBack = new Date(2026, 9, 30, 9, 0);
  assert.equal(formatTimestamp(sixDaysBack.getTime(), now), formatDate(sixDaysBack, weekdayAndTime));
  assert.equal(formatTimestamp(lastWeek.getTime(), now), formatDate(lastWeek, { month: 'short', day: 'numeric', year: 'numeric' }));
});
