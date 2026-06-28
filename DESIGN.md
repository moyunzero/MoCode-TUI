---
version: 1.0
name: MoCode-TUI-Design-System
description: >-
  The authoritative UI standard for MoCode — a terminal-native AI coding agent
  built on OpenTUI + React. This is NOT a web design system: there are no pixels,
  no fonts, no shadows, no hero bands. The unit of layout is the character cell;
  color is theme-driven (32 named palettes in packages/cli/src/theme.ts); depth
  comes from box-drawing accent bars and background fills, never drop shadows.
  The composition is bottom-anchored (Claude Code / Codex convention): a
  scrolling transcript above, a pinned composer and a single status line below.
  MoCode's signature is the left-accent bar (┃) that tints every message and the
  composer by agent mode, instead of full bordered boxes or background-filled
  prompts. Any LLM or contributor building MoCode UI MUST follow this document.

# ─────────────────────────────────────────────────────────────────────────────
# AUTHORITY
# This file is the single source of truth for MoCode's terminal UI. When a GSD
# UI phase (/gsd-ui-phase), a plan, or a feature touches the CLI surface, the
# implementation MUST conform to the tokens, layout anatomy, and component specs
# below. Reference tokens by their {ref} form (e.g. {color.primary},
# {glyph.accent-bar}, {space.gutter}) — never hardcode hex or magic cell counts
# in component code without a matching token here.
# ─────────────────────────────────────────────────────────────────────────────

# Runtime / rendering substrate (informational — do not redefine in components)
runtime:
  engine: "OpenTUI (@opentui/core + @opentui/react)"
  layout: "Flexbox over character cells (box flexDirection/gap/padding/width)"
  unit: "1 cell = 1 monospace column (x) / 1 row (y). All spacing is integer cells."
  color: "24-bit hex resolved per active theme; never assume a fixed palette."
  primitives: ["box", "text", "input", "textarea", "scrollbox", "ascii-font", "em"]
  emphasis: ["TextAttributes.BOLD", "TextAttributes.DIM", "TextAttributes.ITALIC", "<em fg=…>"]

# ── Color tokens ──────────────────────────────────────────────────────────────
# These are SEMANTIC names resolved from the active theme via useTheme().colors.
# 32 palettes exist; DESIGN.md fixes the MEANING of each token, not its hex.
# Components MUST read colors from the theme context — never inline a hex value.
colors:
  primary:        "Build-mode accent. Composer/user-message left bar, ◉ glyph, primary spinner, key affordances."
  planMode:       "Plan-mode accent. Replaces primary on every mode-tinted element when mode = PLAN."
  selection:      "Active-row highlight fill in lists/menus/action buttons. Selected text flips to black on this fill."
  thinking:       "Reasoning emphasis (the 'Thinking:' label and inline reasoning accents)."
  thinkingBorder: "The vertical │ accent bar on reasoning + tool blocks. Muted, recedes behind content."
  success:        "Confirmations, connected status, additions."
  error:          "Failures, rejections, deletions, disabled/failed status."
  info:           "Tool-name labels, neutral informational accents (the › separators lean on dimSeparator)."
  background:     "App canvas floor — the terminal base behind the transcript."
  surface:        "Raised fill for the composer interior and inline message bodies (user/assistant text wells)."
  dialogSurface:  "Modal overlay card fill. One step DARKER than surface so dialogs read as 'above' the canvas."
  dimSeparator:   "Low-contrast › / · separators and meta dividers in status/footer rows."

# ── Spacing tokens (cells) ────────────────────────────────────────────────────
# Terminal spacing is coarse. Keep it to these values; do not invent 0.5-cell
# fractions except the documented header kerning.
space:
  none: 0      # tight stacks (action button lists use gap 0)
  hair: 1      # default vertical gap between stacked blocks and inline gaps
  gutter: 2    # horizontal padding inside message wells, composer, list rows
  inset: 2     # screen edge padding (SessionShell paddingX)
  dialog-x: 4  # dialog card horizontal padding
  dialog-y: 1  # dialog card vertical padding
  text-indent: 3  # assistant plain-text left padding (deeper than accent blocks)

