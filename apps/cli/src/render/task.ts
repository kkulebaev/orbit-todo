import { formatDueSmart, type TaskDto } from '@orbit/contracts';

/**
 * Renders the "due" column for a task. Returns the russian-relative string
 * from `@orbit/contracts/dates`, prefixed with ⚠️ when overdue. Tasks with
 * no due date render as empty string. Done tasks never carry the overdue
 * warning — the deadline stopped being actionable when they were closed.
 */
export function renderDueCell(task: TaskDto, now: Date = new Date()): string {
  if (!task.dueAt) return '';
  const dueAt = new Date(task.dueAt);
  const { text, overdue } = formatDueSmart(dueAt, task.dueHasTime, now);
  if (task.status === 'done') {
    return text.startsWith('просрочено · ')
      ? text.slice('просрочено · '.length)
      : text;
  }
  return overdue ? `⚠️ ${text}` : text;
}

/** Single-task table-row tuple: `[#, Title, Due, Status]`. */
export function renderTaskRow(task: TaskDto, now: Date = new Date()): string[] {
  return [
    String(task.numId),
    task.title,
    renderDueCell(task, now),
    task.status,
  ];
}

/** Multi-line block for `orbit show`. */
export function renderTaskDetail(task: TaskDto, now: Date = new Date()): string {
  const due = task.dueAt ? renderDueCell(task, now) : '(нет)';
  const lines = [
    `#${task.numId}  ${task.title}`,
    `Статус: ${task.status}`,
    `Срок:   ${due}`,
    `Создано: ${task.createdAt}`,
  ];
  if (task.doneAt) lines.push(`Закрыто: ${task.doneAt}`);
  return lines.join('\n');
}
