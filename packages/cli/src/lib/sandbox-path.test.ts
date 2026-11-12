import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInsideCwd } from "./sandbox-path";

const root = mkdtempSync(join(tmpdir(), "mocode-sandbox-"));
const outside = mkdtempSync(join(tmpdir(), "mocode-outside-"));

writeFileSync(join(root, "inside.txt"), "ok");
writeFileSync(join(outside, "secret.txt"), "top secret");
mkdirSync(join(root, "nested"), { recursive: true });

// The escape hatch: a link that lives inside the project but points outside it.
symlinkSync(outside, join(root, "escape"));
// A link to a single outside file.
symlinkSync(join(outside, "secret.txt"), join(root, "escape-file"));
// A link whose target does not exist: walking past it would resolve the parent
// (inside cwd) and accept a path that writes through the link.
symlinkSync(join(outside, "missing-target"), join(root, "dangling"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInsideCwd — lexical escapes", () => {
  test("accepts a plain relative path", () => {
    expect(resolveInsideCwd(root, "inside.txt")).toBe(join(root, "inside.txt"));
  });

  test("accepts the project root itself", () => {
    expect(resolveInsideCwd(root, ".")).toBe(root);
  });

  test("accepts a nested path that does not exist yet (writeFile case)", () => {
    expect(resolveInsideCwd(root, "a/b/c/new.ts")).toBe(join(root, "a/b/c/new.ts"));
  });

  test("rejects parent traversal", () => {
    expect(() => resolveInsideCwd(root, "../../etc/passwd")).toThrow(
      "Path is outside the project directory",
    );
  });

  test("accepts a contained filename that merely begins with two dots", () => {
    writeFileSync(join(root, "..config"), "ok");
    expect(resolveInsideCwd(root, "..config")).toBe(join(root, "..config"));
  });

  test("rejects traversal that lands back inside via a sibling prefix", () => {
    // `..` must not be treated as a prefix of a legitimate directory name.
    expect(() => resolveInsideCwd(root, "../mocode-sandbox-evil/x")).toThrow(
      "Path is outside the project directory",
    );
  });

  test("rejects an absolute path outside the project", () => {
    expect(() => resolveInsideCwd(root, "/etc/passwd")).toThrow(
      "Path is outside the project directory",
    );
  });

  test("does not expand ~ into the home directory", () => {
    // `~` is not special to the tool layer; it must stay a literal name inside cwd.
    expect(resolveInsideCwd(root, "~/.ssh/id_rsa")).toBe(join(root, "~/.ssh/id_rsa"));
  });
});

describe("resolveInsideCwd — symlink escapes", () => {
  test("rejects a directory symlink pointing outside the project", () => {
    expect(() => resolveInsideCwd(root, "escape/secret.txt")).toThrow(
      "Path is outside the project directory",
    );
  });

  test("rejects a file symlink pointing outside the project", () => {
    expect(() => resolveInsideCwd(root, "escape-file")).toThrow(
      "Path is outside the project directory",
    );
  });

  test("rejects a dangling symlink instead of walking past it", () => {
    expect(() => resolveInsideCwd(root, "dangling")).toThrow(
      "Path is outside the project directory",
    );
  });

  test("still accepts a normal nested directory", () => {
    expect(resolveInsideCwd(root, "nested/file.ts")).toBe(join(root, "nested/file.ts"));
  });
});
