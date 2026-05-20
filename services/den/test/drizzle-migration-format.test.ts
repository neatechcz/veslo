import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const migrationsDir = path.resolve(currentDir, "../drizzle")

function stripLineComments(sql: string) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
}

test("Den Drizzle migrations split multiple SQL statements with statement breakpoints", async () => {
  const entries = await readdir(migrationsDir)
  const migrationFiles = entries.filter((entry) => entry.endsWith(".sql")).sort()

  for (const fileName of migrationFiles) {
    const contents = await readFile(path.join(migrationsDir, fileName), "utf8")
    const segments = contents.split("--> statement-breakpoint")

    segments.forEach((segment, index) => {
      const statementCount = (stripLineComments(segment).match(/;/g) ?? []).length
      assert.ok(
        statementCount <= 1,
        `${fileName} segment ${index + 1} contains ${statementCount} SQL statements; add --> statement-breakpoint between statements`,
      )
    })
  }
})
