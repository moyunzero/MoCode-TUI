import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearToolTiming,
  formatToolElapsed,
  markToolStarted,
  resetToolTimings,
  toolElapsedMs,
} from "./tool-timing";

beforeEach(() => resetToolTimings());

describe("tool timing registry", () => {
  test("reports elapsed time from the mark", () => {
    markToolStarted("call-1", 1_000);
    expect(toolElapsedMs("call-1", 3_400)).toBe(2_400);
  });

  test("unknown calls report null instead of a fake zero", () => {
    expect(toolElapsedMs("never-seen", 5_000)).toBeNull();
  });

  test("the first mark wins, so a retry does not reset the clock", () => {
    markToolStarted("call-1", 1_000);
    markToolStarted("call-1", 9_000);
    expect(toolElapsedMs("call-1", 3_000)).toBe(2_000);
  });

  test("never reports negative time if the clock jumps backwards", () => {
    markToolStarted("call-1", 5_000);
    expect(toolElapsedMs("call-1", 1_000)).toBe(0);
  });

  test("clearing removes the entry", () => {
    markToolStarted("call-1", 1_000);
    clearToolTiming("call-1");
    expect(toolElapsedMs("call-1", 2_000)).toBeNull();
  });

  test("stays bounded across a long session", () => {
    for (let index = 0; index < 700; index += 1) {
      markToolStarted(`call-${index}`, index);
    }

    // Oldest evicted, newest retained — no unbounded growth.
    expect(toolElapsedMs("call-0", 1_000)).toBeNull();
    expect(toolElapsedMs("call-699", 1_000)).not.toBeNull();
  });
});

describe("formatToolElapsed", () => {
  test("tenths under a minute", () => {
    expect(formatToolElapsed(2_300)).toBe("2.3s");
  });

  test("minutes past 60s", () => {
    expect(formatToolElapsed(125_000)).toBe("2m5s");
  });
});
