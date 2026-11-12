/**
 * Headless render harness for the TUI.
 *
 * The CLI had no component-level test infrastructure: every existing test covered
 * pure logic, so rendered output (status line, dialogs, transcript rows, width
 * behaviour) could only be checked by hand in a real terminal. `@opentui/react`
 * ships a test renderer whose frame we can assert on as plain text, which is what
 * this module wraps.
 *
 * What it gives us:
 * - `renderText(node)` → the captured character frame, trailing spaces trimmed
 * - provider wrapping (theme + prompt config) so components render in isolation
 * - `renderLines(node)` → the frame as lines, for row-count / width assertions
 *
 * It does NOT cover: keyboard input, scrolling, or anything that needs a real
 * TTY. Those still need a manual run (`bun run dev`).
 */
import { act } from "react";
import type { ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ThemeProvider } from "../providers/theme";
import { PromptConfigProvider } from "../providers/prompt-config";

export type RenderOptions = {
  /** Terminal columns. Default 100 — wide enough that nothing wraps by accident. */
  width?: number;
  /** Terminal rows. Default 6. */
  height?: number;
};

/**
 * Render `node` in a headless terminal and return the captured frame.
 *
 * Lines are right-trimmed and trailing blank rows dropped, so assertions read
 * like `expect(frame).toContain("turn 3/24")` instead of comparing padding.
 */
export async function renderText(
  node: ReactNode,
  { width = 100, height = 6 }: RenderOptions = {},
): Promise<string> {
  const setup = await testRender(
    <ThemeProvider>
      <PromptConfigProvider>{node}</PromptConfigProvider>
    </ThemeProvider>,
    { width, height },
  );

  try {
    await act(async () => {
      await setup.renderOnce();
    });
    return normalizeFrame(setup.captureCharFrame());
  } finally {
    await act(async () => {
      setup.renderer.destroy();
    });
  }
}

/** {@link renderText} split into rows — use for "must stay on one row" assertions. */
export async function renderLines(node: ReactNode, options: RenderOptions = {}): Promise<string[]> {
  const frame = await renderText(node, options);
  return frame.length === 0 ? [] : frame.split("\n");
}

/** Right-trim every line and drop trailing blank rows. */
export function normalizeFrame(frame: string): string {
  return frame
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
