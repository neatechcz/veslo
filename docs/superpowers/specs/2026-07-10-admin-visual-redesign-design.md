# AI Gateway Admin — Visual Redesign (Direction A, Light)

**Date:** 2026-07-10
**Status:** Approved by user (light direction selected from proposal artifact)
**Scope:** `services/ai-gateway/public-admin/app.css` (full visual reskin) + `services/ai-gateway/public-admin/index.html` (font link swap only). No JS changes, no markup-structure changes, class names stay. `services/den/public-admin` is legacy/inactive and out of scope.

## Intent

Restyle the admin control plane in the design language of veslo.work so the admin reads as the same product as the brand: paper ground, ink type, one cyan accent used only where it carries meaning (active nav, focus, live signals), DM Sans/DM Mono typography, hairline borders, sharp 4px geometry, flat surfaces (no glassmorphism, no glows, no gradients).

## Fonts (index.html)

Replace the current font `<link>` with:

```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,200..500&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
```

(keep the existing preconnect links to fonts.googleapis.com / fonts.gstatic.com, adding them if missing).

## Token sheet (`:root` in app.css)

Replace the existing variables with (keep existing variable *names* where they exist and map them to these values; add new ones as needed):

```css
--bg:        #f6f8fb;                 /* page ground */
--bg-panel:  #ffffff;                 /* panels, cards, sidebar */
--bg-sunk:   #f0f3f7;                 /* table headers, modal footers, plain chips */
--line:      rgba(10,14,20,0.08);     /* hairline border */
--line-2:    rgba(10,14,20,0.15);     /* stronger border: inputs, buttons, frames */
--text:      #0a0e14;                 /* ink */
--text-2:    rgba(10,14,20,0.66);     /* secondary */
--text-3:    rgba(10,14,20,0.40);     /* muted / labels */
--accent:    #00A8C8;                 /* cyan — focus, active nav, signals, chart bars */
--accent-d:  rgba(0,168,200,0.09);    /* accent tint */
--btn:       #0a0e14;                 /* primary button ground */
--btn-text:  #ffffff;
--ok:        #0e8f63;  --ok-d:   rgba(14,143,99,0.10);
--warn:      #a06a00;  --warn-d: rgba(176,120,0,0.12);
--danger:    #c73a4a;  --danger-d: rgba(199,58,74,0.10);
--info:      #0079a8;  --info-d: rgba(0,140,190,0.10);
--shadow:    0 1px 2px rgba(10,14,20,0.04);   /* the only shadow on panels */
--font:      'DM Sans', system-ui, sans-serif;
--mono:      'DM Mono', monospace;
```

Remove: page background gradients, translucent/blurred panel backgrounds, glow shadows, blue gradient tokens.

## Typography

- Body: DM Sans 300, 13–14px, color `--text-2`; headings and primary cell text in `--text`.
- Page title (`#page-title` / topbar h1): DM Sans **weight 200**, ~34px, letter-spacing −0.035em, color `--text`.
- Panel headings (h2): DM Sans 300, ~21px, letter-spacing −0.02em.
- Metric values (`.metric-card strong`): DM Sans **200**, clamp(2rem,3vw,2.6rem), letter-spacing −0.04em, `font-variant-numeric: tabular-nums`.
- Eyebrows, metric labels, table headers, chip text, segmented labels, sidebar-card eyebrows: **DM Mono 500, 9.5–10px, uppercase, letter-spacing 0.12em**, color `--text-3`.
- Numeric/table data cells and timestamps: DM Mono 400 11px where the value is machine-ish (ids, types, times); DM Sans otherwise.

## Geometry

- Radius: **4px** for buttons, inputs, cards, panels, nav items, metric cards; **6px** for modal cards and large framed shells; **3px** for status chips and count pips. No 999px pills anywhere.
- Control height: **34px** for buttons and inputs (≥40px on the <760px breakpoint for touch).
- Borders: 1px `--line` everywhere; `--line-2` on inputs, secondary buttons, modal cards, table header underline.
- Panels flat `--bg-panel` with `--shadow` only. No backdrop-filter.
- Keep existing responsive breakpoints (<1180px single column, <760px mobile nav) functionally intact.

## Components

- **Sidebar:** `--bg-panel` white, 1px right hairline. Brand mark: 28px square, 4px radius, ink ground, white glyph. Brand name DM Sans 500 14px; subtitle DM Mono uppercase 9px `--text-3`. Nav items: 8px×10px padding, 4px radius, `--text-2`, 2px transparent left border; **active:** `--accent-d` background, `--text` color, 2px `--accent` left border, weight 500. Alert count pip: 3px radius, `--danger-d`/`--danger`, DM Mono 10px. Sidebar cards: white, hairline border, 4px radius; signal dots 6px round in `--ok`/`--danger`.
- **Topbar:** bottom hairline divider; eyebrow DM Mono uppercase; title per typography above; description DM Sans 300 `--text-2`.
- **Buttons:** primary = solid `--btn` ink with `--btn-text`, weight 500 (no gradient, no glow, no translateY hover — hover darkens/lightens ground slightly); secondary = transparent, 1px `--line-2` border, `--text`; danger = `--danger-d` ground, `--danger` text, 1px `--danger` border.
- **Status chips:** 22px height, 3px radius, DM Mono 500 10px uppercase +0.06em, 5px dot in `currentColor` (keep/insert dot via CSS `::before` so markup is unchanged); success `--ok`/`--ok-d`, warning `--warn`/`--warn-d`, danger `--danger`/`--danger-d`, info `--info`/`--info-d`, unqualified chip `--text-2` on `--bg-sunk`.
- **Metric cards:** `--bg` ground inside white panels, hairline border, 4px radius, 16–18px padding; label = mono eyebrow style; note DM Sans 300 11.5px `--text-2`.
- **Inputs:** white ground, `--line-2` border, 4px radius, 34px height, placeholder `--text-3`; **focus:** `--accent` border + `0 0 0 3px var(--accent-d)` ring.
- **Segmented controls:** joined group — 1px `--line-2` border around, 4px radius, internal 1px `--line` dividers, DM Mono 11px labels; active segment `--accent-d` ground, `--text`, inset 2px bottom line in `--accent`. No pill padding gaps.
- **Tables:** header cells on `--bg-sunk`, mono eyebrow style, 1px `--line-2` underline; body rows hairline separators, 12px×16px padding, first column `--text` weight 400, others `--text-2` weight 300, `tabular-nums`.
- **Dialogs/modals:** backdrop `rgba(10,14,20,0.45)` without blur; card white, `--line-2` border, 6px radius, large soft drop shadow `0 30px 70px -30px rgba(10,14,20,0.45)`; footer on `--bg-sunk` with top hairline.
- **Charts (Usage bars):** bars in `--accent` (tints of it for secondary series), faint `--line` gridlines.
- **Toasts/status (backend connection):** white card, hairline border, 4px radius, status dot in semantic color.

## Non-goals

- No dark theme in this pass (token structure should keep one trivially addable later).
- No IA/layout restructuring, no copy changes, no JS behavior changes.

## Verification

Walk all seven views (Overview, Organization, Credentials, Usage, Alerts, Users, Audit) plus dialogs and chip states against the approved proposal mockup; check <1180px and <760px breakpoints; confirm fonts load and no rule regressions (e.g., unstyled elements that relied on removed tokens).

Proposal artifact (approved mockups): https://claude.ai/code/artifact/b7e07710-9578-4902-9d71-5a2ad251e29d
