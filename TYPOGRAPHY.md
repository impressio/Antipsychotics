# Typography

One type system for every part of the app: sections, cards, tables, forms, plots, canvas drawings and equations. When a value below and the code disagree, the code is wrong.

## Font

| Use | Font |
|---|---|
| All text (HTML, plots, canvas labels, form controls, buttons) | `Inter`, fallback `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| Code and residue names (`Asp114`) | `ui-monospace, "SF Mono", Menlo, monospace` |
| Equations (KaTeX) | inherit the surrounding font and size (already set in `css/styles.css`) |

Form controls do not inherit fonts by default: `select`, `input`, `textarea` and `button` must set `font: inherit` (or the family explicitly), so none falls back to Arial.

## Size scale

Use only these sizes. Do not introduce fractional `rem`/`em` sizes (e.g. `.82rem`, `0.92em`) that compute to in-between values.

| Token | Size / weight | Line height | Used for |
|---|---|---|---|
| `--fs-display` | `clamp(1.6rem, 3vw, 2.25rem)` / 600 | 1.2 | page title (h1) only |
| `--fs-h2` | 20px / 600 | 1.2 | section titles |
| `--fs-h3` | 15px / 600 | 1.4 | card and panel titles (h3, h4) |
| `--fs-body` | **14px / 400** | 1.5 | all running text: the eyebrow line above the page title, hero and section introductions, card paragraphs, summaries, **table cells and headers**, list items, notes and references, tooltips with sentences |
| `--fs-small` | 12px / 400-500 | 1.5 | form labels, buttons, chips, badges, legends, readout labels, hints, footer, figure and axis text |
| `--fs-value` | 15px / 600 | 1.4 | numeric readout values |

Subscripts and superscripts (`<sub>`, `<sup>`) keep the browser's relative size and are exempt from the scale. Single-line pills, badges and chips may use a compact line height (1.2-1.4); all running text uses 1.5.

**Tables use `--fs-body`**: cells, headers and any text inside them have the same family, size and line height as paragraph text. Headers differ only by weight (600). No smaller or gray text inside tables, and no code-box styling for ordinary table content.

## Weight and style

- Weights: 400 (text), 500 (labels, buttons), 600 (headings, table headers, emphasis, values). Do not use 700 or 800.
- Bold (`<b>`, `<strong>`) renders as 600.
- Links are never underlined; on hover they turn 600 (except the top menu and the logo, which keep their weight and use a background highlight).
- Italic only for: variables in equations, journal names in references, Latin terms, and the model-assumption note under a figure (`.dose-model-note`). Not for emphasis.
- No uppercase text except established abbreviations (D2, 5-HT, PK, IV, LAI …); badges and headings use sentence case.

## Color

- Text in `--ink`. Secondary information (captions, hints, notes) in `--muted`.
- Table text is never muted.

## Plots (Plotly)

- `layout.font = { family: <the Inter stack above>, size: 12, color: <--ink> }` for every plot.
- Axis titles, tick labels, legends and annotations: 12px. Nothing smaller than 11px (only dense in-plot annotations such as effect-band labels may use 11px).
- Hover labels: `hoverlabel.font` with the same family, 12px.
- Define the font once (shared constant) and reuse it; do not repeat literals per plot: `AP.plotFont()` (`js/data.js`) reads family, size and color from the CSS tokens; pass overrides as an object, e.g. `AP.plotFont({ color })`.

## Canvas and SVG drawings

- Text drawn on a canvas (e.g. the 2D brain map labels) or as 3Dmol.js labels in the receptor view uses the same family and `--fs-small` (12px) at CSS pixel size (via `AP.plotFont()`); scale for device pixel ratio, not the font size.
- Pre-rendered SVG drawings (chemical structures) draw labels as paths; their size is set by the build script and does not need to follow the scale.

## Responsive sizes

- The same scale applies on all screen sizes; do not shrink body or table text on mobile.
- Exception: display (h1) scales with `clamp()`, and wide equations may be scaled down to fit (never below 60 %).

## Implementation rules

- The tokens are defined once in `:root` of `css/styles.css` (`--font`, `--font-mono`, `--fs-display`, `--fs-h2`, `--fs-h3`, `--fs-body`, `--fs-small`, `--fs-value`); every `font-size` in the CSS uses one of them; no font sizes in inline `style` attributes or in JavaScript-generated HTML.
- JavaScript that needs a size (Plotly, canvas) reads it from the CSS tokens or one shared constant.
- After any typography change, verify in headless Chromium (computed `font-family`, `font-size`, `font-weight` per element group) that only the sizes above occur.
