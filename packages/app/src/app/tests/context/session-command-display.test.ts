import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("../../context/session.ts", import.meta.url), "utf8");

test("session store exposes command display aliasing for preassigned command messages", () => {
  assert.match(
    sessionSource,
    /const setCommandDisplay = \(messageID: string,\s*name: string,\s*args: string\) => \{[\s\S]*formatSlashCommandDisplay\(name,\s*args\)[\s\S]*setStore\("commandDisplayByMessageID",\s*trimmedMessageID,\s*display\);[\s\S]*\};/s,
    "session store should be able to alias an OpenCode-expanded command message before command.executed arrives",
  );
  assert.match(
    sessionSource,
    /const alias = store\.commandDisplayByMessageID\[info\.id\];[\s\S]*parts: \[aliasPart,\s*\.\.\.nonTextParts\]/s,
    "user-message rendering should replace the first text part with the command display alias",
  );
  assert.match(
    sessionSource,
    /const clearCommandDisplay = \(messageID: string\) => \{[\s\S]*delete draft\[trimmedMessageID\];[\s\S]*\};/s,
    "session store should provide command display cleanup by message id",
  );
  assert.match(
    sessionSource,
    /\bsetCommandDisplay,\s*\n\s*clearCommandDisplay,\s*\n\s*setSessions,/,
    "command display aliases should expose both set and clear helpers to sendPrompt",
  );
});
