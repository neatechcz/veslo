# Codex Auth Upload Helper Design

## Goal

Make Codex OAuth credential recovery safe and repeatable for Veslo admins. Admins should pair the human account to the target credential, while a local helper performs the fragile token capture and upload steps.

## Approach

The hosted admin portal remains the source of truth for credential selection. A platform admin picks an existing Codex credential or starts a new one, optionally renames it, and asks the portal for a short-lived upload session. The portal shows a local command that can be run from the Veslo checkout.

The local helper creates an isolated `CODEX_HOME`, runs `codex login --device-auth`, validates the resulting `auth.json`, asks for confirmation, and uploads the raw auth JSON to the one-time server endpoint. The server stores it in the encrypted managed-AI secret store, marks the existing credential healthy when reconnecting, writes an audit event, and invalidates the upload session.

## Boundaries

- The web portal does not read local files or browser tokens.
- The auth JSON never passes through Codex chat.
- The server only accepts uploads tied to a platform-admin-created short-lived session.
- Pairing is human-confirmed by credential name and `account_id`; e-mail is treated as best-effort and is not required.

## First Version

- Add credential rename support.
- Add upload-session create and consume endpoints for existing Codex credentials.
- Add a repo-local helper script.
- Add admin UI controls that show the local command.
- Add focused API/script/UI tests and one live Playwright-oriented helper test scaffold.
