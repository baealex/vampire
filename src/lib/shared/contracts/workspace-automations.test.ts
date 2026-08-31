import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWorkspaceAutomationSchedule,
  nextAutomationWeeklyRunAt,
  type WorkspaceAutomationSchedule,
} from './workspace-automations.ts';

test('validates weekly schedules with unique weekdays and an IANA time zone', () => {
  assert.equal(
    isWorkspaceAutomationSchedule({
      type: 'weekly',
      weekdays: [1, 3, 5],
      hour: 9,
      minute: 30,
      timeZone: 'Asia/Seoul',
      startAt: 1,
    }),
    true
  );
  assert.equal(
    isWorkspaceAutomationSchedule({
      type: 'weekly',
      weekdays: [1, 1],
      hour: 9,
      minute: 30,
      timeZone: 'Asia/Seoul',
      startAt: 1,
    }),
    false
  );
  assert.equal(
    isWorkspaceAutomationSchedule({
      type: 'weekly',
      weekdays: [1],
      hour: 9,
      minute: 30,
      timeZone: 'Not/A_Time_Zone',
      startAt: 1,
    }),
    false
  );
});

test('finds the next selected weekday in the requested local time zone', () => {
  const schedule: Extract<WorkspaceAutomationSchedule, { type: 'weekly' }> = {
    type: 'weekly',
    weekdays: [1, 3],
    hour: 9,
    minute: 30,
    timeZone: 'Asia/Seoul',
    startAt: Date.UTC(2026, 7, 31),
  };
  assert.equal(nextAutomationWeeklyRunAt(schedule, Date.UTC(2026, 7, 31, 0, 30)), Date.UTC(2026, 8, 2, 0, 30));
});

test('keeps weekly wall-clock time across daylight-saving changes', () => {
  const schedule: Extract<WorkspaceAutomationSchedule, { type: 'weekly' }> = {
    type: 'weekly',
    weekdays: [1],
    hour: 9,
    minute: 0,
    timeZone: 'America/New_York',
    startAt: Date.UTC(2026, 2, 1),
  };
  assert.equal(nextAutomationWeeklyRunAt(schedule, Date.UTC(2026, 2, 2, 14, 0)), Date.UTC(2026, 2, 9, 13, 0));
});
