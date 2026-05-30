# VSLO-193 Progress Message Grouping Design

## Context

`VSLO-193` fixes inconsistent display and grouping of intermediate agent activity in the Veslo session transcript.

Today the app groups mostly by the technical OpenCode `message` shape. A message that contains only step groups can be merged with adjacent step-only messages. A message that mixes assistant text with tool or reasoning parts stays as a normal message with an inline timeline. That means the same logical agent run can render differently depending on how the runtime split text and tool parts across messages.

`showThinking` currently hides more than model thinking. It filters out reasoning parts, and the timeline technical detail disclosure is also gated by `showThinking`, so path, command, query, and similar action details can be unavailable to a normal user even when they are not model reasoning.

## Desired Behavior

Grouping is based on the logical agent turn, not on the OpenCode message boundary:

```text
user message -> intermediate agent work -> final agent answer
```

After the run completes, everything between the user message and the final agent answer collapses into one expandable progress group.

The group summary shows action types and counts, such as file reads, searches, file edits, commands, verification, issues, subagent work, and intermediate agent comments.

Expanding the group shows each intermediate item in original order. Tool/action rows remain timeline rows. Intermediate assistant comments are shown as normal agent text inside the expanded group, not as thinking and not as hidden technical metadata.

During streaming, the app does not yet know whether the latest assistant text is the final answer. The transcript may show live progress while the run is active. When the session becomes idle and the final assistant answer is known, the previous intermediate items collapse into the single turn progress group.

`showThinking` controls only model reasoning visibility. With `showThinking=false`, reasoning rows are hidden, but intermediate comments, tool/action rows, and non-reasoning action details remain available in the expanded group.

## Examples

Tool-only work:

```text
U: Oprav bug
T: read file
T: grep
T: edit file
A: Hotovo.
```

After completion:

```text
U: Oprav bug
G[1 file read, 1 search, 1 edit]
A: Hotovo.
```

Expanded group:

```text
T: read file
T: grep
T: edit file
```

Intermediate comments:

```text
U: Zkontroluj runtime
C: Podívám se na message list.
T: read message-list.tsx
C: Našel jsem, že grouping je po message.
T: edit message-list.tsx
A: Opraveno.
```

After completion:

```text
U: Zkontroluj runtime
G[2 comments, 1 file read, 1 edit]
A: Opraveno.
```

Expanded group:

```text
C: Podívám se na message list.
T: read message-list.tsx
C: Našel jsem, že grouping je po message.
T: edit message-list.tsx
```

Thinking is separate from comments:

```text
U: Oprav bug
R: Need inspect message grouping logic
C: Podívám se na session timeline.
T: read message-list.tsx
A: Hotovo.
```

With `showThinking=false`:

```text
U: Oprav bug
G[C: Podívám se na session timeline., T: read message-list.tsx]
A: Hotovo.
```

With `showThinking=true`:

```text
U: Oprav bug
G[R: Need inspect message grouping logic, C: Podívám se na session timeline., T: read message-list.tsx]
A: Hotovo.
```

Multiple user turns:

```text
U1
T: read
A1
U2
T: grep
C: Našel jsem druhé místo.
A2
```

After completion:

```text
U1
G[T: read]
A1
U2
G[T: grep, C: Našel jsem druhé místo.]
A2
```

Groups do not cross user-message boundaries.

## Design

Add a transcript-level render grouping pass in the session message list. The pass walks messages and parts in display order and builds turn-scoped blocks:

- user messages stay visible as normal messages;
- while a run is active, intermediate assistant text and steps can remain visible in live form;
- once a turn has a final assistant answer, all preceding assistant activity since the triggering user message becomes one progress group;
- the final assistant answer stays as the normal assistant message after that group.

The grouping pass must treat text assistant parts before the final answer as intermediate comments unless they are model reasoning or already excluded by existing synthetic/ignored/internal handoff filters.

The existing `StepsContainer` and timeline detail model remain the foundation for summarized actions and expandable detail. They need to accept mixed progress items, not only `tool` and `reasoning` step parts. Text comments inside a progress group should render through the normal text renderer in the expanded detail.

Technical details should be gated by item type, not by `showThinking` globally:

- reasoning details follow `showThinking`;
- non-reasoning tool/action/comment details remain available in the expanded group.

## Testing

Add focused model/unit coverage for:

- adjacent step-only messages collapsing into one turn group;
- mixed text/tool assistant activity collapsing after completion;
- intermediate assistant comments rendering as text inside the expanded group;
- multiple user turns keeping separate progress groups;
- active streaming leaving the latest assistant text live until completion;
- `showThinking=false` hiding reasoning but keeping comments and action details.

Add or update desktop E2E coverage in `packages/e2e` for the real Tauri runtime path. The E2E check should validate that a seeded or generated session shows a single collapsed progress group between a user message and final assistant answer, and that expanding it reveals intermediate comments and actions in order.

## Documentation

Update `docs/features/session-runtime.md` after implementation because this changes durable session transcript behavior.
