# Typography System Design

## Goal

Make Veslo typography feel consistent, calm, readable, and intentionally branded across the entire app.

The immediate problem is not only font choice. Veslo currently mixes:

- a global stack in `packages/app/src/app/index.css`
- a separate editor stack in `packages/app/src/app/components/live-markdown-editor.tsx`
- many ad hoc text sizes, weights, and uppercase label patterns across pages and components

This makes the app feel visually fragmented and causes the chat/content surface to inherit typography that is not optimized for reading.

## Approved Product Behavior

1. Veslo uses a small typography system with explicit font roles, not one-off per-component font decisions.
2. Chat, long-form text, and other reading-heavy surfaces use a reading-focused sans serif.
3. Navigation, headings, buttons, labels, and product chrome use a separate product sans serif with more character.
4. Technical strings such as paths, IDs, versions, commands, diffs, and URLs use a mono family.
5. Font family definitions are centralized and reusable across the app.
6. Local font stack overrides are removed unless they are intentionally justified.
7. The system starts from a stable token set, then allows iterative tuning of sizes, line heights, weights, and tracking after visual review.

## Chosen Font Roles

### Reading Sans

Use `Source Sans 3`.

Use it for:

- chat messages
- modal/body copy
- onboarding explanatory text
- form values and other text users read continuously
- markdown/editor reading surfaces unless a technical mode specifically requires mono

Why:

- stronger reading comfort than the current main chat feel
- reliable open-source licensing and self-hosting
- appropriate tone for dense product interfaces

### Product Sans

Use `IBM Plex Sans`.

Use it for:

- page titles
- section headings
- sidebar/navigation labels
- buttons
- chips/tags
- short UI copy and product chrome

Why:

- more distinctive product character than a generic system stack
- still restrained enough for a premium desktop app
- pairs cleanly with `Source Sans 3`

### Mono

Use `IBM Plex Mono`.

Use it for:

- file paths
- IDs
- versions
- URLs
- commands
- environment variables
- diagnostics and diffs
- other explicitly technical content

Why:

- family compatibility with the chosen product sans
- technical clarity without using mono as decoration

## Scope

In scope:

- global font-family tokens in `packages/app/src/app/index.css`
- Tailwind/theme-level typography tokens and reusable style mapping
- chat/message typography
- markdown/editor typography
- form and modal typography
- navigation/title/heading typography
- technical/mono text usage cleanup
- follow-up documentation for the new typography contract

Primary implementation surfaces expected:

- `packages/app/src/app/index.css`
- `packages/app/src/app/components/live-markdown-editor.tsx`
- `packages/app/src/app/pages/session.tsx`
- shared UI components in `packages/app/src/app/components/**`
- key dense UI pages such as `settings`, `skills`, `mcp`, `onboarding`, and `dashboard`

Out of scope:

- color redesign
- spacing redesign beyond typography-driven corrections
- iconography changes
- brand/logo redesign
- mobile-native specific typography policies outside the shared desktop app surface

## Options Considered

### Option 1: Reading font + product font + mono (chosen)

- `Source Sans 3` for reading-heavy surfaces
- `IBM Plex Sans` for product UI chrome and headings
- `IBM Plex Mono` for technical text

Pros:

- best balance of readability and premium product tone
- fixes the chat readability issue directly
- gives the app clear typographic roles without overcomplicating the system

Cons:

- requires discipline about where reading typography ends and product typography begins

### Option 2: One family for almost everything

- use one sans family across both content and chrome, plus mono for technical text

Pros:

- simplest rollout and easiest long-term maintenance

Cons:

- weaker separation between reading comfort and product character
- more likely to leave the chat experience only partially improved

### Option 3: Accessibility-first reading system

- use a strongly legibility-oriented family for most content, with a secondary UI font for headings/chrome

Pros:

- strongest pure readability outcome

Cons:

- greater risk of feeling utilitarian rather than premium
- less aligned with the desired branded product tone

## Recommended Approach

Use Option 1 and treat typography as a system with three roles:

- `reading`
- `product`
- `mono`

