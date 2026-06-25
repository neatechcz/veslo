# Fix 08: Pending chat detaches stale selected session before send

## Problem

Opening a new or pending chat while another chat was running could leave the
old real session selected until the `/session` route effect caught up. In that
short window, the composer could still resolve send and queue state through the
previous running session, so the first message typed into the newly opened chat
could be queued instead of starting the new chat.

## Fix

- Pending draft opening now goes through one helper that sets the pending draft
  key, restores its composer draft, clears the displayed real session, and only
  then opens the session view.
- The app shell provides the clear operation by resetting selected session,
  visible messages, and todos in one Solid batch.
- Startup hydration is unchanged; the synchronous clear only runs for explicit
  pending draft open flows.

## Coverage

- `pending-session-draft-controller.test.ts` verifies the open order:
  restore pending composer, clear displayed session, then route to session view.
- `app-pending-session-draft-controller.test.ts` verifies the app shell wires
  pending draft opens to the displayed-session clear callback.
- Existing session navigation and temp-folder isolation tests were updated to
  cover the centralized pending draft open helper.
