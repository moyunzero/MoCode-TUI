# AGENTS.md

Guidance for any AI agent or contributor working on MoCode.

## UI standard — read before touching the CLI

**[`DESIGN.md`](./DESIGN.md) is the single source of truth for all terminal UI.**

MoCode is a terminal-native app (OpenTUI + React), not a web app. Before adding
or changing anything under `packages/cli/src/components/`, `screens/`, or
`layouts/`, conform to DESIGN.md:

- Layout is **bottom-anchored**: scrolling transcript above, pinned composer +
  single status line below.
- Measurements are **character cells**, not pixels. No fonts, `px`,
  border-radius, or shadows.
- Color is **theme-driven**: resolve semantic tokens via `useTheme()`
  (`packages/cli/src/theme.ts`). **Never hardcode hex** in a component.
- Mode tint is global: `{color.primary}` (Build) / `{color.planMode}` (Plan) on
  the accent bar (`┃`), `◉`, and spinner.
- Reference DESIGN.md tokens (`{color.*}`, `{glyph.*}`, `{space.*}`, `{size.*}`).
  If you need a value that isn't a token, add it to DESIGN.md first, then use it.
- Follow the dialog shell + Width & Overflow rules (cap then truncate, no phantom
  scrollbars, single `esc` affordance in the header).

If a plan or `/gsd-ui-phase` UI-SPEC contradicts DESIGN.md, DESIGN.md wins —
reconcile to it.