Do not ship this as a single font swap. The app should move from implicit font inheritance to explicit role-based usage.

## Typography Scale

Start with a deliberately small shared scale:

- `ui-xs`: 11px
- `ui-sm`: 13px
- `ui-md`: 14px
- `reading-md`: 15px
- `reading-lg`: 17px
- `title-sm`: 20px
- `title-md`: 24px
- `title-lg`: 32px

Rules:

1. Chat and long-form reading surfaces default to `reading-md`, not dense UI sizes.
2. Most general UI controls and labels default to `ui-md` or `ui-sm`.
3. `IBM Plex Sans` should usually stay in medium and semibold ranges rather than heavy bold as a default.
4. Uppercase labels should be reduced and reserved for small metadata/section markers only.
5. Mono appears only when the text carries technical meaning.

The exact numeric values are intentionally adjustable after review, but the role structure and scale boundaries should remain stable.

## Architecture

### Central typography contract

Create one source of truth for:

- font family stacks
- semantic text roles
- approved size/weight/line-height combinations

Typography should be represented as reusable roles such as:

- `text-reading`
- `text-ui`
- `text-title`
- `text-mono`

Whether the final implementation uses CSS custom properties, utility classes, component helpers, or a combination is an implementation detail. The contract must still be centralized.

### Remove local overrides

The current editor-specific `Inter` stack and similar local font-family overrides should be removed unless they serve a deliberate semantic purpose.

Today, these local differences are one of the main causes of the app feeling broken.

### Token-first iteration

The system must support iterative tuning by adjusting typography tokens and semantic roles rather than re-tweaking many individual components.

This is critical because final typography will need visual refinement after first rollout.

## Component And Data Flow

### Current behavior

Today:

1. body typography is set globally in `index.css`
2. some surfaces inherit it
3. some surfaces override font family or rely on utility classes ad hoc
4. many components define custom sizes and weights directly

Result:

- typography differs between surfaces
- reading comfort is inconsistent
- changes are expensive because there is no single system boundary

### New behavior

After the change:

1. app bootstraps centralized font tokens
2. shared text roles define reading/product/mono behavior
3. components consume those roles rather than inventing local typography
4. chat/editor/body copy consistently use the reading role
5. headings/navigation/controls consistently use the product role
6. technical text consistently uses mono

## Tuning And Rollout Strategy

Roll out in two layers.

### Layer 1: Stable contract

Ship:

- centralized font-family tokens
- centralized semantic text roles
- replacement of obvious local overrides
- first-pass alignment across chat, editor, forms, navigation, and technical text

### Layer 2: Visual tuning

Then refine:

- exact chat size and line-height
- title weights and tracking
- dense sidebar/search/list typography
- modal/form control density
- edge cases exposed by font zoom and dark mode

This lets the team adjust the feel without breaking the system contract.

## Error Handling And Edge Cases

1. Some layouts may break or wrap unexpectedly once fonts and line heights are normalized.
2. Dense list rows and compact controls may need explicit height/padding adjustments after typography is corrected.
3. Chat bubbles and markdown/editor spacing may need changes because better reading fonts often want different vertical rhythm.
4. Existing mono usage must be reviewed so technical styling is not over-applied.
5. Font zoom support must continue to work correctly with the new scale and role mapping.
6. Light and dark themes must both be reviewed because perceived density changes with contrast.

## Testing Strategy

Review at minimum:

1. session/chat screen
2. sidebar/navigation
3. settings
4. onboarding
5. skills and MCP pages
6. markdown/editor surfaces

Evaluate:

- reading comfort over longer text blocks
- hierarchy clarity
- density in compact UI
- consistency between surfaces
- behavior under font zoom
- behavior in light and dark themes

## Acceptance Criteria

- Veslo uses centralized typography roles instead of scattered local font-family decisions.
- Chat and reading-heavy surfaces are visibly more readable than before.
- Product chrome feels more consistent and intentional.
- Mono usage is limited to technical content.
- The app uses a smaller, clearer shared typography scale.
- The system remains tunable through centralized roles/tokens rather than manual component-by-component drift.
