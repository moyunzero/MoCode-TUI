/**
 * Path containment for agent tools.
 *
 * The previous check was purely lexical: `resolve()` then reject anything starting
 * with `..`. That stops `../../etc/passwd` but not a symlink, because the symlink
 * itself lives inside the project while pointing outside it:
 *
 *   ln -s /etc ./docs
 *   readFile("docs/passwd")     ← lexically inside, actually /etc/passwd
 *
 * This module checks both: the lexical path *and* the real path of the deepest
 * existing ancestor (so it works for files that do not exist yet, e.g. writeFile
 * creating a new directory tree).
 */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function outsideError(): Error {
  return new Error("Path is outside the project directory");
}

/** Throw unless `candidate` is `root` or lives beneath it. */
function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === "") return;
  // Reject only the parent segment itself (`..`) or a parent walk (`../…`).
  // Filenames that merely begin with two dots (e.g. `..config`) are contained.
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw outsideError();
}

/** Real path, or the input when the file does not exist. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Real path of the deepest ancestor that exists. Resolving the ancestor (rather
 * than the leaf) keeps this usable for paths that are about to be created.
 */
function realAncestor(path: string): string {
  let current = path;

  while (true) {
    try {
      return realpathSync(current);
    } catch {
      // A dangling symlink is NOT a "missing component". Walking past it would
      // resolve the parent (inside cwd) and accept a path that actually writes
      // through the link to a target outside the project.
      if (isDanglingSymlink(current)) throw outsideError();

      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** True when `path` exists as a symlink whose target cannot be resolved. */
function isDanglingSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Resolve `target` under `cwd`, rejecting both lexical escapes and symlink escapes.
 *
 * @throws when the path leaves the project directory by either route.
 */
export function resolveInsideCwd(cwd: string, target: string): string {
  const resolved = resolve(cwd, target);
  assertInside(cwd, resolved);

  // Symlink check: compare real paths so `docs -> /etc` is caught.
  assertInside(realpathOrSelf(cwd), realAncestor(resolved));

  return resolved;
}
