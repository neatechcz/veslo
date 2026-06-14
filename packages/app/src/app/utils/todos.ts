import type { TodoItem } from "../types";

const normalizeTodoText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export function normalizeTodoItems(items: unknown): TodoItem[] {
  if (!Array.isArray(items)) return [];

  const normalized: TodoItem[] = [];
  items.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const content = normalizeTodoText(record.content);
    if (!content) return;
    const status = normalizeTodoText(record.status) || "pending";
    const priority = normalizeTodoText(record.priority) || "medium";
    const id = normalizeTodoText(record.id) || `${index}:${status}:${priority}:${content}`;
    normalized.push({
      id,
      content,
      status,
      priority,
    });
  });
  return normalized;
}
