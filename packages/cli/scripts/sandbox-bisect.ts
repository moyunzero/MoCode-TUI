/**
 * Sandbox profile bisect.
 *
 * `SIGABRT` from `sandbox-exec` gives no stderr, so guessing which rule is
 * malformed is pointless. This walks from the smallest profile to the full
 * generated one, adding one operation at a time, and reports the first case that
 * aborts — which names the offending rule.
 *
 *   bun run packages/cli/scripts/sandbox-bisect.ts
 */
import { buildSeatbeltProfile, parsePathList, runtimePaths } from "../src/lib/sandbox-profile";

const cwd = process.cwd();
const options = {
  cwd,
  home: process.env.HOME,
  tmpDir: process.env.TMPDIR,
  runtimePaths: runtimePaths(),
  extraReadPaths: parsePathList(process.env.MOCODE_SANDBOX_EXTRA_READ),
  extraWritePaths: parsePathList(process.env.MOCODE_SANDBOX_EXTRA_WRITE),
};

const full = buildSeatbeltProfile(options);

/** Each case adds exactly one rule to the previous one. */
const cases: Array<{ name: string; profile: string }> = [
  { name: "1  (allow default) 基线", profile: "(version 1)(allow default)" },
  ...(() => {
    const rules = [
      "(deny default)",
      "(allow file-read*)",
      "(allow process*)",
      "(allow signal)",
      "(allow sysctl-read)",
      "(allow mach-lookup)",
      "(allow file-read-metadata)",
      "(allow file-map-executable)",
      "(allow network*)",
    ];

    return rules.map((rule, index) => ({
      name: `2.${index + 1} + ${rule}`,
      profile: `(version 1)\n${rules.slice(0, index + 1).join("\n")}`,
    }));
  })(),
  { name: "3  完整生成的 profile（-p）", profile: full },
];

function run(name: string, profile: string) {
  const result = Bun.spawnSync(["/usr/bin/sandbox-exec", "-p", profile, "/bin/echo", "ok"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exit = result.exitCode;
  const signal = result.signalCode;
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();

  const verdict = exit === 0 && stdout === "ok" ? "OK " : "FAIL";
  console.log(`${verdict} ${name.padEnd(34)} exit=${exit} signal=${signal ?? "-"}`);

  if (verdict === "FAIL") {
    if (stderr) console.log(`      stderr: ${stderr.slice(0, 300)}`);
    if (stdout) console.log(`      stdout: ${JSON.stringify(stdout.slice(0, 120))}`);
  }

  return verdict === "OK ";
}

console.log(`cwd: ${cwd}`);
console.log(`TMPDIR: ${process.env.TMPDIR ?? "(unset)"}\n`);

let lastOk = "";
let firstFail = "";

for (const testCase of cases) {
  const ok = run(testCase.name, testCase.profile);
  if (ok) lastOk = testCase.name;
  else if (!firstFail) firstFail = testCase.name;
}

// File mode prints parse errors that -p swallows.
console.log("\n--- 完整 profile 用 -f（文件模式会打印语法错误）---");
const profilePath = `${process.env.TMPDIR ?? "/tmp"}/mocode-bisect.sb`;
await Bun.write(profilePath, full);
const fileRun = Bun.spawnSync(["/usr/bin/sandbox-exec", "-f", profilePath, "/bin/echo", "ok"], {
  stdout: "pipe",
  stderr: "pipe",
});
console.log(
  `     -f 结果: exit=${fileRun.exitCode} signal=${fileRun.signalCode ?? "-"} stderr=${JSON.stringify(
    fileRun.stderr.toString().trim().slice(0, 300),
  )}`,
);

console.log(`\n=== 结论 ===`);
console.log(`最后一条通过的规则组合: ${lastOk || "(无)"}`);
console.log(`第一条失败的: ${firstFail || "(无)"}`);
console.log(`
判读：
- 卡在 2.x 的某一步 → 那一步的规则名就是元凶，删掉或换写法。
- 1 就失败       → 这台机器的 sandbox-exec 对文字 profile 有问题，只认 -f 文件。
- 3 失败而 2.x 全过 → 差值就是完整 profile 里的路径规则（subpath 列表）。
`);
