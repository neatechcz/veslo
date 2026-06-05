# Agent Media Evidence Design

**Date:** 2026-06-05
**Status:** Approved

## Goal

Show images that the agent consumed or produced during a run directly in the session timeline. The user should be able to see visual evidence at the step where it mattered, without opening a separate gallery or inferring behavior from file paths.

The first version is timeline-first. It does not introduce durable media storage, a full artifact gallery, or broad workspace image scanning.

## Approved Product Semantics

The timeline shows two kinds of image evidence:

- **Analyzed**: an image was actually passed to a vision-capable model as image input.
- **Created**: an image was created or modified by a concrete agent action in the current run.

Images are shown only when they can be tied to a specific step or message in the current run. Veslo must not scan the workspace for arbitrary `.png`, `.jpg`, `.jpeg`, `.webp`, or `.gif` files and present them as agent evidence.

If the same image is created and then immediately analyzed, the timeline should avoid duplicate tiles. Prefer the most relevant step and either show both labels or use `Analyzed` as the primary label with created provenance available in metadata.

SVG is out of scope for the first version. SVG files often behave more like source assets or code artifacts than bitmap evidence, and can be handled later with clearer semantics.

## Architecture

Add a small derived timeline model named `MediaEvidence`. It is built while assembling timeline blocks and progress details from transcript parts and tool activity. It is not a new persistence layer.

Each media evidence item should include:

- `kind`: `analyzed` or `created`
- `title`: file name, screenshot name, or readable fallback
- `mime`: image MIME type
- `src`: a `data:` URL, local file URL, or server-backed download URL
- `sourceStepId`: the timeline step or message this evidence belongs to
- `path`: optional local path when available
- `status`: `available`, `missing`, `tooLarge`, `unsupported`, or `redacted`

The UI consumes this normalized model instead of parsing arbitrary text while rendering.

## Data Flow

Derive media evidence from three input classes:

1. **Message image parts**

   User message `file` parts with `mime: image/*` and inline/non-`file://` URLs can become `Analyzed` evidence when the prompt was accepted by a model with image input. They should not be represented as analyzed if the selected model could not inspect images.

2. **Tool results with image payloads**

   Tool results that expose structured image data, such as an `images` array, image `data:` URLs, or base64 image objects, attach media evidence to that tool step. If the tool result is returned to the model as visual context, classify it as `Analyzed`; otherwise classify it as `Created` or as a preview-only tool image depending on available metadata.

3. **Created or modified bitmap files**

   Write, edit, shell, screenshot, browser, or image-generation activity can produce `Created` evidence when the action explicitly writes or updates a bitmap file in the current run. The model should use concrete tool input/output paths and, when needed, verify availability through existing desktop or server file surfaces.

Discovery-only tools such as list, glob, and search do not create media evidence.

## Timeline UI

Render media evidence as a compact image strip under the relevant step summary.

For one to three images:

- show small thumbnail tiles in one row
- show an `Analyzed` or `Created` badge
- keep file names truncated, with the full title available in a tooltip or detail view
- clicking a tile opens a larger detail view

For four or more images:

- show the first three thumbnails
- show a `+N` tile for the remainder
- clicking opens the same detail view with the full list

Collapsed progress groups should not show full thumbnails. They should show a short summary, for example `2 images analyzed - 1 image created`. Expanding the group reveals the thumbnail strips at their source steps.

## Detail View

The detail view should show:

- large image preview when available
- title
- evidence kind
- MIME type
- status
- optional path
- actions that are valid for the source, such as open, reveal, copy path, or download

Unavailable images should render as placeholders, not broken image elements.

## Error Handling

Use explicit statuses:

- `missing`: the evidence is known, but the local file or download target is unavailable.
- `tooLarge`: Veslo knows about the image, but inline preview is too large. Show metadata and open/reveal actions when possible.
- `unsupported`: the type looks image-related but is not safe to preview.
- `redacted`: metadata exists but preview is hidden by privacy, remote workspace, or policy constraints.

When evidence derivation is uncertain, prefer not showing an item over presenting weak or misleading provenance.

## Testing

Prefer desktop E2E coverage for the user-visible behavior:

- sending a screenshot attachment to a vision-capable model shows `Analyzed` evidence in the timeline
- a concrete agent action that creates a PNG shows `Created` evidence in the timeline
- collapsed progress groups summarize analyzed and created image counts
- expanding a progress group reveals thumbnails at the correct source steps
- missing or too-large images render placeholders instead of broken images

Add focused unit tests for the pure media evidence derivation model, especially classification, deduplication, and source-step attachment.

## Documentation

When implemented, update the session runtime feature documentation with the timeline media evidence rules, including the distinction between analyzed images, created images, and image files merely discovered in the workspace.
