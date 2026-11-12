/**
 * Task eval cases.
 *
 * Each case is a tiny, self-contained project plus a `check` command that must
 * exit 0 once the task is done. Two properties matter more than the count:
 *
 * 1. **The check must FAIL before the agent touches anything.** A case whose
 *    check already passes measures nothing. `cases.test.ts` enforces this.
 * 2. **The check must be behavioural.** It runs code and asserts on results, not
 *    on the presence of a string in a file — otherwise "rename the variable"
 *    would pass.
 *
 * Cases are deliberately small: a task that needs 40 turns tests the harness as
 * much as the agent, and hides which capability actually failed.
 */

export type EvalCase = {
  id: string;
  /** What kind of work this exercises — used in the report. */
  category: "fix" | "feature" | "refactor" | "test";
  prompt: string;
  /** Starting state written into a temp dir. */
  files: Record<string, string>;
  /** Shell command that must exit 0 when the task is complete. */
  check: string;
  /**
   * Files restored from `files` before the check runs.
   *
   * Defaults to `["verify.ts"]`: a case that passes by rewriting its own verifier
   * measures nothing. Files the agent is *supposed* to edit must not be listed.
   */
  protectedFiles?: string[];
};

const verify = `import assert from "node:assert";`;

export const EVAL_CASES: EvalCase[] = [
  {
    id: "fix-off-by-one",
    category: "fix",
    prompt: "sumTo(5) should return 15 but returns 10. Fix the loop in sum.ts.",
    files: {
      "sum.ts": `export function sumTo(n: number): number {
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += i;
  }
  return total;
}
`,
      "verify.ts": `${verify}
import { sumTo } from "./sum";
assert.equal(sumTo(5), 15);
assert.equal(sumTo(1), 1);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "fix-missing-await",
    category: "fix",
    prompt: "loadUser returns a Promise instead of the user. Find and fix the missing await.",
    files: {
      "db.ts": `export async function fetchUser(): Promise<{ name: string }> {
  return { name: "ada" };
}
`,
      "index.ts": `import { fetchUser } from "./db";

export async function loadUser() {
  const user = fetchUser();
  return user.name;
}
`,
      "verify.ts": `${verify}
import { loadUser } from "./index";
assert.deepEqual(await loadUser(), "ada");
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "implement-stub",
    category: "feature",
    prompt: "parseSize('1.5kb') should return 1536 (bytes). The function is a stub — implement it. Supported units: b, kb, mb.",
    files: {
      "size.ts": `export function parseSize(input: string): number {
  throw new Error("not implemented");
}
`,
      "verify.ts": `${verify}
import { parseSize } from "./size";
assert.equal(parseSize("512b"), 512);
assert.equal(parseSize("1.5kb"), 1536);
assert.equal(parseSize("2mb"), 2097152);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "add-validation",
    category: "feature",
    prompt: "withdraw() must throw 'amount must be positive' when given a negative amount. It currently accepts it.",
    files: {
      "account.ts": `export function withdraw(balance: number, amount: number): number {
  return balance - amount;
}
`,
      "verify.ts": `${verify}
import { withdraw } from "./account";
assert.equal(withdraw(100, 30), 70);
assert.throws(() => withdraw(100, -5), /amount must be positive/);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "fix-json-crash",
    category: "fix",
    prompt: "parseConfig throws on invalid JSON and takes the app down. It should return null instead.",
    files: {
      "config.ts": `export function parseConfig(raw: string): { port: number } | null {
  return JSON.parse(raw);
}
`,
      "verify.ts": `${verify}
import { parseConfig } from "./config";
assert.deepEqual(parseConfig('{"port":3000}'), { port: 3000 });
assert.equal(parseConfig("{not json"), null);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "rename-across-files",
    category: "refactor",
    prompt: "Rename formatDate to formatIsoDate everywhere (definition and all call sites). Behaviour must not change.",
    files: {
      "date.ts": `export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
`,
      "report.ts": `import { formatDate } from "./date";

export function reportTitle(d: Date): string {
  return "Report " + formatDate(d);
}
`,
      "verify.ts": `${verify}
import { formatIsoDate } from "./date";
import { reportTitle } from "./report";
assert.equal(formatIsoDate(new Date("2026-03-04T00:00:00Z")), "2026-03-04");
assert.equal(reportTitle(new Date("2026-03-04T00:00:00Z")), "Report 2026-03-04");
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "dedupe-into-helper",
    category: "refactor",
    prompt: "slug() is duplicated in two files with slightly different behaviour. Extract one shared slug() into slug.ts and make both files use it. Both call sites must keep working.",
    files: {
      "posts.ts": `export function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
`,
      "tags.ts": `export function slug(title: string): string {
  return title.toLowerCase().replace(/ /g, "-");
}
`,
      "verify.ts": `${verify}
import { existsSync, readFileSync } from "node:fs";
import { slug as postSlug } from "./posts";
import { slug as tagSlug } from "./tags";

// Behaviour must not change...
assert.equal(postSlug("Hello World!"), "hello-world");
assert.equal(tagSlug("Hello World"), "hello-world");

// ...and the duplication must actually be gone: an alias re-export leaves two
// implementations behind while still passing the assertions above.
assert.ok(existsSync("slug.ts"), "slug.ts must exist");
for (const file of ["posts.ts", "tags.ts"]) {
  const source = readFileSync(file, "utf8");
  assert.ok(/from\s+["']\.\/slug["']/.test(source), file + " must import the shared slug");
  assert.ok(!/function\s+slug\s*\(/.test(source), file + " must not define its own slug()");
}
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "add-unit-test",
    category: "test",
    prompt: "Add tests for clamp() in clamp.test.ts. Cover the lower bound, the upper bound, and the in-range case. `bun test` must pass.",
    files: {
      "clamp.ts": `export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
`,
      "clamp.test.ts": `import { test, expect } from "bun:test";
`,
      "verify.ts": `${verify}
import { readFileSync, writeFileSync } from "node:fs";

const original = readFileSync("clamp.ts", "utf8");

/** Run the submitted suite and return its exit code. */
function runTests(): number {
  return Bun.spawnSync(["bun", "test", "clamp.test.ts"], { stdout: "pipe", stderr: "pipe" }).exitCode ?? 1;
}

try {
  // 1. The submitted tests must pass against the correct implementation.
  assert.equal(runTests(), 0, "submitted tests must pass against the correct clamp()");

  // 2. They must FAIL when clamp() is broken. Counting \`test(\` occurrences is not
  //    coverage: three empty callbacks pass every check while testing nothing.
  const broken = [
    "export function clamp(value: number, min: number, max: number): number {",
    "  return value; // ignores both bounds",
    "}",
    "",
  ].join("\n");

  writeFileSync("clamp.ts", broken);
  assert.notEqual(runTests(), 0, "submitted tests do not detect a broken clamp()");
} finally {
  writeFileSync("clamp.ts", original);
}

console.log("ok");
`,
    },
    check: "bun test && bun verify.ts",
  },
  {
    id: "fix-async-ordering",
    category: "fix",
    prompt: "collect() returns an empty array because the promises are never awaited. Fix it so the results are collected in order.",
    files: {
      "collect.ts": `export async function collect(items: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const item of items) {
    Promise.resolve(item.toUpperCase()).then((value) => out.push(value));
  }
  // Snapshot taken before the promises settle, so the caller always sees [].
  return [...out];
}
`,
      "verify.ts": `${verify}
import { collect } from "./collect";
assert.deepEqual(await collect(["a", "b", "c"]), ["A", "B", "C"]);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "add-cli-flag",
    category: "feature",
    prompt: "cli.ts should support `--upper` to uppercase its output. Without the flag it must behave exactly as before.",
    files: {
      "cli.ts": `const args = process.argv.slice(2);
const text = args.filter((a) => !a.startsWith("--")).join(" ");
console.log(text);
`,
      "verify.ts": `${verify}
import { spawnSync } from "node:child_process";
const plain = spawnSync("bun", ["cli.ts", "hello"], { encoding: "utf8" });
const upper = spawnSync("bun", ["cli.ts", "--upper", "hello"], { encoding: "utf8" });
assert.equal(plain.stdout.trim(), "hello");
assert.equal(upper.stdout.trim(), "HELLO");
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },

  // -------------------------------------------------------------------------
  // Hard cases. The ten above are single-file with a visible failure message;
  // these add multi-file propagation, behavioural regressions, a performance
  // budget, and a test the agent is forbidden to edit.
  // -------------------------------------------------------------------------
  {
    id: "hard-barrel-rename",
    category: "refactor",
    prompt:
      "Rename `formatMoney` to `formatCurrency` everywhere: its definition, the barrel re-export in index.ts, and both call sites. Behaviour must not change.",
    files: {
      "money.ts": `export function formatMoney(cents: number): string {
  return "$" + (cents / 100).toFixed(2);
}
`,
      "index.ts": `export { formatMoney } from "./money";
`,
      "cart.ts": `import { formatMoney } from "./index";
export const cartLabel = (c: number) => "Cart: " + formatMoney(c);
`,
      "invoice.ts": `import { formatMoney } from "./index";
export const invoiceLabel = (c: number) => "Invoice: " + formatMoney(c);
`,
      "verify.ts": `${verify}
import { formatCurrency } from "./money";
import { cartLabel } from "./cart";
import { invoiceLabel } from "./invoice";
assert.equal(formatCurrency(1234), "$12.34");
assert.equal(cartLabel(500), "Cart: $5.00");
assert.equal(invoiceLabel(99), "Invoice: $0.99");
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "hard-schema-migration",
    category: "refactor",
    prompt:
      "The User type renames `userName` to `displayName`. Update the type, the factory, and both consumers so the program still compiles and prints correctly.",
    files: {
      "types.ts": `export type User = { id: string; userName: string };
`,
      "factory.ts": `import type { User } from "./types";
export function makeUser(id: string): User {
  return { id, userName: "anon-" + id };
}
`,
      "greet.ts": `import type { User } from "./types";
export function greet(user: User): string {
  return "Hello " + user.userName;
}
`,
      "verify.ts": `${verify}
import { readFileSync } from "node:fs";
import { makeUser } from "./factory";
import { greet } from "./greet";

const user = makeUser("7");
assert.equal(greet(user), "Hello anon-7");
assert.equal((user as unknown as { displayName: string }).displayName, "anon-7");

// The migration must remove the old field, not bolt the new one on beside it.
for (const file of ["types.ts", "factory.ts", "greet.ts"]) {
  assert.ok(
    !readFileSync(file, "utf8").includes("userName"),
    file + " still references the obsolete userName field",
  );
}
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "hard-regression-neighbour",
    category: "fix",
    prompt:
      "`average([])` must return 0 instead of NaN. Do not change `sum` or `average`'s behaviour for non-empty input — there is a neighbouring test that must keep passing.",
    files: {
      "stats.ts": `export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function average(values: number[]): number {
  return sum(values) / values.length;
}
`,
      "neighbour.test.ts": `import { test, expect } from "bun:test";
import { sum, average } from "./stats";

test("sum of non-empty", () => expect(sum([1, 2, 3])).toBe(6));
test("average of non-empty", () => expect(average([2, 4])).toBe(3));
`,
      "verify.ts": `${verify}
import { average } from "./stats";
assert.equal(average([]), 0);
assert.equal(average([2, 4]), 3);
console.log("ok");
`,
    },
    check: "bun test neighbour.test.ts && bun verify.ts",
  },
  {
    id: "hard-perf-budget",
    category: "fix",
    prompt:
      "hasDuplicate is O(n^2) and times out on large inputs. Rewrite it so it handles 40,000 items within the budget in verify.ts, without changing its return values.",
    files: {
      "dedupe.ts": `export function hasDuplicate(values: number[]): boolean {
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < values.length; j++) {
      if (i !== j && values[i] === values[j]) return true;
    }
  }
  return false;
}
`,
      "verify.ts": `import assert from "node:assert";
import { hasDuplicate } from "./dedupe";

assert.equal(hasDuplicate([1, 2, 3]), false);
assert.equal(hasDuplicate([1, 2, 1]), true);

const big = Array.from({ length: 50_000 }, (_, i) => i);
const started = Date.now();
const result = hasDuplicate(big);
const elapsed = Date.now() - started;

assert.equal(result, false);
assert.ok(elapsed < 800, "took " + elapsed + "ms, budget 800ms");
console.log("ok in " + elapsed + "ms");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "hard-test-driven",
    category: "test",
    prompt:
      "csv.test.ts currently fails. Make it pass by fixing csv.ts — you may NOT edit the test file; a pristine copy is kept at csv.test.ts.orig and will be compared.",
    files: {
      "csv.ts": `export function parseCsv(line: string): string[] {
  return line.split(",");
}
`,
      "csv.test.ts": `import { test, expect } from "bun:test";
import { parseCsv } from "./csv";

test("trims fields", () => expect(parseCsv("a, b ,c")).toEqual(["a", "b", "c"]));
test("drops empty fields", () => expect(parseCsv("a,,b")).toEqual(["a", "b"]));
test("empty input", () => expect(parseCsv("")).toEqual([]));
`,
      "csv.test.ts.orig": `import { test, expect } from "bun:test";
import { parseCsv } from "./csv";

test("trims fields", () => expect(parseCsv("a, b ,c")).toEqual(["a", "b", "c"]));
test("drops empty fields", () => expect(parseCsv("a,,b")).toEqual(["a", "b"]));
test("empty input", () => expect(parseCsv("")).toEqual([]));
`,
      "verify.ts": `${verify}
import { readFileSync } from "node:fs";
const current = readFileSync("csv.test.ts", "utf8");
const pristine = readFileSync("csv.test.ts.orig", "utf8");
assert.equal(current, pristine, "the test file was modified");
console.log("ok");
`,
    },
    // The test and its pristine copy are restored before scoring, so an agent edit
    // cannot make them agree.
    protectedFiles: ["verify.ts", "csv.test.ts", "csv.test.ts.orig"],
    check: "bun test csv.test.ts && bun verify.ts",
  },
  {
    id: "hard-immutability",
    category: "fix",
    prompt:
      "sortByScore mutates the caller's array, which breaks a caller that reuses it. Return a sorted copy instead; the original array must keep its order.",
    files: {
      "rank.ts": `export function sortByScore(items: { score: number }[]): { score: number }[] {
  return items.sort((a, b) => b.score - a.score);
}
`,
      "verify.ts": `${verify}
import { sortByScore } from "./rank";
const original = [{ score: 1 }, { score: 3 }, { score: 2 }];
const sorted = sortByScore(original);
assert.deepEqual(sorted.map((i) => i.score), [3, 2, 1]);
assert.deepEqual(original.map((i) => i.score), [1, 3, 2], "input was mutated");
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "hard-error-contract",
    category: "feature",
    prompt:
      "fetchPrice must throw an Error whose message is exactly `price unavailable for <symbol>` when the symbol is unknown, and re-throw nothing else. Currently it swallows the failure.",
    files: {
      "price.ts": `const PRICES: Record<string, number> = { BTC: 100, ETH: 50 };

export async function fetchPrice(symbol: string): Promise<number> {
  try {
    return PRICES[symbol] as number;
  } catch {
    return 0;
  }
}
`,
      "verify.ts": `${verify}
import { fetchPrice } from "./price";
assert.equal(await fetchPrice("BTC"), 100);
await assert.rejects(() => fetchPrice("DOGE"), /price unavailable for DOGE/);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "hard-state-cycle",
    category: "fix",
    prompt:
      "nextState cycles STOP -> GO -> SLOW -> STOP. The current implementation returns STOP forever after the first call. Fix the transition table.",
    files: {
      "light.ts": `export type Light = "STOP" | "GO" | "SLOW";

const TRANSITIONS: Record<Light, Light> = {
  STOP: "STOP",
  GO: "STOP",
  SLOW: "STOP",
};

export function nextState(state: Light): Light {
  return TRANSITIONS[state];
}
`,
      "verify.ts": `${verify}
import { nextState } from "./light";
assert.equal(nextState("STOP"), "GO");
assert.equal(nextState("GO"), "SLOW");
assert.equal(nextState("SLOW"), "STOP");
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "hard-multi-constraint",
    category: "feature",
    prompt:
      "normalizeTag must satisfy all four rules: trim whitespace, lowercase, replace spaces with '-', and return null for an empty result. It currently does none of them.",
    files: {
      "tag.ts": `export function normalizeTag(input: string): string | null {
  return input;
}
`,
      "verify.ts": `${verify}
import { normalizeTag } from "./tag";
assert.equal(normalizeTag("  Hello World  "), "hello-world");
assert.equal(normalizeTag("A B C"), "a-b-c");
assert.equal(normalizeTag("   "), null);
assert.equal(normalizeTag(""), null);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
  {
    id: "hard-cascade-bug",
    category: "fix",
    prompt:
      "checkoutTotal returns the wrong number. The expected total is subtotal(prices) + tax(subtotal(prices)) + shipping(subtotal(prices)). Fix checkoutTotal. The three helper functions are correct — do not change them.",
    files: {
      "checkout.ts": `export function subtotal(prices: number[]): number {
  return prices.reduce((a, b) => a + b, 0);
}
export function tax(amount: number): number {
  return Math.round(amount * 0.1);
}
export function shipping(amount: number): number {
  return amount >= 100 ? 0 : 5;
}

export function checkoutTotal(prices: number[]): number {
  const base = subtotal(prices);
  const discounted = base - tax(base);
  return discounted + shipping(base);
}
`,
      "verify.ts": `${verify}
import { checkoutTotal } from "./checkout";
// 120 -> tax 12 -> 132, free shipping (base >= 100)
assert.equal(checkoutTotal([100, 20]), 132);
// 50 -> tax 5 -> 55 + 5 shipping
assert.equal(checkoutTotal([50]), 60);
console.log("ok");
`,
    },
    check: "bun verify.ts",
  },
];
