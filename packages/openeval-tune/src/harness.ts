import { spawn } from "node:child_process";

/** One call of the app harness. The harness reads this JSON object on stdin. */
export type HarnessItem = {
  eval_id: string;
  input: string;
  system_prompt: string | null;
  rep: number;
};

/** One entry for submit_outputs. It has output or error, never both. */
export type HarnessOutput = {
  eval_id: string;
  rep: number;
  output?: string;
  error?: string;
  time_ms: number;
  cost_usd?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  served_model?: string;
};

export type HarnessOptions = {
  cmd: string;
  concurrency?: number;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Stop new calls when the reported cost gets to this value. */
  costLimitUsd?: number;
  onResult?: (out: HarnessOutput, done: number, total: number) => void;
};

export type HarnessRunResult = {
  outputs: HarnessOutput[];
  cost_usd: number;
  /** True when the cost limit stopped the run before all items ran. */
  stopped: boolean;
};

/** The usage line prefix on stderr. */
export const USAGE_PREFIX = "OPENEVAL_USAGE ";

/** Limits from OpenEval submit_outputs. */
export const MAX_OUTPUT_CHARS = 200_000;
export const MAX_ERROR_CHARS = 2000;

/** Keys that the harness must never see. */
const SECRET_ENV = ["OPENEVAL_KEY", "OPENEVAL_ADMIN_KEY"];

type Usage = Partial<
  Pick<HarnessOutput, "cost_usd" | "prompt_tokens" | "completion_tokens" | "served_model" | "time_ms">
>;

function nonNegative(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function nonNegativeInt(v: unknown): number | undefined {
  const n = nonNegative(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** Read the last OPENEVAL_USAGE line on stderr. Bad lines are ignored. */
export function parseUsage(stderr: string): { usage: Usage; rest: string[] } {
  let usage: Usage = {};
  const rest: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith(USAGE_PREFIX)) {
      if (line.trim().length > 0) rest.push(line);
      continue;
    }
    try {
      const raw = JSON.parse(line.slice(USAGE_PREFIX.length)) as Record<string, unknown>;
      const next: Usage = {};
      const cost = nonNegative(raw.cost_usd);
      if (cost !== undefined) next.cost_usd = cost;
      const pt = nonNegativeInt(raw.prompt_tokens);
      if (pt !== undefined) next.prompt_tokens = pt;
      const ct = nonNegativeInt(raw.completion_tokens);
      if (ct !== undefined) next.completion_tokens = ct;
      const t = nonNegative(raw.time_ms);
      if (t !== undefined) next.time_ms = t;
      if (typeof raw.served_model === "string" && raw.served_model.length > 0) {
        next.served_model = raw.served_model.slice(0, 200);
      }
      usage = next;
    } catch {
      rest.push(line);
    }
  }
  return { usage, rest };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function stripTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function harnessEnv(base: NodeJS.ProcessEnv, item: HarnessItem): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SECRET_ENV) delete env[key];
  env.OPENEVAL_EVAL_ID = item.eval_id;
  env.OPENEVAL_REP = String(item.rep);
  return env;
}

function killTree(pid: number | undefined, fallback: () => void): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    fallback();
  }
}

/** Run the harness command once for one item. */
export function runOne(item: HarnessItem, opts: HarnessOptions): Promise<HarnessOutput> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(opts.cmd, {
      shell: true,
      cwd: opts.cwd,
      env: harnessEnv(opts.env ?? process.env, item),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let tooLong = false;
    let timedOut = false;
    let settled = false;

    const finish = (out: Omit<HarnessOutput, "eval_id" | "rep" | "time_ms"> & { time_ms?: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        eval_id: item.eval_id,
        rep: item.rep,
        ...out,
        time_ms: out.time_ms ?? Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length <= MAX_OUTPUT_CHARS) {
        stdout += chunk;
      }
      if (stdout.length > MAX_OUTPUT_CHARS + 2) tooLong = true;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 1_000_000) stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ error: clip(`The harness did not start: ${err.message}`, MAX_ERROR_CHARS) });
    });
    child.on("close", (code, signal) => {
      const { usage, rest } = parseUsage(stderr);
      const timeMs = usage.time_ms ?? Date.now() - started;
      const usageFields = { ...usage, time_ms: timeMs };
      if (timedOut) {
        finish({ ...usageFields, error: `The harness timed out after ${timeoutMs} ms.` });
        return;
      }
      if (code !== 0) {
        const last = rest.at(-1);
        const why = code === null ? `signal ${String(signal)}` : `exit code ${code}`;
        finish({
          ...usageFields,
          error: clip(`The harness stopped with ${why}.${last ? ` ${last}` : ""}`, MAX_ERROR_CHARS),
        });
        return;
      }
      const output = stripTrailingNewline(stdout);
      if (tooLong || output.length > MAX_OUTPUT_CHARS) {
        finish({
          ...usageFields,
          error: `The output has more than ${MAX_OUTPUT_CHARS} characters.`,
        });
        return;
      }
      finish({ ...usageFields, output });
    });

    child.stdin.on("error", () => {
      // The harness can close stdin early. The close event reports the result.
    });
    child.stdin.end(JSON.stringify(item));
  });
}

/** Run the harness for every item with a small worker pool. Results keep item order. */
export async function runHarness(
  items: HarnessItem[],
  opts: HarnessOptions,
): Promise<HarnessRunResult> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
  const results = new Array<HarnessOutput | undefined>(items.length);
  let next = 0;
  let done = 0;
  let cost = 0;
  let stopped = false;
  const limit = opts.costLimitUsd;

  const work = async () => {
    while (next < items.length) {
      if (limit !== undefined && cost >= limit) {
        stopped = true;
        return;
      }
      const i = next;
      next += 1;
      const out = await runOne(items[i]!, opts);
      cost += out.cost_usd ?? 0;
      results[i] = out;
      done += 1;
      opts.onResult?.(out, done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, work));
  const outputs = results.filter((r): r is HarnessOutput => r !== undefined);
  return { outputs, cost_usd: cost, stopped: stopped || outputs.length < items.length };
}

/** Every input times every rep, in a stable order. */
export function expandItems(
  inputs: Array<{ eval_id: string; input: string }>,
  reps: number,
  systemPrompt: string | null,
): HarnessItem[] {
  const items: HarnessItem[] = [];
  for (const inp of inputs) {
    for (let rep = 0; rep < reps; rep += 1) {
      items.push({ eval_id: inp.eval_id, input: inp.input, system_prompt: systemPrompt, rep });
    }
  }
  return items;
}
