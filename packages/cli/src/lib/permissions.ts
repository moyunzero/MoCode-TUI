/**
 * User-writable permission rules.
 *
 * The previous model was a hardcoded blocklist plus an in-session allow set: a user
 * could approve something for an hour, never for a project, and could not deny
 * anything the blocklist did not already know about.
 *
 * Rules live in JSON so the policy is reviewable, diffable and shareable:
 *
 *   ~/.mocode/permissions.json      user rules, apply to every project
 *   <project>/.mocode/permissions.json   project rules, committed with the repo
 *
 * Precedence is **deny > allow > ask**, matching how a safety rule should behave:
 * a deny anywhere wins over an allow everywhere. Within one behaviour the first
 * matching rule wins, so the file reads top-down.
 *
 * Pure: no I/O in the evaluator, so the precedence table is testable on its own.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionRule = {
  /** Exact tool name, or `*` for every tool. */
  tool: string;
  /** Optional JavaScript regex tested against the tool's subject. */
  pattern?: string;
  behavior: PermissionBehavior;
};

export type RuleSource = "user" | "project";

export type LoadedRule = PermissionRule & {
  source: RuleSource;
  /** Compiled pattern, or null when the rule matches on tool name alone. */
  regex: RegExp | null;
};

export type RuleLoadResult = {
  rules: LoadedRule[];
  /** Human-readable problems. A bad rule is dropped, never guessed at. */
  errors: string[];
};

const BEHAVIORS: ReadonlySet<string> = new Set(["allow", "deny", "ask"]);

/**
 * Validate raw parsed JSON.
 *
 * A malformed rule is dropped rather than coerced: silently turning
 * `{"behavior": "denied"}` into an allow would be the worst possible failure.
 */
export function parseRules(raw: unknown, source: RuleSource): RuleLoadResult {
  const errors: string[] = [];
  const rules: LoadedRule[] = [];

  const list = (raw as { rules?: unknown })?.rules;

  // An absent `rules` key is an empty policy; a present but wrong-typed one is a
  // mistake worth reporting.
  if (list === undefined) return { rules, errors };

  if (!Array.isArray(list)) {
    errors.push("`rules` must be an array");
    return { rules, errors };
  }

  list.forEach((entry, index) => {
    const where = `rules[${index}]`;
    if (entry === null || typeof entry !== "object") {
      errors.push(`${where}: not an object`);
      return;
    }

    const { tool, pattern, behavior } = entry as Record<string, unknown>;

    if (typeof tool !== "string" || tool.length === 0) {
      errors.push(`${where}: missing "tool"`);
      return;
    }

    if (typeof behavior !== "string" || !BEHAVIORS.has(behavior)) {
      errors.push(`${where}: "behavior" must be allow, deny or ask`);
      return;
    }

    if (pattern !== undefined && typeof pattern !== "string") {
      errors.push(`${where}: "pattern" must be a string`);
      return;
    }

    let regex: RegExp | null = null;
    if (typeof pattern === "string") {
      try {
        regex = new RegExp(pattern);
      } catch {
        errors.push(`${where}: invalid regex ${JSON.stringify(pattern)}`);
        return;
      }
    }

    rules.push({ tool, pattern, behavior: behavior as PermissionBehavior, source, regex });
  });

  return { rules, errors };
}

/** Read one rule file. A missing file is normal; a malformed one is reported. */
export function loadRuleFile(path: string, source: RuleSource): RuleLoadResult {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { rules: [], errors: [] };
  }

  try {
    return parseRules(JSON.parse(text), source);
  } catch {
    return { rules: [], errors: [`${path}: invalid JSON`] };
  }
}

export const USER_RULES_PATH = () => join(homedir(), ".mocode", "permissions.json");
export const PROJECT_RULES_PATH = (cwd: string) => join(cwd, ".mocode", "permissions.json");

/**
 * Load user rules then project rules.
 *
 * Order only decides *within* a behaviour; deny always beats allow regardless of
 * which file it came from.
 */
export function loadPermissionRules(
  cwd: string = process.cwd(),
  paths: { user?: string; project?: string } = {},
): RuleLoadResult {
  const user = loadRuleFile(paths.user ?? USER_RULES_PATH(), "user");
  const project = loadRuleFile(paths.project ?? PROJECT_RULES_PATH(cwd), "project");

  return {
    rules: [...user.rules, ...project.rules],
    errors: [...user.errors, ...project.errors],
  };
}

export type RuleMatch = {
  behavior: PermissionBehavior;
  rule: LoadedRule;
};

/**
 * Evaluate rules for one tool call.
 *
 * Returns `null` when nothing matches, which the caller treats as "fall back to the
 * built-in policy". Deny is scanned first across **all** rules, then allow, then ask.
 */
export function evaluateRules(
  rules: readonly LoadedRule[],
  tool: string,
  subject: string,
): RuleMatch | null {
  const matches = (rule: LoadedRule): boolean => {
    if (rule.tool !== "*" && rule.tool !== tool) return false;
    return rule.regex === null || rule.regex.test(subject);
  };

  for (const behavior of ["deny", "allow", "ask"] as const) {
    const rule = rules.find((candidate) => candidate.behavior === behavior && matches(candidate));
    if (rule) return { behavior, rule };
  }

  return null;
}

/** The string a rule's pattern is tested against. */
export function ruleSubject(tool: string, input: unknown): string {
  if (input === null || typeof input !== "object") return "";

  const record = input as Record<string, unknown>;
  if (tool === "bash" && typeof record.command === "string") return record.command;
  if (typeof record.path === "string") return record.path;

  return "";
}

export type RuleVerdict = {
  behavior: PermissionBehavior;
  detail: string;
};

/**
 * Load the rule files and evaluate one call.
 *
 * Loaded per call on purpose: a rule edited in the project file takes effect on the
 * very next tool call, which is what makes the policy demoable without a restart.
 * Two small JSON reads per tool call is noise next to the model request.
 */
export function checkRules(
  params: { tool: string; input: unknown },
  cwd: string = process.cwd(),
): RuleVerdict | null {
  const { rules } = loadPermissionRules(cwd);
  if (rules.length === 0) return null;

  const match = evaluateRules(rules, params.tool, ruleSubject(params.tool, params.input));
  if (!match) return null;

  const origin = `${match.rule.source} rule`;
  const pattern = match.rule.pattern ? ` /${match.rule.pattern}/` : "";

  return {
    behavior: match.behavior,
    detail: `${match.behavior === "allow" ? "Allowed" : match.behavior === "deny" ? "Denied" : "Approval required"} by ${origin} (${match.rule.tool}${pattern})`,
  };
}
