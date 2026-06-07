import type { TodoItem } from "../types";

const normalizeTodoText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

export function normalizeTodoItems(items: unknown): TodoItem[] {
  if (!Array.isArray(items)) return [];

  return items
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const content = normalizeTodoText(record.content);
      if (!content) return null;
      const status = normalizeTodoText(record.status) || "pending";
      const priority = normalizeTodoText(record.priority) || "medium";
      const id = normalizeTodoText(record.id) || `${index}:${status}:${priority}:${content}`;
      return {
        id,
        content,
        status,
        priority,
      };
    })
    .filter((item): item is TodoItem => Boolean(item));
}
