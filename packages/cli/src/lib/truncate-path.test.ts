import { describe, expect, test } from "bun:test";
import { truncatePathForDisplay } from "./truncate-path";

describe("truncatePathForDisplay", () => {
  test("returns path unchanged when it fits", () => {
    expect(truncatePathForDisplay("/short", 20)).toBe("/short");
  });

  test("keeps the tail with a leading ellipsis", () => {
    const path = "/Users/moyun/code/mocode/.mocode/mcp.json";
    expect(truncatePathForDisplay(path, 24)).toBe("…mocode/.mocode/mcp.json");
  });

  test("handles maxWidth of 1", () => {
    expect(truncatePathForDisplay("/long/path", 1)).toBe("…");
  });
});
