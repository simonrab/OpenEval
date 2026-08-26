import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * Fixture checks run a customer script from their repo.
 * Interface: model output is written to the script's stdin; exit 0 = pass.
 * Set expected.path (relative to root) and optional expected.root or
 * EVALROUTER_FIXTURE_ROOT. Non-zero exit or timeout fails closed.
 * Stdout/stderr are never included in reason_short (may contain secrets).
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export type FixtureExpected = {
  path: string;
  root?: string;
  timeout_ms?: number;
};

function fixtureRoot(spec: FixtureExpected): string {
  if (typeof spec.root === "string" && spec.root.length > 0) {
    return resolve(spec.root);
  }
  const envRoot = process.env.EVALROUTER_FIXTURE_ROOT;
  if (envRoot) {
    return resolve(envRoot);
  }
  return process.cwd();
}

function runFixtureScript(
  scriptPath: string,
  cwd: string,
  output: string,
  timeoutMs: number,
): { ok: true } | { ok: false; reason: string } {
  const isShell = scriptPath.endsWith(".sh");
  const command = isShell ? "bash" : scriptPath;
  const args = isShell ? [scriptPath] : [];

  const result = spawnSync(command, args, {
    cwd,
    input: output,
    timeout: timeoutMs,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
  });

  if (result.error != null) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      return { ok: false, reason: "fixture timeout" };
    }
    return { ok: false, reason: "fixture exec error" };
  }

  if (result.status === 0) {
    return { ok: true };
  }

  const exitCode = result.status ?? "signal";
  return { ok: false, reason: `fixture exit ${exitCode}` };
}

export function scoreFixture(
  output: string,
  expected: unknown,
): { passed: boolean; reason_short: string } {
  const spec = expected as FixtureExpected | null;
  if (spec == null || typeof spec.path !== "string" || spec.path.length === 0) {
    return { passed: false, reason_short: "bad fixture spec" };
  }

  const root = fixtureRoot(spec);
  const scriptPath = resolve(root, spec.path);
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!scriptPath.startsWith(rootWithSep) && scriptPath !== root) {
    return { passed: false, reason_short: "fixture path escapes root" };
  }

  if (!existsSync(scriptPath)) {
    return { passed: false, reason_short: `fixture missing: ${spec.path}` };
  }

  const timeoutMs =
    typeof spec.timeout_ms === "number" && spec.timeout_ms > 0
      ? spec.timeout_ms
      : DEFAULT_TIMEOUT_MS;

  const ran = runFixtureScript(scriptPath, root, output, timeoutMs);
  if (ran.ok) {
    return { passed: true, reason_short: `fixture ${spec.path} pass` };
  }
  return {
    passed: false,
    reason_short: `${spec.path}: ${ran.reason}`,
  };
}
