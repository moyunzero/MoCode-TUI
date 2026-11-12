import { describe, expect, test } from "bun:test";
import {
  detectSandbox,
  probeBwrap,
  probeSeatbelt,
  sandboxCapability,
  resetSandboxCapability,
  type ProbeRunner,
} from "./sandbox-capability";

const applies: ProbeRunner = () => ({ exitCode: 0, output: "" });
const refuses: ProbeRunner = () => ({
  exitCode: 1,
  output: "sandbox-exec: sandbox_apply: Operation not permitted",
});

describe("seatbelt probe", () => {
  test("available when the profile actually applies", () => {
    expect(probeSeatbelt(applies)).toMatchObject({ backend: "seatbelt", available: true });
  });

  test("unavailable when the binary exists but cannot apply", () => {
    // The real-world case: /usr/bin/sandbox-exec is present, nesting is refused.
    const capability = probeSeatbelt(refuses);
    expect(capability.available).toBe(false);
    expect(capability.detail).toContain("Operation not permitted");
  });
});

describe("bwrap probe", () => {
  test("available when a bind mount succeeds", () => {
    expect(probeBwrap(applies)).toMatchObject({ backend: "bwrap", available: true });
  });

  test("unavailable when bwrap is missing", () => {
    const capability = probeBwrap(() => ({ exitCode: 127, output: "bwrap: command not found" }));
    expect(capability.available).toBe(false);
  });
});

describe("detectSandbox", () => {
  test("picks the backend by platform and never claims capability it cannot prove", () => {
    const capability = detectSandbox(refuses);
    expect(capability.available).toBe(false);
    expect(["seatbelt", "bwrap", "none"]).toContain(capability.backend);
  });
});

describe("sandboxCapability memoisation", () => {
  test("env opt-out reports unconfined without probing", () => {
    resetSandboxCapability();
    process.env.MOCODE_ALLOW_UNCONFINED_SHELL = "1";
    try {
      expect(sandboxCapability().available).toBe(false);
      expect(sandboxCapability().detail).toContain("unconfined");
    } finally {
      delete process.env.MOCODE_ALLOW_UNCONFINED_SHELL;
      resetSandboxCapability();
    }
  });

  test("the answer is stable for the process lifetime", () => {
    resetSandboxCapability();
    const first = sandboxCapability();
    const second = sandboxCapability();
    expect(second).toBe(first);
    resetSandboxCapability();
  });
});

describe("capability vs enforcement", () => {
  test("a successful probe now reports enforcement, because the spawn site wraps it", () => {
    const capability = probeSeatbelt(applies);
    expect(capability.available).toBe(true);
    expect(capability.enforced).toBe(true);
  });

  test("a failed probe reports neither", () => {
    const capability = probeSeatbelt(refuses);
    expect(capability.available).toBe(false);
    expect(capability.enforced).toBe(false);
  });

  test("isShellConfined mirrors the live probe on this host", async () => {
    const { detectSandbox, isShellConfined } = await import("./sandbox-capability");
    resetSandboxCapability();
    const capability = detectSandbox();
    expect(isShellConfined()).toBe(capability.available && capability.enforced);
  });

  test("sandboxBackend mirrors the live probe on this host", async () => {
    const { detectSandbox, sandboxBackend } = await import("./sandbox-capability");
    resetSandboxCapability();
    const capability = detectSandbox();
    expect(sandboxBackend()).toBe(
      capability.available && capability.enforced ? capability.backend : "none",
    );
  });

  test("MOCODE_DISABLE_SANDBOX forces none", async () => {
    const { sandboxBackend } = await import("./sandbox-capability");
    process.env.MOCODE_DISABLE_SANDBOX = "1";
    try {
      expect(sandboxBackend()).toBe("none");
    } finally {
      delete process.env.MOCODE_DISABLE_SANDBOX;
      resetSandboxCapability();
    }
  });
});
