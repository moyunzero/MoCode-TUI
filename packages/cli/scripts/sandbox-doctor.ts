/**
 * Sandbox doctor.
 *
 * `SIGABRT` with empty stderr has two candidates, and they need different fixes:
 * the profile is malformed, or the child environment we hand `sandbox-exec` is too
 * bare. The probes below vary exactly one of those at a time.
 *
 *   bun run packages/cli/scripts/sandbox-doctor.ts
 */
import { buildSandboxEnv } from "../src/lib/permission-rules";
import { sandboxBackend, sandboxCapability } from "../src/lib/sandbox-capability";
import { buildSeatbeltProfile, parsePathList, runtimePaths, spawnPlan } from "../src/lib/sandbox-profile";

const cwd = process.cwd();
const backend = sandboxBackend();

const profileOptions = {
  cwd,
  home: process.env.HOME,
  tmpDir: process.env.TMPDIR,
  runtimePaths: runtimePaths(),
  extraReadPaths: parsePathList(process.env.MOCODE_SANDBOX_EXTRA_READ),
  extraWritePaths: parsePathList(process.env.MOCODE_SANDBOX_EXTRA_WRITE),
};

if (process.argv.includes("--dump-profile")) {
  console.log(buildSeatbeltProfile(profileOptions));
  process.exit(0);
}

console.log("=== capability ===");
console.log(JSON.stringify(sandboxCapability(), null, 2));
console.log(`backend used at spawn: ${backend}`);
console.log(`platform: ${process.platform}`);
console.log(`cwd: ${cwd}`);
console.log(`TMPDIR: ${process.env.TMPDIR ?? "(unset)"}`);

// A canary in the parent process proves the env allowlist drops it.
process.env.MOCODE_DOCTOR_CANARY = "should-not-be-visible";
const sandboxEnv = buildSandboxEnv();

const FULL_PROFILE = buildSeatbeltProfile(profileOptions);
const TRIVIAL_PROFILE = "(version 1)(allow default)";

type Variant = {
  label: string;
  argv: string[];
  env: Record<string, string | undefined>;
  expect: string;
};

function seatbelt(profile: string, command: string): string[] {
  return ["/usr/bin/sandbox-exec", "-p", profile, "bash", "-c", command];
}

/** Linux has no sandbox-exec: build the bubblewrap argv from the real plan. */
function bwrap(command: string): string[] {
  const plan = spawnPlan("bwrap", command, profileOptions);
  return [plan.file, ...plan.args];
}

const isMac = process.platform === "darwin";

const macVariants: Variant[] = [
  {
    label: "1. 极简 profile + 继承 env   （= 能力探测的跑法，已知能过）",
    argv: seatbelt(TRIVIAL_PROFILE, "echo hi"),
    env: process.env,
    expect: "hi",
  },
  {
    label: "2. 极简 profile + 白名单 env （隔离 env 的影响）",
    argv: seatbelt(TRIVIAL_PROFILE, "echo hi"),
    env: sandboxEnv,
    expect: "hi",
  },
  {
    label: "3. 完整 profile + 继承 env   （隔离 profile 的影响）",
    argv: seatbelt(FULL_PROFILE, "echo hi"),
    env: process.env,
    expect: "hi",
  },
  {
    label: "4. 完整 profile + 白名单 env （= 真实 spawn，当前失败）",
    argv: seatbelt(FULL_PROFILE, "echo hi"),
    env: sandboxEnv,
    expect: "hi",
  },
  {
    label: "5. 真实 spawnPlan 路径",
    argv: (() => {
      const plan = spawnPlan(backend, "echo hi", profileOptions);
      return [plan.file, ...plan.args];
    })(),
    env: sandboxEnv,
    expect: "hi",
  },
  {
    label: "6. 完整 profile：读 /etc/passwd 应被拒",
    argv: seatbelt(FULL_PROFILE, "head -1 /etc/passwd"),
    env: process.env,
    expect: "denied (no content)",
  },
  {
    label: "7. 完整 profile：canary 变量应不可见",
    argv: seatbelt(FULL_PROFILE, 'echo -n "${MOCODE_DOCTOR_CANARY:-absent}"'),
    env: sandboxEnv,
    expect: "absent",
  },
];

const linuxVariants: Variant[] = [
  {
    label: "1. 真实 bwrap 计划 + 继承 env",
    argv: bwrap("echo hi"),
    env: process.env,
    expect: "hi",
  },
  {
    label: "2. 真实 bwrap 计划 + 白名单 env",
    argv: bwrap("echo hi"),
    env: sandboxEnv,
    expect: "hi",
  },
  {
    label: "3. 读 /etc/shadow 应被 mask",
    argv: bwrap("head -1 /etc/shadow"),
    env: process.env,
    expect: "denied (no content)",
  },
  {
    label: "4. canary 变量应不可见",
    argv: bwrap('echo -n "${MOCODE_DOCTOR_CANARY:-absent}"'),
    env: sandboxEnv,
    expect: "absent",
  },
];

const variants: Variant[] = isMac ? macVariants : linuxVariants;

for (const variant of variants) {
  const result = Bun.spawnSync(variant.argv, {
    cwd,
    env: variant.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  console.log(`\n### ${variant.label}`);
  console.log(`    expect   : ${variant.expect}`);
  console.log(`    exit     : ${result.exitCode}   signal: ${result.signalCode ?? "-"}`);
  console.log(`    stdout   : ${JSON.stringify(stdout.slice(0, 200))}`);
  console.log(`    stderr   : ${JSON.stringify(stderr.slice(0, 400))}`);
}

console.log(`
=== 怎么读 ===

2 崩了（而 1 正常）  → 是**白名单 env** 的问题。sandbox-exec 需要某个被我们剔除的
                       环境变量；修法是给它一份完整的 env，再单独约束子进程。
3 崩了（而 2 正常）  → 是**profile** 的问题。跑 sandbox-bisect.ts 定位到具体规则。
2 和 3 都正常，4 崩 → 两者相互作用（一般仍是 env：profile 里引用了仅 parent 才有的变量）。
6 有内容             → 沙箱没真正生效，按安全 bug 处理。
7 打印 canary        → env 白名单失效。
`);
