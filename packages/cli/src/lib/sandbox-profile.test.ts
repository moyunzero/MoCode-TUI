import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  parsePathList,
  runtimePaths,
  spawnPlan,
} from "./sandbox-profile";

const base = { cwd: "/Users/dev/project", home: "/Users/dev", tmpDir: "/tmp" };

describe("seatbelt profile", () => {
  const profile = buildSeatbeltProfile(base);

  test("denies by default — that is the whole guarantee", () => {
    expect(profile).toContain("(version 1)");
    expect(profile.split("\n")[1]).toBe("(deny default)");
  });

  test("allows the project tree", () => {
    expect(profile).toContain('(subpath "/Users/dev/project")');
  });

  test("allows broad reads under / (required on modern macOS) then denies secrets", () => {
    // Narrow subpath allowlists SIGABRT on dyld/cryptex hosts; deny comes after.
    expect(profile).toContain('(allow file-read* (subpath "/"))');
    expect(profile).toContain('(subpath "/etc/passwd")');
    expect(profile).toContain('(subpath "/Users/dev/.ssh")');
    const denyLine = profile.split("\n").find((line) => line.startsWith("(deny file-read*"));
    expect(denyLine).toBeDefined();
  });

  test("keeps the writable set tight", () => {
    const writeLine = profile.split("\n").find((line) => line.startsWith("(allow file-write*"));
    expect(writeLine).toContain('(subpath "/Users/dev/project")');
    expect(writeLine).not.toContain('(subpath "/Users/dev")');
  });

  test("escapes quotes so a hostile directory name cannot break the profile", () => {
    const tricky = buildSeatbeltProfile({ cwd: '/tmp/we"ird\\(dir)' });
    expect(tricky).toContain('/tmp/we\\"ird\\\\(dir)');
  });

  test("lists the project once in the write allow", () => {
    const duplicated = buildSeatbeltProfile({
      ...base,
      extraWritePaths: ["/Users/dev/project", "/tmp/extra"],
    });
    const occurrences = duplicated.split('(subpath "/Users/dev/project")').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("bwrap args", () => {
  // bwrap refuses to start when a bind target is missing, so masks are only emitted
  // for paths that exist. Build a throwaway home that has them.
  const fakeHome = mkdtempSync(join(tmpdir(), "mocode-bwrap-home-"));
  mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
  writeFileSync(join(fakeHome, ".npmrc"), "//registry/:_authToken=x");

  const args = buildBwrapArgs({ ...base, home: fakeHome });

  test("mounts a read-only root and a writable project", () => {
    expect(args.join(" ")).toContain("--ro-bind / /");
    expect(args.join(" ")).toContain("--bind /Users/dev/project /Users/dev/project");
  });

  test("masks sensitive home paths", () => {
    const joined = args.join(" ");
    // Directories are emptied with a tmpfs; binding a *file* over a directory makes
    // bubblewrap refuse to start.
    expect(joined).not.toContain(`--ro-bind /dev/null ${fakeHome}/.ssh`);
    // Files are bound over /dev/null.
    expect(joined).toContain(`--ro-bind /dev/null ${fakeHome}/.npmrc`);
    // Directories are emptied instead.
    expect(joined).toContain(`--tmpfs ${fakeHome}/.ssh`);
  });

  test("always mounts a private tmpfs for TMPDIR", () => {
    expect(args.join(" ")).toContain("--tmpfs /tmp");
  });

  test("does not share the parent's pid namespace", () => {
    expect(args).not.toContain("--unshare-pid");
  });

  afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));
});


describe("spawnPlan", () => {
  test("seatbelt wraps bash in sandbox-exec", () => {
    const plan = spawnPlan("seatbelt", "echo hi", base);
    expect(plan).toMatchObject({ file: "/usr/bin/sandbox-exec", confined: true, backend: "seatbelt" });
    expect(plan.args.slice(-3)).toEqual(["bash", "-c", "echo hi"]);
    expect(plan.args[0]).toBe("-p");
  });

  test("bwrap prefixes the command", () => {
    const plan = spawnPlan("bwrap", "echo hi", base);
    expect(plan).toMatchObject({ file: "/usr/bin/bwrap", confined: true });
    expect(plan.args.slice(-3)).toEqual(["bash", "-c", "echo hi"]);
  });

  test("none is honest: returns a working shell and says it is unconfined", () => {
    const plan = spawnPlan("none", "echo hi", base);
    expect(plan).toMatchObject({ file: "bash", confined: false, backend: "none" });
    expect(plan.args).toEqual(["-c", "echo hi"]);
  });
});

describe("helpers", () => {
  test("parsePathList splits, trims and drops empties", () => {
    expect(parsePathList("/a:/b : /c::")).toEqual(["/a", "/b", "/c"]);
    expect(parsePathList(undefined)).toEqual([]);
  });

  test("runtimePaths keeps the interpreter directory readable", () => {
    expect(runtimePaths("/Users/dev/.bun/bin/bun")).toEqual(["/Users/dev/.bun/bin"]);
  });
});
