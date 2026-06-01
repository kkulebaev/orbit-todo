import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

import type { ApiViewerClient } from '@orbit/api-client';
import {
  formatSmart,
  PAGE_SIZE,
  parseDueDateInput,
  type TaskDto,
} from '@orbit/contracts';

import { renderDueCell } from '../render/task.js';
import { useTasks, type TaskMode } from './use-tasks.js';

const MODES: readonly TaskMode[] = ['my', 'done'];
const MODE_LABEL: Record<TaskMode, string> = {
  my: 'Мои задачи',
  done: 'Выполненные',
};

type SubMode = null | 'edit-title' | 'edit-due' | 'confirm-delete' | 'create-task';

export type AppProps = {
  client: ApiViewerClient;
  idempotencyKey: () => string;
  now: Date;
  /** Disable real exit() for unit tests so the rendered frame survives 'q'. */
  exitOnQuit?: boolean;
};

export function App({
  client,
  idempotencyKey,
  now,
  exitOnQuit = true,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [mode, setMode] = useState<TaskMode>('my');
  const [page, setPage] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [view, setView] = useState<'list' | 'detail'>('list');
  const [subMode, setSubMode] = useState<SubMode>(null);
  const [editBuffer, setEditBuffer] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const { items, total, loading, error } = useTasks(client, mode, page, refreshKey);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selected = items[cursor];

  useEffect(() => {
    setPage(0);
    setCursor(0);
  }, [mode]);

  useEffect(() => {
    if (cursor >= items.length) setCursor(Math.max(0, items.length - 1));
  }, [items.length, cursor]);

  // Stable handler reads latest state via a ref — see commit f319c58 for the
  // race rationale (input arrives before ink's useEffect re-attaches the
  // listener after a re-render with new items).
  const stateRef = useRef({
    items,
    cursor,
    view,
    subMode,
    editBuffer,
    mode,
    totalPages,
  });
  stateRef.current = {
    items,
    cursor,
    view,
    subMode,
    editBuffer,
    mode,
    totalPages,
  };

  const mutateStatus = useCallback(
    async (task: TaskDto, status: 'open' | 'done'): Promise<void> => {
      try {
        await client.updateTask(task.numId, { status }, idempotencyKey());
        setMessage(
          status === 'done'
            ? `#${task.numId} закрыто`
            : `#${task.numId} переоткрыто`,
        );
        setRefreshKey((k) => k + 1);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setMessage(`Ошибка: ${m}`);
      }
    },
    [client, idempotencyKey],
  );

  const submitTitle = useCallback(
    async (task: TaskDto, raw: string): Promise<void> => {
      const title = raw.trim();
      if (!title) {
        setMessage('Название не может быть пустым');
        return;
      }
      try {
        await client.updateTask(task.numId, { title }, idempotencyKey());
        setMessage(`#${task.numId} переименована`);
        setSubMode(null);
        setEditBuffer('');
        setRefreshKey((k) => k + 1);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setMessage(`Ошибка: ${m}`);
      }
    },
    [client, idempotencyKey],
  );

  const submitDue = useCallback(
    async (task: TaskDto, raw: string): Promise<void> => {
      const trimmed = raw.trim();
      try {
        if (trimmed === '') {
          await client.updateTask(task.numId, { dueAt: null }, idempotencyKey());
          setMessage(`#${task.numId}: срок очищен`);
        } else {
          const parsed = parseDueDateInput(trimmed, now);
          if (!parsed.ok) {
            setMessage(
              parsed.error === 'past'
                ? 'Дата уже прошла'
                : 'Формат: DD.MM.YYYY [HH:MM]',
            );
            return;
          }
          await client.updateTask(
            task.numId,
            { dueAt: parsed.dueAt.toISOString(), dueHasTime: parsed.dueHasTime },
            idempotencyKey(),
          );
          setMessage(`#${task.numId}: срок обновлён`);
        }
        setSubMode(null);
        setEditBuffer('');
        setRefreshKey((k) => k + 1);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setMessage(`Ошибка: ${m}`);
      }
    },
    [client, idempotencyKey, now],
  );

  const submitCreate = useCallback(
    async (raw: string): Promise<void> => {
      const title = raw.trim();
      if (!title) {
        setMessage('Название не может быть пустым');
        return;
      }
      try {
        const created = await client.createTask({ title }, idempotencyKey());
        setMessage(`#${created.numId} создано`);
        setSubMode(null);
        setEditBuffer('');
        setRefreshKey((k) => k + 1);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setMessage(`Ошибка: ${m}`);
      }
    },
    [client, idempotencyKey],
  );

  const submitDelete = useCallback(
    async (task: TaskDto): Promise<void> => {
      try {
        await client.deleteTask(task.numId, idempotencyKey());
        setMessage(`#${task.numId} удалена`);
        setSubMode(null);
        setView('list');
        setRefreshKey((k) => k + 1);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        setMessage(`Ошибка: ${m}`);
      }
    },
    [client, idempotencyKey],
  );

  const handler = useCallback(
    (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
      const s = stateRef.current;
      const sel = s.items[s.cursor];

      // ── Text-input sub-modes ──────────────────────────────────────────
      if (
        s.subMode === 'edit-title' ||
        s.subMode === 'edit-due' ||
        s.subMode === 'create-task'
      ) {
        // CONTRACT: ink fires all useInput subscribers in parallel — this branch
        // handles ONLY Esc. Every other key is owned by focused <TextInput>.
        // Ctrl+U is NOT intercepted: ink-text-input v6 would still insert a
        // literal 'u' in parallel since it does not gate ctrl+letter input.
        if (key.escape) {
          setSubMode(null);
          setEditBuffer('');
          return;
        }
        return;
      }

      if (s.subMode === 'confirm-delete') {
        if (input === 'y' || input === 'Y') {
          if (sel) void submitDelete(sel);
          return;
        }
        if (input === 'n' || input === 'N' || key.escape) {
          setSubMode(null);
          return;
        }
        return;
      }

      // ── Detail view (no sub-mode) ─────────────────────────────────────
      if (s.view === 'detail') {
        if (key.escape || input === 'q') {
          setView('list');
          return;
        }
        if (!sel) return;
        if (input === 'd' && sel.status === 'open') {
          void mutateStatus(sel, 'done');
          return;
        }
        if (input === 'o' && sel.status === 'done') {
          void mutateStatus(sel, 'open');
          return;
        }
        if (input === 'e') {
          setSubMode('edit-title');
          setEditBuffer(sel.title);
          return;
        }
        if (input === 't') {
          setSubMode('edit-due');
          setEditBuffer(formatDueForInput(sel.dueAt, sel.dueHasTime));
          return;
        }
        if (input === 'x' || input === 'X') {
          setSubMode('confirm-delete');
          return;
        }
        return;
      }

      // ── List view ─────────────────────────────────────────────────────
      if (input === 'q' || key.escape) {
        if (exitOnQuit) exit();
        return;
      }
      if (input === 'g' || input === 'r') {
        setRefreshKey((k) => k + 1);
        setMessage('Обновлено');
        return;
      }
      if (input === 'm') {
        const i = MODES.indexOf(s.mode);
        const next = MODES[(i + 1) % MODES.length]!;
        setMode(next);
        setMessage(`Режим: ${MODE_LABEL[next]}`);
        return;
      }
      if (input === 'c') {
        setSubMode('create-task');
        setEditBuffer('');
        return;
      }
      if (key.leftArrow || input === 'h') {
        setPage((p) => Math.max(0, p - 1));
        setCursor(0);
        return;
      }
      if (key.rightArrow || input === 'l') {
        setPage((p) => (p + 1 < s.totalPages ? p + 1 : p));
        setCursor(0);
        return;
      }

      if (s.items.length === 0) return;

      if (key.upArrow || input === 'k') {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => Math.min(s.items.length - 1, c + 1));
        return;
      }
      if (key.return) {
        if (sel) setView('detail');
        return;
      }
      if (input === 'd' && sel && sel.status === 'open') {
        void mutateStatus(sel, 'done');
        return;
      }
      if (input === 'o' && sel && sel.status === 'done') {
        void mutateStatus(sel, 'open');
        return;
      }
    },
    [exit, exitOnQuit, mutateStatus, submitDelete],
  );

  useInput(handler);

  return (
    <Box flexDirection="column">
      {view === 'list' ? (
        <>
          <Box>
            <Text bold>🪐 Orbit · {MODE_LABEL[mode]}</Text>
          </Box>
          <Box>
            <Text>Страница: {page + 1} / {totalPages}</Text>
          </Box>
          {subMode === 'create-task' ? (
            <Box marginTop={1} flexDirection="column">
              <Text>✍️ Новая задача:</Text>
              <TextInput
                value={editBuffer}
                onChange={setEditBuffer}
                onSubmit={(v) => void submitCreate(v)}
                focus
                showCursor
              />
            </Box>
          ) : null}
          <Box marginTop={1}>
            <ListView
              items={items}
              cursor={cursor}
              loading={loading}
              error={error}
              now={now}
              page={page}
            />
          </Box>
        </>
      ) : selected ? (
        <DetailView
          task={selected}
          now={now}
          subMode={subMode}
          editBuffer={editBuffer}
          setEditBuffer={setEditBuffer}
          onSubmitTitle={(task, v) => void submitTitle(task, v)}
          onSubmitDue={(task, v) => void submitDue(task, v)}
        />
      ) : null}
      {message ? (
        <Box>
          <Text color="cyan">{message}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>{helpBar(view, subMode)}</Text>
      </Box>
    </Box>
  );
}

function helpBar(
  view: 'list' | 'detail',
  subMode: SubMode,
): string {
  if (view === 'list') {
    if (subMode === 'create-task') {
      return 'печатайте · ←→ курсор · enter сохранить · esc отмена';
    }
    return '↑↓ навигация · ←→ страница · enter открыть · c создать · d закрыть · o переоткрыть · m режим · g обновить · q выход';
  }
  if (subMode === 'edit-title') {
    return 'печатайте · ←→ курсор · enter сохранить · esc отмена';
  }
  if (subMode === 'edit-due') {
    return 'печатайте дату · ←→ курсор · enter сохранить (пусто = снять) · esc отмена';
  }
  if (subMode === 'confirm-delete') {
    return 'y — удалить · n / esc — отмена';
  }
  return 'd закрыть · o переоткрыть · e название · t срок · x удалить · q назад';
}

function ListView({
  items,
  cursor,
  loading,
  error,
  now,
  page,
}: {
  items: TaskDto[];
  cursor: number;
  loading: boolean;
  error: string | null;
  now: Date;
  page: number;
}): React.JSX.Element {
  if (error) {
    return (
      <Box>
        <Text color="red">Ошибка: {error}</Text>
      </Box>
    );
  }
  if (loading && items.length === 0) {
    return (
      <Box>
        <Text dimColor>Загрузка…</Text>
      </Box>
    );
  }
  if (items.length === 0) {
    return (
      <Box>
        <Text dimColor>Нет задач.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {items.map((task, i) => {
        const sel = i === cursor;
        const n = page * PAGE_SIZE + i + 1;
        const due = task.dueAt ? renderDueCell(task, now) : '';
        return (
          <Box key={task.numId}>
            <Text inverse={sel}>
              {sel ? '> ' : '  '}
              {n}. {task.title}
              {due ? (
                <>
                  {' '}· ⏰ <Text italic>{due}</Text>
                </>
              ) : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function DetailView({
  task,
  now,
  subMode,
  editBuffer,
  setEditBuffer,
  onSubmitTitle,
  onSubmitDue,
}: {
  task: TaskDto;
  now: Date;
  subMode: SubMode;
  editBuffer: string;
  setEditBuffer: (v: string) => void;
  onSubmitTitle: (task: TaskDto, v: string) => void;
  onSubmitDue: (task: TaskDto, v: string) => void;
}): React.JSX.Element {
  const statusLine = task.status === 'done' ? '✅ Выполнено' : '⏳ В работе';
  const createdLine = `Создано: ${formatSmart(new Date(task.createdAt), now)}`;
  const showDueLine = task.dueAt !== null || subMode === 'edit-due';
  const dueText = task.dueAt ? renderDueCell(task, now) : '';
  return (
    <Box flexDirection="column">
      <Text bold>📝 Задача</Text>
      <Box marginTop={1} flexDirection="column">
        {subMode === 'edit-title' ? (
          <TextInput
            value={editBuffer}
            onChange={setEditBuffer}
            onSubmit={(v) => onSubmitTitle(task, v)}
            focus
            showCursor
          />
        ) : (
          <Text bold>{task.title}</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>{statusLine}</Text>
        <Text>{createdLine}</Text>
        {subMode === 'edit-due' ? (
          <Box flexDirection="column">
            <Text>Срок: </Text>
            <TextInput
              value={editBuffer}
              onChange={setEditBuffer}
              onSubmit={(v) => onSubmitDue(task, v)}
              focus
              showCursor
            />
            {editBuffer === '' && <Text dimColor>(пусто)</Text>}
          </Box>
        ) : showDueLine ? (
          <Text>Срок: {dueText}</Text>
        ) : null}
        {task.status === 'done' && task.doneAt ? (
          <Text>Закрыто: {formatSmart(new Date(task.doneAt), now)}</Text>
        ) : null}
      </Box>
      {subMode === 'confirm-delete' ? (
        <Box marginTop={1}>
          <Text color="red">Удалить задачу? (y/n)</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function formatDueForInput(
  dueAt: string | null,
  dueHasTime: boolean,
): string {
  if (!dueAt) return '';
  const d = new Date(dueAt);
  const dayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = dayParts.find((p) => p.type === 'year')!.value;
  const m = dayParts.find((p) => p.type === 'month')!.value;
  const dd = dayParts.find((p) => p.type === 'day')!.value;
  let s = `${dd}.${m}.${y}`;
  if (dueHasTime) {
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
    s += ' ' + time;
  }
  return s;
}
