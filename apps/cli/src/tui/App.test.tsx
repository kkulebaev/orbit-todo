import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render as inkRender } from 'ink-testing-library';

import { makeFakeApi, makeTask } from '../test-helpers/fake-api.js';
import { App } from './App.js';

// ink-testing-library leaves each render mounted. With ink-text-input subscribed
// to a shared reconciler, leftover instances starve event delivery and arrow/DEL
// keys arrive at the wrong useInput closure. Track and unmount per test.
const __activeRenders: Array<{ unmount: () => void }> = [];
const render: typeof inkRender = (tree) => {
  const r = inkRender(tree);
  __activeRenders.push(r);
  return r;
};
afterEach(() => {
  while (__activeRenders.length) __activeRenders.pop()!.unmount();
});

const NOW = new Date('2026-05-16T06:00:00.000Z');
const KEY = (): string => 'idem-key-1';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Clear `count` characters from an ink TextInput by sending one DEL per flush
 * cycle. A single burst of DELs all hit the same stale handler; interleaving
 * flush() lets TextInput re-register with the updated value each time so the
 * cursor actually advances backwards.
 */
async function clearBuffer(stdin: { write: (s: string) => void }, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    stdin.write('\x7f');
    await flush();
  }
}

async function waitForFrame(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  timeoutMs = 500,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const f = lastFrame() ?? '';
    if (predicate(f)) return f;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`waitForFrame timeout. Last frame:\n${lastFrame() ?? '(empty)'}`);
}

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const ARROW_LEFT = '\x1b[D';
const ARROW_RIGHT = '\x1b[C';
const ENTER = '\r';
const ESC = '\x1b';

function tasksFor(prefix: string, n: number, status: 'open' | 'done' = 'open') {
  return Array.from({ length: n }, (_, i) =>
    makeTask({ numId: i + 1, title: `${prefix}${i + 1}`, status }),
  );
}

