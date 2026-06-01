import { describe, expect, it } from 'vitest';

import { renderDueCell, renderTaskRow } from './task.js';
import { makeTask } from '../test-helpers/fake-api.js';

// AC-P1-4: russian-relative due rendering with exact strings the plan calls out.
describe('renderDueCell — russian-relative rendering', () => {
  // Fix "now" to 2026-05-16 09:00 Moscow time (UTC+3).
  const now = new Date('2026-05-16T06:00:00.000Z');

  it("renders 'сегодня в 18:00' for a same-day task with time", () => {
    const task = makeTask({
      dueAt: '2026-05-16T15:00:00.000Z', // 18:00 Moscow
      dueHasTime: true,
    });
    expect(renderDueCell(task, now)).toBe('сегодня в 18:00');
  });

  it("renders 'завтра' for a date-only task one day out", () => {
    const task = makeTask({
      dueAt: '2026-05-16T21:00:00.000Z', // 00:00 next day Moscow
      dueHasTime: false,
    });
    expect(renderDueCell(task, now)).toBe('завтра');
  });

  it("renders 'через 3 дня' for a 3-day-out date-only task", () => {
    const task = makeTask({
      dueAt: '2026-05-18T21:00:00.000Z', // 2026-05-19 Moscow date-only
      dueHasTime: false,
    });
    expect(renderDueCell(task, now)).toBe('через 3 дня');
  });

  it("renders '15 мая' (absolute) for an overdue task — prefixed by ⚠️", () => {
    const task = makeTask({
      dueAt: '2026-05-14T21:00:00.000Z', // 2026-05-15 Moscow, overdue
      dueHasTime: false,
    });
    const rendered = renderDueCell(task, now);
    expect(rendered.startsWith('⚠️')).toBe(true);
    expect(rendered).toContain('15 мая');
  });

  it('returns empty string for a task without due date', () => {
    const task = makeTask({ dueAt: null, dueHasTime: false });
    expect(renderDueCell(task, now)).toBe('');
  });

  it('drops the overdue ⚠️ + "просрочено" prefix for done tasks', () => {
    const task = makeTask({
      status: 'done',
      dueAt: '2026-05-14T21:00:00.000Z', // 2026-05-15 Moscow, overdue
      dueHasTime: false,
    });
    const rendered = renderDueCell(task, now);
    expect(rendered.startsWith('⚠️')).toBe(false);
    expect(rendered).not.toContain('просрочено');
    expect(rendered).toContain('15 мая');
  });
});

describe('renderTaskRow', () => {
  const now = new Date('2026-05-16T06:00:00.000Z');
  it('produces a [#, title, due, status] row', () => {
    const task = makeTask({ numId: 7, title: 'buy milk' });
    expect(renderTaskRow(task, now)).toEqual(['7', 'buy milk', '', 'open']);
  });
});