# ── Sizing tokens (cells) ─────────────────────────────────────────────────────
size:
  dialog-width: "min(72, cols - 4)"   # cap card width; never full-bleed. Long content TRUNCATES, never wraps the card wider.
  list-max-rows: 8                     # command/mention/search lists: viewport caps at 8 rows, then scroll
  dialog-list-max-rows: 6              # in-dialog lists (e.g. /mcp) cap at 6 rows
  command-col: "max(command-name-len) + 4"  # fixed name column so descriptions align
  status-row: 1                        # status/footer is exactly one row
  row: 1                               # list/menu/action rows are single-row, overflow hidden

# ── Glyph tokens (box-drawing + markers) ──────────────────────────────────────
# MoCode's visual identity lives in these glyphs. The accent bar is the signature.
glyph:
  accent-bar: "┃"        # heavy vertical — left edge of composer + user message, tinted by mode
  accent-foot: "╹"       # heavy bottom-left cap closing the accent bar
  quiet-bar: "│"         # light vertical — reasoning + tool blocks (recedes vs accent-bar)
  mode-dot: "◉"          # assistant message mode marker (primary=Build / planMode=Plan)
  sep-chevron: "›"       # inline meta separator (mode › model › duration), in dimSeparator
  sep-dot: "·"           # secondary inline separator in status/footer
  rule: "─"              # horizontal separator rule (use sparingly; prefer whitespace)
  pending: "…"           # trailing ellipsis on in-flight tool/streaming states
  esc-affordance: "esc"  # dim text in the dialog header's top-right — the ONLY close hint a dialog shows

# ── Emphasis hierarchy (replaces web "typography") ────────────────────────────
# Terminals have no type scale. Hierarchy is built from attribute + color + glyph.
emphasis:
  display:   "ascii-font (tiny) — reserved for the MoCode wordmark on the home header only"
  title:     "BOLD default-fg — dialog titles, action-button labels, list primary text"
  body:      "default-fg, no attribute — message text, transcript content"
  label:     "<em fg={color.info|thinking}> — inline tool/reasoning labels before content"
  meta:      "DIM (+ dimSeparator fg on separators) — model, duration, hints, paths, captions"
  selected:  "fg flips to black over {color.selection} fill — the universal 'active row' signal"

# ── Component registry (specs live in prose below; keep refs stable) ──────────
components:
  app-shell:        { ref: SessionShell,        role: "Root vertical layout: transcript / composer / status" }
  home-header:      { ref: Header,              role: "Centered MoCode ascii wordmark on the home screen" }
  user-message:     { ref: UserMessage,         role: "User turn — mode-tinted accent bar + surface well" }
  assistant-message:{ ref: BotMessage,          role: "Assistant turn — text + reasoning/tool blocks + mode footer" }
  reasoning-block:  { ref: "BotMessage.reasoning", role: "quiet-bar block, 'Thinking:' label, dim body" }
  tool-block:       { ref: "BotMessage.tool",   role: "quiet-bar block, info-colored tool label, args, pending/error suffix" }
  composer:         { ref: InputBar,            role: "Multiline textarea inside the mode-tinted accent bar; hosts overlays" }
  status-bar:       { ref: StatusBar,           role: "Single dim row: mode › model · submit · newline hints" }
  session-footer:   { ref: "SessionShell.footer", role: "Spinner + interrupt hint (left) / tab-agent hint (right)" }
  dialog-shell:     { ref: "DialogProvider.Dialog", role: "Centered modal overlay card; dim backdrop; title + esc-affordance" }
  search-list:      { ref: DialogSearchList,    role: "Filter input + scrolling single-select list with selection highlight" }
  action-button:    { ref: "ActionButton",      role: "Single-row selectable label (+dim hint); used in approval dialogs" }
  command-menu:     { ref: CommandMenu,         role: "Slash-command palette floating above the composer" }
  mention-menu:     { ref: FileMentionMenu,     role: "@-file palette floating above the composer" }
  spinner:          { ref: Spinner,             role: "Async activity indicator, tinted by mode" }