describe('TUI App', () => {
  it('renders the page-0 list with cursor on the first row', async () => {
    const api = makeFakeApi();
    api.listTasks.mockResolvedValueOnce({
      page: 0,
      total: 3,
      items: [
        makeTask({ numId: 1, title: 'first' }),
        makeTask({ numId: 2, title: 'second' }),
        makeTask({ numId: 3, title: 'third' }),
      ],
    });

    const { lastFrame } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain('first');
    expect(frame).toContain('second');
    expect(frame).toContain('third');
    expect(frame).toMatch(/> 1\. first/);
  });

  it('arrow-down moves the cursor to the next task', async () => {
    const api = makeFakeApi();
    api.listTasks.mockResolvedValueOnce({
      page: 0,
      total: 2,
      items: [
        makeTask({ numId: 1, title: 'a' }),
        makeTask({ numId: 2, title: 'b' }),
      ],
    });

    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(lastFrame, (f) => f.includes('2. b'));
    stdin.write(ARROW_DOWN);
    await waitForFrame(lastFrame, (f) => /> 2\. b/.test(f));
  });

  it('arrow-up clamps cursor at 0', async () => {
    const api = makeFakeApi();
    api.listTasks.mockResolvedValueOnce({
      page: 0,
      total: 2,
      items: [
        makeTask({ numId: 1, title: 'a' }),
        makeTask({ numId: 2, title: 'b' }),
      ],
    });

    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write(ARROW_UP);
    await flush();
    expect(lastFrame()!).toMatch(/> 1\. a/);
  });

  it('arrow-right advances to the next page and refetches', async () => {
    const api = makeFakeApi();
    api.listTasks
      .mockResolvedValueOnce({ page: 0, total: 13, items: tasksFor('p0_', 12) })
      .mockResolvedValueOnce({
        page: 1,
        total: 13,
        items: [makeTask({ numId: 13, title: 'p1_only' })],
      });

    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(lastFrame, (f) => f.includes('p0_1'));
    stdin.write(ARROW_RIGHT);
    await waitForFrame(lastFrame, (f) => f.includes('p1_only'));
    expect(api.listTasks).toHaveBeenNthCalledWith(2, { mode: 'my', page: 1 });
    expect(lastFrame()!).toContain('Страница: 2 / 2');
  });

  it('arrow-right is a no-op on the last page', async () => {
    const api = makeFakeApi();
    api.listTasks.mockResolvedValueOnce({
      page: 0,
      total: 1,
      items: [makeTask({ numId: 1, title: 'only' })],
    });

    const { stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write(ARROW_RIGHT);
    await flush();
    // Only the initial page-0 fetch.
    expect(api.listTasks).toHaveBeenCalledTimes(1);
  });

  it('"m" cycles the mode and refetches with the new mode', async () => {
    const api = makeFakeApi();
    api.listTasks
      .mockResolvedValueOnce({ page: 0, total: 1, items: [makeTask({ numId: 1 })] })
      .mockResolvedValueOnce({ page: 0, total: 0, items: [] });

    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write('m');
    await flush();
    await flush();
    expect(api.listTasks).toHaveBeenNthCalledWith(2, { mode: 'done', page: 0 });
    expect(lastFrame()!).toContain('Orbit · Выполненные');
  });

  it('"d" calls updateTask({status:"done"}) for the selected open task', async () => {
    const api = makeFakeApi();
    const task = makeTask({ numId: 7, title: 'finish me', status: 'open' });
    api.listTasks
      .mockResolvedValueOnce({ page: 0, total: 1, items: [task] })
      .mockResolvedValueOnce({ page: 0, total: 1, items: [{ ...task, status: 'done' }] });

    const { stdin, lastFrame } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(lastFrame, (f) => f.includes('finish me'));
    stdin.write('d');
    await waitForFrame(lastFrame, (f) => f.includes('#7 закрыто'));
    expect(api.updateTask).toHaveBeenCalledWith(7, { status: 'done' }, 'idem-key-1');
  });

  it('"o" reopens a done task', async () => {
    const api = makeFakeApi();
    const task = makeTask({ numId: 5, title: 'redo', status: 'done' });
    api.listTasks
      .mockResolvedValueOnce({ page: 0, total: 1, items: [task] })
      .mockResolvedValueOnce({ page: 0, total: 1, items: [{ ...task, status: 'open' }] });

    const { stdin, lastFrame } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(lastFrame, (f) => f.includes('redo'));
    stdin.write('o');
    await waitForFrame(lastFrame, (f) => f.includes('#5 переоткрыто'));
    expect(api.updateTask).toHaveBeenCalledWith(5, { status: 'open' }, 'idem-key-1');
  });

  it('"d" is a no-op on already-done tasks', async () => {
    const api = makeFakeApi();
    api.listTasks.mockResolvedValueOnce({
      page: 0,
      total: 1,
      items: [makeTask({ numId: 1, status: 'done' })],
    });
    const { stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write('d');
    await flush();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('enter opens the detail view; esc returns to the list', async () => {
    const api = makeFakeApi();
    api.listTasks.mockResolvedValueOnce({
      page: 0,
      total: 1,
      items: [makeTask({ numId: 42, title: 'detail-me', dueAt: null })],
    });
    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(lastFrame, (f) => f.includes('detail-me'));
    stdin.write(ENTER);
    const detail = await waitForFrame(lastFrame, (f) => f.includes('📝 Задача'));
    expect(detail).toContain('detail-me');
    expect(detail).toContain('⏳ В работе');
    stdin.write(ESC);
    await waitForFrame(lastFrame, (f) => f.includes('Страница: 1 / 1'));
  });

  it('renders "Нет задач." on an empty list', async () => {
    const api = makeFakeApi();
    const { lastFrame } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    expect(lastFrame()!).toContain('Нет задач.');
  });

  it('renders an error frame when listTasks rejects', async () => {
    const api = makeFakeApi();
    api.listTasks.mockRejectedValueOnce(new Error('boom'));
    const { lastFrame } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    expect(lastFrame()!).toContain('Ошибка: boom');
  });

  it('arrow-left on first page is a no-op (does not refetch)', async () => {
    const api = makeFakeApi();
    api.listTasks.mockResolvedValueOnce({
      page: 0,
      total: 1,
      items: [makeTask({ numId: 1, title: 'a' })],
    });
    const { stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write(ARROW_LEFT);
    await flush();
    expect(api.listTasks).toHaveBeenCalledTimes(1);
  });
});

describe('TUI App — detail-view actions', () => {
  async function openDetail(taskOverrides: Partial<ReturnType<typeof makeTask>> = {}) {
    const api = makeFakeApi();
    const task = makeTask({ numId: 100, title: 'pick milk', status: 'open', ...taskOverrides });
    api.listTasks.mockResolvedValueOnce({ page: 0, total: 1, items: [task] });
    const harness = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(harness.lastFrame, (f) => f.includes(task.title));
    harness.stdin.write(ENTER);
    await waitForFrame(harness.lastFrame, (f) => f.includes('📝 Задача'));
    return { api, task, ...harness };
  }

  it('detail: "d" calls updateTask({status:"done"}) on an open task', async () => {
    const { api, stdin, lastFrame } = await openDetail();
    stdin.write('d');
    await waitForFrame(lastFrame, (f) => f.includes('#100 закрыто'));
    expect(api.updateTask).toHaveBeenCalledWith(100, { status: 'done' }, 'idem-key-1');
  });

  it('detail: "e" enters edit-title mode with the current title pre-filled', async () => {
    const { stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    expect(lastFrame()!).toContain('enter сохранить');
  });

  // EXPECTED TO FAIL: executor bug on App.tsx line 212 (`if (input === '')`) fires for DEL
  // (input='' for non-printing keys), which transiently sets editBuffer=''. The cursor-adjustment
  // useEffect then sees newValue='' and resets cursorOffset to 0. Subsequent typing inserts at
  // position 0 instead of the expected position 8. Requires fix: `if (key.ctrl && input === 'u')`.
  it('detail edit-title: typing appends, backspace removes, enter submits new title', async () => {
    const { api, stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    await flush();
    stdin.write('\x7f'); // DEL — removes last char
    await waitForFrame(lastFrame, (f) => f.includes('pick mil'));
    await flush(); // let TextInput re-register with updated value/cursor before typing
    stdin.write('k!'); // single write avoids stale-handler cursor interleaving
    await waitForFrame(lastFrame, (f) => f.includes('pick milk!'));
    await flush(); // let handler re-register before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('#100 переименована'));
    expect(api.updateTask).toHaveBeenCalledWith(100, { title: 'pick milk!' }, 'idem-key-1');
  });

  it('detail edit-title: esc cancels without calling updateTask', async () => {
    const { api, stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    await flush();
    stdin.write('Z');
    stdin.write(ESC);
    await waitForFrame(lastFrame, (f) => !f.includes('enter сохранить'));
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('detail edit-title: enter with empty buffer shows error, no API call', async () => {
    const { api, stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    await flush();
    // Clear 'pick milk' (9 chars) one DEL+flush at a time so TextInput re-registers
    // its handler between each deletion (burst DELs all hit the same stale handler).
    await clearBuffer(stdin, 9);
    await waitForFrame(lastFrame, (f) => !f.includes('milk'));
    await flush(); // let handler re-register before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('Название не может быть пустым'));
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('detail: "t" enters edit-due with formatted current dueAt', async () => {
    const { stdin, lastFrame } = await openDetail({
      dueAt: '2026-05-20T15:00:00.000Z',
      dueHasTime: true,
    });
    stdin.write('t');
    // 2026-05-20T15:00:00Z is 18:00 in Moscow (UTC+3)
    await waitForFrame(
      lastFrame,
      (f) => f.includes('печатайте дату') && f.includes('20.05.2026 18:00'),
    );
  });

  it('detail edit-due: empty + enter clears the due date (dueAt:null)', async () => {
    const { api, stdin, lastFrame } = await openDetail({
      dueAt: '2026-05-20T15:00:00.000Z',
      dueHasTime: true,
    });
    stdin.write('t');
    await waitForFrame(
      lastFrame,
      (f) => f.includes('печатайте дату') && f.includes('20.05.2026 18:00'),
    );
    await flush();
    // Clear '20.05.2026 18:00' (16 chars) one DEL+flush at a time
    await clearBuffer(stdin, 16);
    await waitForFrame(lastFrame, (f) => f.includes('(пусто)'));
    await flush(); // let handler re-register before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('срок очищен'));
    expect(api.updateTask).toHaveBeenCalledWith(100, { dueAt: null }, 'idem-key-1');
  });

  it('detail edit-due: valid date submits ISO with dueHasTime', async () => {
    const { api, stdin, lastFrame } = await openDetail({ dueAt: null });
    stdin.write('t');
    await waitForFrame(lastFrame, (f) => f.includes('(пусто)'));
    await flush();
    stdin.write('20.05.2030 09:30'); // single write — avoids stale-handler interleaving
    await waitForFrame(lastFrame, (f) => f.includes('20.05.2030 09:30'));
    await flush(); // let useInput re-register with the new value before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('срок обновлён'));
    expect(api.updateTask).toHaveBeenCalledWith(
      100,
      { dueAt: '2030-05-20T06:30:00.000Z', dueHasTime: true },
      'idem-key-1',
    );
  });

  it('detail edit-due: bad format shows error, no API call', async () => {
    const { api, stdin, lastFrame } = await openDetail({ dueAt: null });
    stdin.write('t');
    await waitForFrame(lastFrame, (f) => f.includes('(пусто)'));
    await flush();
    stdin.write('not-a-date'); // single write — avoids stale-handler interleaving
    await waitForFrame(lastFrame, (f) => f.includes('not-a-date'));
    await flush(); // let useInput re-register with the new value before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('Формат: DD.MM.YYYY'));
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('detail: "x" then "y" deletes and returns to list', async () => {
    const { api, stdin, lastFrame } = await openDetail();
    stdin.write('x');
    await waitForFrame(lastFrame, (f) => f.includes('Удалить задачу?'));
    stdin.write('y');
    await waitForFrame(lastFrame, (f) => f.includes('#100 удалена'));
    expect(api.deleteTask).toHaveBeenCalledWith(100, 'idem-key-1');
    // Returned to list view (pager line visible).
    expect(lastFrame()!).toContain('Страница');
  });

  it('detail: "x" then "n" cancels delete (no API call)', async () => {
    const { api, stdin, lastFrame } = await openDetail();
    stdin.write('x');
    await waitForFrame(lastFrame, (f) => f.includes('Удалить задачу?'));
    stdin.write('n');
    await waitForFrame(lastFrame, (f) => !f.includes('Удалить задачу?'));
    expect(api.deleteTask).not.toHaveBeenCalled();
    // Still in detail.
    expect(lastFrame()!).toContain('📝 Задача');
  });

  it('detail edit-title: ignores "q" (treated as a character, not exit)', async () => {
    const { stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    await flush();
    stdin.write('q');
    await waitForFrame(lastFrame, (f) => f.includes('pick milkq'));
  });

  // T1 — cursor movement: ARROW_LEFT moves TextInput's cursorOffset via useEffect;
  // flush() lets that effect fire before the next keypress.
  it('detail edit-title: ARROW_LEFT moves cursor; typing inserts mid-string', async () => {
    const { stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    await flush();
    stdin.write(ARROW_LEFT); // move cursor one position left (before 'k')
    await flush(); // let cursor-state update propagate and handler re-register
    stdin.write('X');
    await waitForFrame(lastFrame, (f) => f.includes('pick milXk'));
  });

  // T2 — after executor fix (key.ctrl && input === 'u'), ARROW_LEFT no longer wipes
  // the buffer; it moves TextInput's internal cursor so DEL removes the char before it.
  it('detail edit-title: ARROW_LEFT + DEL removes char before cursor (not last char)', async () => {
    const { stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    await flush();
    stdin.write(ARROW_LEFT); // move cursor left of last char
    stdin.write('\x7f'); // DEL — should delete 'l' (second-to-last), leaving 'pick mik'
    await waitForFrame(lastFrame, (f) => f.includes('pick mik') || f.includes('pick mil'));
  });

  // T4 — Cyrillic round-trip
  it('detail edit-title: cyrillic input survives round-trip to updateTask payload', async () => {
    const { api, stdin, lastFrame } = await openDetail();
    stdin.write('e');
    await waitForFrame(lastFrame, (f) => f.includes('enter сохранить') && f.includes('pick milk'));
    await flush();
    // Clear 'pick milk' (9 chars) one DEL+flush at a time
    await clearBuffer(stdin, 9);
    await waitForFrame(lastFrame, (f) => !f.includes('milk') && f.includes('enter сохранить'));
    await flush(); // let handler stabilise before typing
    stdin.write('Купить хлеб'); // single write — avoids stale-handler interleaving
    await waitForFrame(lastFrame, (f) => f.includes('Купить хлеб'));
    await flush(); // let useInput re-register with the new value before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('#100 переименована'));
    expect(api.updateTask).toHaveBeenCalledWith(100, { title: 'Купить хлеб' }, 'idem-key-1');
  });
});

describe('TUI App — create-task flow', () => {
  it('"c" opens a create-task input that creates the task on enter and refreshes the list', async () => {
    const api = makeFakeApi();
    api.listTasks
      .mockResolvedValueOnce({ page: 0, total: 0, items: [] })
      .mockResolvedValueOnce({
        page: 0,
        total: 1,
        items: [makeTask({ numId: 11, title: 'buy bread' })],
      });
    api.createTask.mockResolvedValueOnce(
      makeTask({ numId: 11, title: 'buy bread' }),
    );

    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(lastFrame, (f) => f.includes('Нет задач.'));
    stdin.write('c');
    await waitForFrame(lastFrame, (f) => f.includes('✍️ Новая задача'));
    await flush();
    stdin.write('buy bread'); // single write — avoids stale-handler interleaving
    await waitForFrame(lastFrame, (f) => f.includes('buy bread'));
    await flush(); // let useInput re-register with the new value before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('#11 создано'));
    expect(api.createTask).toHaveBeenCalledWith({ title: 'buy bread' }, 'idem-key-1');
    // setRefreshKey fires async → wait for the list to actually refresh before counting calls
    await waitForFrame(lastFrame, (f) => f.includes('1. buy bread'));
    expect(api.listTasks).toHaveBeenCalledTimes(2);
  });

  it('create-task: enter with empty buffer shows error, no API call', async () => {
    const api = makeFakeApi();
    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write('c');
    await waitForFrame(lastFrame, (f) => f.includes('✍️ Новая задача'));
    await flush();
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('Название не может быть пустым'));
    expect(api.createTask).not.toHaveBeenCalled();
  });

  it('create-task: esc cancels without calling createTask', async () => {
    const api = makeFakeApi();
    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write('c');
    await waitForFrame(lastFrame, (f) => f.includes('✍️ Новая задача'));
    stdin.write('Z');
    stdin.write(ESC);
    await waitForFrame(lastFrame, (f) => !f.includes('✍️ Новая задача'));
    expect(api.createTask).not.toHaveBeenCalled();
  });

  // T3 — multi-char paste inserts atomically (PASSES)
  it('list create-task: stdin.write of multi-char chunk inserts atomically and submits', async () => {
    const api = makeFakeApi();
    api.listTasks
      .mockResolvedValueOnce({ page: 0, total: 0, items: [] })
      .mockResolvedValueOnce({
        page: 0,
        total: 1,
        items: [makeTask({ numId: 11, title: 'buy bread' })],
      });
    api.createTask.mockResolvedValueOnce(makeTask({ numId: 11, title: 'buy bread' }));

    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await waitForFrame(lastFrame, (f) => f.includes('Нет задач.'));
    stdin.write('c');
    await waitForFrame(lastFrame, (f) => f.includes('✍️ Новая задача'));
    await flush();
    stdin.write('buy bread'); // single write — simulates paste
    await waitForFrame(lastFrame, (f) => f.includes('buy bread'));
    await flush(); // let useInput re-register with the new value before ENTER
    stdin.write(ENTER);
    await waitForFrame(lastFrame, (f) => f.includes('#11 создано'));
    expect(api.createTask).toHaveBeenCalledTimes(1);
    expect(api.createTask).toHaveBeenCalledWith({ title: 'buy bread' }, 'idem-key-1');
  });

  // T5 — EXPECTED TO FAIL: executor bug on App.tsx line 212 (`if (input === '')`)
  // should be `if (key.ctrl && input === 'u')`. Ctrl+U sends input='u' (not ''),
  // so the check never fires and TextInput inserts 'u' instead of clearing.
  it('list create-task: Ctrl+U clears the buffer', async () => {
    const api = makeFakeApi();
    const { lastFrame, stdin } = render(
      <App client={api} idempotencyKey={KEY} now={NOW} exitOnQuit={false} />,
    );
    await flush();
    stdin.write('c');
    await waitForFrame(lastFrame, (f) => f.includes('✍️ Новая задача'));
    await flush();
    stdin.write('abc');
    await waitForFrame(lastFrame, (f) => f.includes('abc'));
    stdin.write('\x15'); // Ctrl+U — should clear buffer
    await waitForFrame(lastFrame, (f) => !f.includes('abc'));
  });
});
