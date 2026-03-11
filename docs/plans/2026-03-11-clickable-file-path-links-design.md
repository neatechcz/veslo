# Clickable File Path Links Design

## Goal

Make assistant-rendered file references openable with one click, including absolute or workspace-relative file paths that contain spaces, without turning ordinary prose into false file links.

## Problem

The current session renderer auto-links URLs and whitespace-free file tokens, but it tokenizes text on whitespace first. A path such as `/Users/vaclavsoukup/ai discussion projects/test/ulice_brno.xlsx` is split into multiple tokens before file detection runs, so it is rendered as plain text and cannot be opened.

## Scope

- Assistant message text in the session view.
- Markdown-rendered assistant text in the session view.
- Paths that appear as standalone lines or obvious file-reference lines.

## Out of Scope

- Retrofitting every other UI surface that may display file strings.
- Broad in-sentence substring scanning for possible paths.
- New server-side metadata for file references.

## Recommended Approach

Detect file-path lines before the existing whitespace token pass and convert those lines into file links when they are clearly intended to be file references. Keep the current URL and whitespace-free path handling for all other text.

### Detection rules

- Treat a full line as a clickable file link when it is path-like and resolves as a likely file path.
- Allow leading labels such as `Soubor je tady:` or `Navic jsem pridal i CSV verzi:` only when the path itself is on the next line; do not attempt to parse arbitrary prose sentences.
- Support:
  - absolute POSIX paths
  - absolute Windows paths
  - `file://` URIs
  - workspace-relative and dot-relative paths
  - paths with spaces

### Rendering rules

- Preserve existing styling for links.
- Reuse the existing file opener path normalization and `openLink` behavior.
- Keep markdown code blocks and inline code untouched.

## Risks and Mitigations

- False positives:
  - Limit the new behavior to standalone path lines instead of searching inside arbitrary sentences.
- Regressing existing markdown link behavior:
  - Keep the existing marked renderer and only add pre-processing for plain text nodes.
- Paths with line references such as `file.ts:10:2`:
  - Continue stripping location suffixes before resolving the file path.

## Testing

- A path-only line with spaces becomes a clickable file link.
- A relative path with spaces becomes a clickable file link when a workspace root is available.
- A normal URL still becomes a clickable URL.
- Ordinary prose with spaces does not become a file link.
