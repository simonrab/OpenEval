import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "../src/client.js";
import { main, type Io } from "../src/cli.js";

export const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "harness.mjs");
export const OPT_KEY = "oeo_test_optimizer_key_value";
export const FULL_KEY = "full-test-key-value";

export type Call = { tool: string; path: string; auth: string | null; body: Record<string, unknown> };
export type Handler = (body: Record<string, unknown>, call: Call) => { status?: number; body: unknown };

/** An in-memory OpenEval. Each tool name maps to a handler. */
export function fakeOpenEval(handlers: Record<string, Handler>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    const tool = url.pathname.replace(/^\/v1\/tools\//, "");
    const call: Call = { tool, path: url.pathname, auth: headers.authorization ?? null, body };
    calls.push(call);
    const h = handlers[tool];
    if (!h) {
      return new Response(JSON.stringify({ code: "UNKNOWN_TOOL", message: `no handler for ${tool}` }), {
        status: 404,
      });
    }
    const res = h(body, call);
    return new Response(JSON.stringify(res.body), { status: res.status ?? 200 });
  };
  return { fetch: fetchFn, calls };
}

export function tempDir(prefix = "openeval-tune-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export type CliResult = { code: number; stdout: string; stderr: string; json: any };

export async function runCli(
  args: string[],
  opts: { env?: Record<string, string>; fetch?: FetchLike; cwd: string },
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    fetch: opts.fetch,
    cwd: opts.cwd,
  };
  const env = {
    OPENEVAL_URL: "http://openeval.test",
    OPENEVAL_KEY: OPT_KEY,
    OPENEVAL_PROJECT_ID: "prj_1",
    OPENEVAL_EVAL_SET_ID: "ste_1",
    OPENEVAL_KEYS_REF: "key_1",
    OPENEVAL_TUNE_POLL_MS: "1",
    ...opts.env,
  };
  const code = await main(args, env, io);
  let json: unknown = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { code, stdout, stderr, json };
}

export function verdictBody(
  verdict: string,
  extra: Partial<{ plateau: boolean; underpowered: boolean; rounds: number; flat_rounds: number }> = {},
): Record<string, unknown> {
  const split = {
    n_evals: 7,
    baseline_pass_rate: 0.5,
    candidate_pass_rate: 0.6,
    delta: 0.1,
    ci95: [0.05, 0.15],
    noise_floor: 0.05,
    n_regressed: 0,
    n_flaky: { baseline: 0, candidate: 0 },
    n_error: { baseline: 0, candidate: 0 },
  };
  return {
    verdict,
    reason: `reason for ${verdict}`,
    objective: "quality",
    directional: false,
    underpowered: extra.underpowered ?? false,
    advice: null,
    eval_set_id: "ste_1",
    n_shared_evals: 10,
    train: split,
    holdout: { ...split, n_evals: 3 },
    cost_per_call_usd: { baseline: 0.01, candidate: 0.01, delta: 0 },
    p50_latency_ms: { baseline: 100, candidate: 90, delta: -10 },
    session_id: "s",
    rounds: extra.rounds ?? 1,
    flat_rounds: extra.flat_rounds ?? 0,
    plateau: extra.plateau ?? false,
    next_action: { tool: null, args: {}, ask_human: null },
  };
}

export function reportBody(runId: string, cost = 0.01): Record<string, unknown> {
  return {
    status: "succeeded",
    code: null,
    summary: { run_id: runId, cost_usd: cost, n_pass: 5, n_fail: 5 },
  };
}