---

## Overview

MoCode is a **terminal-native** product. Its closest design relatives are
**Claude Code** and the **OpenAI Codex CLI** — not a web app. Three principles
inherited from those tools, and one signature that is MoCode's own, define the
whole system:

1. **Bottom-anchored composition.** The transcript scrolls in the upper region;
   the composer and a single status line are pinned to the bottom. The user's
   eyes and hands live at the bottom of the screen. (Both Claude Code and Codex
   converge on this.)
2. **Cells, not pixels.** Every measurement is an integer character cell. Layout
   is Flexbox over cells via OpenTUI `box`. There are no fonts, no `px`, no
   border-radius, no drop shadows.
3. **Theme-driven color.** There is no single palette. 32 named themes live in
   `packages/cli/src/theme.ts`; components resolve **semantic tokens**
   (`{color.primary}`, `{color.surface}`, …) from `useTheme()`. Never hardcode a
   hex value in a component.
4. **The accent bar is the signature** (MoCode's own). Instead of Codex's
   background-filled prompt or Claude Code's separator-framed box, MoCode marks
   the composer and the user's message with a heavy left bar `{glyph.accent-bar}`
   tinted by agent mode — `{color.primary}` in Build, `{color.planMode}` in Plan.
   Assistant reasoning/tool blocks use a quieter `{glyph.quiet-bar}`. This left-rail
   rhythm is what makes a MoCode screen recognizable at a glance.

> Why this rewrite exists: the previous DESIGN.md described the Claude.com
> marketing website (cream canvas, serif display, pricing cards, footer). MoCode
> ships none of that. This document replaces it with the real, terminal substrate.

## Layout Anatomy

Read **bottom-up** — the way the user experiences it. This mirrors Claude Code's
`output → separator → prompt → status → mode` stack and Codex's
`conversation view → bottom pane (composer + status)` split.

```
┌ terminal viewport ───────────────────────────────────────────┐
│                                                               │
│   ◉ Build › model                  ← assistant message footer │
│   <assistant text / reasoning / tool blocks>                  │  scrolling
│   ┃ <user message>                 ← mode-tinted accent bar   │  transcript
│   ◉ Build › model                                             │  (scrollbox,
│   <assistant text>                                            │   sticky to
│                                       …grows upward…          │   bottom)
│                                                               │
│   ┃                                                           │
│   ┃  Ask anything... "Fix a bug in the database"   ← composer │  pinned
│   ╹  Build › model · ⏎ 提交 · Ctrl+J 换行          ← status   │  bottom
│      ⟳ esc to interrupt                    tab agent ← footer  │  pane
└───────────────────────────────────────────────────────────────┘
```

- **Transcript** (`{components.app-shell}` scrollbox): `flexGrow=1`, `stickyScroll`
  to bottom so the newest turn stays visible as history grows.
- **Composer** (`{components.composer}`): the mode-tinted accent-bar well with a
  multiline `textarea`. Slash-command and @-mention palettes float **above** it
  (`position:absolute; bottom:100%`), never pushing the transcript.
- **Status line** (`{components.status-bar}`): exactly one dim row, Codex-style —
  `mode {glyph.sep-chevron} model {glyph.sep-dot} submit hint {glyph.sep-dot} newline hint`.
- **Footer** (`{components.session-footer}`): spinner + `esc to interrupt` on the
  left while streaming; `tab agent` hint pinned right.

### Screen edges & width discipline
- The shell insets the whole app by `{space.inset}` horizontally, `{space.hair}`
  vertically (`SessionShell paddingX=2 paddingY=1`).
- Transcript content stretches full width but each block manages its own
  `{space.gutter}` interior padding.
- **Modals never go full-bleed.** Dialog cards cap at `{size.dialog-width}`
  and are centered. Content that exceeds the card **truncates** (see Width Rules);
  the card never grows to fit a long string.

## Color System

MoCode is **dark-first** and theme-driven. The active theme supplies every token;
the same component looks correct across all 32 palettes because it only ever
references semantic names.

### Token meanings (stable across themes)
| Token | Meaning |
|---|---|
| `{color.primary}` | Build-mode accent — composer/user accent bar, `{glyph.mode-dot}`, primary spinner |
| `{color.planMode}` | Plan-mode accent — swaps in for `primary` on every mode-tinted element |
| `{color.selection}` | Active-row fill in any list/menu/button; selected fg flips to black |
| `{color.thinking}` | Reasoning emphasis (the `Thinking:` label / inline accents) |
| `{color.thinkingBorder}` | The `{glyph.quiet-bar}` rail on reasoning + tool blocks |
| `{color.info}` | Tool-name labels and neutral info accents |
| `{color.success}` / `{color.error}` | Status, approvals/rejections, diff add/remove |
| `{color.background}` | Canvas floor behind the transcript |
| `{color.surface}` | Raised well behind composer + inline message text |
| `{color.dialogSurface}` | Modal card fill — one step **darker** than `surface` |
| `{color.dimSeparator}` | `{glyph.sep-chevron}` / `{glyph.sep-dot}` separators and meta dividers |

### Rules
- **Never inline hex.** Resolve from `useTheme().colors`. A literal `#…` in a
  component is a design-system violation.
- **Mode tinting is binary and consistent.** Any element that signals agent mode
  uses `{color.primary}` (Build) or `{color.planMode}` (Plan) — composer bar, user
  accent bar, `{glyph.mode-dot}`, spinner. Never mix (e.g. a Build bar with a Plan dot).
- **Selection is the only "fill" interaction.** Active rows fill with
  `{color.selection}` and flip text to black. Don't invent hover styling — the
  terminal has no hover; pointer `onMouseMove` only mirrors keyboard selection.
- **Backdrop dims, never blacks out.** The dialog overlay is translucent black
  (`RGBA 0,0,0,~150`) so the transcript stays faintly visible behind the modal.

## Emphasis & "Typography"

There is no type scale in a terminal. Hierarchy is composed from **attribute +
color + glyph**:

| Level | Token | Treatment | Use |
|---|---|---|---|
| Display | `{emphasis.display}` | `ascii-font` (tiny) | MoCode wordmark on home only |
| Title | `{emphasis.title}` | `BOLD`, default fg | Dialog titles, action labels, list primary text |
| Body | `{emphasis.body}` | default fg, no attribute | Transcript + message content |
| Label | `{emphasis.label}` | `<em fg={color.info\|thinking}>` | Inline tool/reasoning labels |
| Meta | `{emphasis.meta}` | `DIM` (+ `dimSeparator`) | Model, duration, hints, paths, captions |
| Selected | `{emphasis.selected}` | black fg over `{color.selection}` | The universal active-row signal |

Principles:
- **Reach for DIM before color.** Most secondary text is `DIM`, not a new hue.
  Color is reserved for mode, status, and selection.
- **BOLD is for the one primary thing** in a region (a dialog title, a button
  label) — not for whole paragraphs.
- **Glyphs carry structure**, attributes carry emphasis. The `{glyph.mode-dot}`,
  `{glyph.accent-bar}`, and `{glyph.sep-chevron}` do the work a font weight or
  rule would do on the web.

## Components

### App shell — `{components.app-shell}`
Root column: `width/height 100%`, `flexDirection=column`, `gap {space.hair}`,
`paddingY {space.hair}`, `paddingX {space.inset}`. Three children, top→bottom:
scrollbox transcript (`flexGrow=1`, `stickyScroll` to bottom) · composer
(`flexShrink=0`) · status/footer row (`flexShrink=0`, `{size.status-row}`).

### Home header — `{components.home-header}`
Centered `ascii-font` wordmark: `Mo` in gray + `Code` in default, kerning `gap 0.5`.
The only place `{emphasis.display}` is used. No tagline chrome.

### User message — `{components.user-message}`
Mode-tinted **accent bar** + surface well:
- Left `border:["left"]` with `customBorderChars` `vertical={glyph.accent-bar}`,
  `bottomLeft={glyph.accent-foot}`; `borderColor` = `{color.primary}` (Build) or
  `{color.planMode}` (Plan).
- Inner box: `backgroundColor {color.surface}`, `paddingX {space.gutter}`,
  `paddingY {space.hair}`, full width. Body text in `{emphasis.body}`.

### Assistant message — `{components.assistant-message}`
A stack of part-blocks followed by a mode footer.
- **Plain text part:** `paddingX {space.text-indent}` (deeper than accent blocks,
  so prose sits inset from the rail rhythm), `{emphasis.body}`.
- **Reasoning block** (`{components.reasoning-block}`): `border:["left"]`,
  `vertical={glyph.quiet-bar}`, `borderColor {color.thinkingBorder}`,
  `paddingX {space.gutter}`. Content `DIM` with `<em fg={color.thinking}>Thinking:</em>` prefix.
- **Tool block** (`{components.tool-block}`): same quiet-bar frame. Label
  `<em fg={color.info}>ToolName:</em>` + args (`DIM`). Append `{glyph.pending}`
  while running; append error text in place on `output-error`.
- **Mode footer:** `{glyph.mode-dot}` in `{color.primary}`/`{color.planMode}` then
  `Build|Plan {glyph.sep-chevron} model [{glyph.sep-chevron} duration]`, separators
  in `{color.dimSeparator}`, meta `DIM`. While streaming with no text/tools yet,
  show `Generating response{glyph.pending}` (DIM).

### Composer — `{components.composer}`
The interactive heart. Mode-tinted accent bar identical to the user message
(`{glyph.accent-bar}` + `{glyph.accent-foot}`, mode color). Interior:
`backgroundColor {color.surface}`, `paddingX {space.gutter}`, `paddingY {space.hair}`,
`gap {space.hair}`, holding a `textarea` (placeholder
`Ask anything... "Fix a bug in the database"`) above the `{components.status-bar}`.
Command/mention palettes mount as `position:absolute; bottom:100%; width:100%;
backgroundColor {color.surface}; zIndex≥10` so they overlay upward without
shifting the transcript.

### Status bar — `{components.status-bar}`
Codex-style **single row**, all `DIM`:
`{mode color}Build|Plan{/} {glyph.sep-chevron} model {glyph.sep-dot} ⏎ 提交 {glyph.sep-dot} Ctrl+J 换行`.
Separators use `{color.dimSeparator}`. Keep it to one line; if the terminal is
narrow, drop the rightmost hints first (newline hint, then submit hint) — never
wrap to two rows.

### Session footer — `{components.session-footer}`
Row, `justify space-between`, `{size.status-row}` tall. Left cluster: while
`loading`, a `{components.spinner}` (mode-tinted) + optional `esc to interrupt`.
Right cluster: `tab` + `DIM agent` hint, pinned with `marginLeft:auto`.

### Dialog shell — `{components.dialog-shell}`
The modal contract every overlay shares. Fixing its consistency is the core of
this revision.
- **Overlay:** absolute, full viewport, translucent black backdrop; click on the
  backdrop closes (`onMouseDown` → close). Card centered.
- **Card:** `width {size.dialog-width}`, `backgroundColor {color.dialogSurface}`,
  `paddingX {space.dialog-x}`, `paddingY {space.dialog-y}`, `flexDirection=column`,
  `gap {space.hair}`, `zIndex 100`.
- **Header row:** `justify space-between`. Title in `{emphasis.title}` (BOLD) at
  left; `{glyph.esc-affordance}` in `DIM` at right. **This is the only close hint.**
  Dialog bodies MUST NOT add their own "Esc to close" / "esc to close" line — it
  duplicates the header and wastes a row.
- **Body:** the dialog's content component, full width.

### Search list — `{components.search-list}`
`input` (filter, `focused`) above a `scrollbox` capped at `{size.list-max-rows}`
(or `{size.dialog-list-max-rows}` inside a dialog). Rows are `{size.row}` tall,
`overflow:hidden`. Selected row fills `{color.selection}` with black fg
(`{emphasis.selected}`). Empty state: a single `DIM` line (`emptyText`).
**Scroll chrome only when needed:** if items ≤ viewport, render no scrollbar — a
one-item list must not show a tall scrollbar (a current bug; see Width & Overflow).

### Action button — `{components.action-button}`
Single-row selectable: `paddingX {space.hair}`, `{size.row}` tall. Label in BOLD;
optional `hint` appended in `DIM`/gray. Selected → `{color.selection}` fill, black
fg. Lists of action buttons stack with `gap {space.none}` (tight). Used by the
bash / MCP approval dialogs; default highlight is the **safe** choice (Reject).

### Command & mention menus — `{components.command-menu}` / `{components.mention-menu}`
Float above the composer. Command palette: fixed `{size.command-col}` name column
(so descriptions align) + flexible description column (`overflow:hidden`).
Viewport caps at `{size.list-max-rows}`, then scrolls. Same selection model as the
search list. Empty state is a single `DIM` line.

### Spinner — `{components.spinner}`
Async indicator tinted by mode (`{color.primary}`/`{color.planMode}`). Appears in
the session footer while the assistant streams, and inline where an operation is
pending. Pair with `{glyph.pending}` on the related text, not as a replacement.

## Width & Overflow Rules

Terminal width is the scarcest resource and the source of the reported layout
bugs. These rules are normative.

1. **Cap, then truncate — never wrap the card.** A dialog card is `{size.dialog-width}`.
   Long single-line values (file paths, model ids, commands) MUST be truncated to
   fit. For paths, prefer **leading-ellipsis** truncation that keeps the tail:
   `…/.mocode/mcp.json` rather than wrapping `/Users/long/…/mcp.json` across rows.
2. **Demote low-value chrome.** Absolute config paths, ids, and similar are
   `{emphasis.meta}` (DIM) and may be hidden when space is tight. They are
   reference detail, not primary content — they must not dominate a dialog.
3. **No phantom scrollbars.** A `scrollbox` height is `min(itemCount, maxRows)`.
   When `itemCount ≤ maxRows`, do not reserve or render scroll chrome. A list
   showing one item must look like one item, not a scroll region.
4. **One-row rows.** List/menu/status rows are `{size.row}` with `overflow:hidden`.
   Never let a row reflow to two lines; truncate the secondary column first.
5. **Status never wraps.** The status line drops hints right-to-left under width
   pressure instead of becoming a second row.
6. **Inset budget.** Account for `{space.inset}` (shell) and `{space.dialog-x}`
   (card) when computing usable width: usable ≈ `min(72, cols-4) - 8`.

## Motion & Feedback

- **Streaming first.** Render assistant output incrementally; show
  `Generating response{glyph.pending}` only until the first text/tool part lands.
- **Spinner = work in progress**, tinted by mode. Stop it the instant the turn
  settles to `ready`/`error`.
- **No artificial delay.** Never use timers to "smooth" UI; drive everything off
  real events/lifecycles (a hard rule — see the project's debug guidelines).
- **Selection feedback is instant**: arrow keys and `onMouseMove` both update the
  selected row's `{color.selection}` fill with no transition.

## Do's and Don'ts

### Do
- Anchor the experience at the bottom: transcript above, composer + single status
  line below.
- Tint the composer and user message with the **mode accent bar**
  (`{glyph.accent-bar}` + `{glyph.accent-foot}`), `{color.primary}`/`{color.planMode}`.
- Use the **quiet bar** (`{glyph.quiet-bar}`, `{color.thinkingBorder}`) for
  reasoning/tool blocks so they recede behind the conversation.
- Resolve every color from the theme; verify a new screen against several themes
  (e.g. Nightfox, Gruvbox Dark, GitHub Dark) before shipping.
- Keep one consistent dialog shell: centered card, dim backdrop, title +
  `{glyph.esc-affordance}` in the header, content below.
- Truncate long paths/ids with leading ellipsis; keep them `DIM`.
- Prefer whitespace (`gap {space.hair}`) over horizontal rules for separation.

### Don't
- Don't import web design language — no fonts, `px`, border-radius, shadows,
  hero/pricing/footer bands. (That was the prior DESIGN.md's mistake.)
- Don't hardcode hex colors in components. Always `useTheme()`.
- Don't add a body-level "Esc to close" line; the dialog header already shows
  `{glyph.esc-affordance}`.
- Don't render scrollbars for lists that fit; don't let one item show a tall bar.
- Don't let any row wrap to two lines or let a dialog grow wider than
  `{size.dialog-width}` to fit content — truncate instead.
- Don't invent hover states; the terminal has none. Pointer events only mirror
  keyboard selection.
- Don't mix mode accents (e.g. Build bar with a Plan dot). Mode tint is global per
  turn/composer.

## Responsive Behavior (terminal sizes)

The viewport is the terminal's `cols × rows`; "responsive" means degrading
gracefully as cells shrink.

| Width (cols) | Behavior |
|---|---|
| Wide (≥ 100) | Full layout; dialogs at 72 cols; all status hints visible |
| Normal (80–99) | Dialogs at `cols-4`; status keeps mode/model + submit hint |
| Narrow (< 80) | Drop rightmost status hints; truncate model id; paths leading-ellipsis; menus stay ≤ `{size.list-max-rows}` |

- Vertically, the transcript scrollbox absorbs the slack (`flexGrow=1`); composer,
  status, and footer keep their fixed heights so the input never scrolls off.
- Long transcript content scrolls; it does not reflow the composer or status.

## Iteration Guide (for contributors & LLMs)

1. **Start from the layout anatomy.** Decide where the change lives: transcript
   block, composer, status, or modal. Reuse the matching `{components.*}` spec.
2. **Reference tokens, not literals.** Use `{color.*}`, `{glyph.*}`, `{space.*}`,
   `{size.*}`. If you need a value that isn't a token, add the token here first,
   then use it — keep DESIGN.md and the code in lockstep.
3. **One component at a time.** Variants (selected/disabled/error) are states of
   an existing component, not new ones.
4. **Mode tint and selection are global patterns** — apply them the same way
   everywhere; don't reinvent per screen.
5. **Test across themes and widths.** A screen is done when it reads correctly in
   3+ themes and at 80 and 120 cols.
6. **When in doubt about emphasis:** DIM it before coloring it; structure with a
   glyph before adding a rule.
7. **GSD UI phases** (`/gsd-ui-phase`, UI-SPEC.md) MUST treat this file as the
   design contract. A UI-SPEC that contradicts these tokens is wrong and should
   be reconciled to DESIGN.md.

## Known Gaps / Out of Scope

- **Per-theme hex** is intentionally not duplicated here — `theme.ts` is the
  palette source; DESIGN.md fixes token meaning only.
- **Diff rendering** (syntax-highlighted add/remove blocks) is implied by
  `{color.success}`/`{color.error}` but not yet a formalized component; spec it
  here when built.
- **Markdown rendering inside assistant text** (lists, code fences, inline code)
  uses default body emphasis today; a richer markdown component is a future token
  set.
- **Mouse interaction** beyond selection mirroring and backdrop-close is
  out of scope; MoCode is keyboard-first.
- **ascii-font** usage is limited to the home wordmark; large banners elsewhere
  are discouraged (they eat vertical budget).
