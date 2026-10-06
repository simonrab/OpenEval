import { randomUUID } from "node:crypto";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
  url: string;
  key: string;
  fetch?: FetchLike;
};

/** An error that OpenEval sent back, or a transport error. It never holds the key. */
export class OpenEvalError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, code: string | null, message: string, body: unknown) {
    super(message);
    this.name = "OpenEvalError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

/** True when the key has the optimizer prefix. */
export function isOptimizerKey(key: string): boolean {
  return key.startsWith("oeo_");
}

/**
 * A small client for the OpenEval HTTP tools API:
 * POST {url}/v1/tools/{name} with a bearer key and a JSON body.
 */
export class OpenEvalClient {
  readonly url: string;
  readonly #key: string;
  readonly #fetch: FetchLike;

  constructor(opts: ClientOptions) {
    if (!opts.url) {
      throw new Error("OPENEVAL_URL is missing. Set OPENEVAL_URL or pass --url.");
    }
    if (!opts.key) {
      throw new Error("The OpenEval key is missing.");
    }
    this.url = opts.url.replace(/\/+$/, "");
    this.#key = opts.key;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Do not show the key in logs or in util.inspect output. */
  toJSON(): Record<string, string> {
    return { url: this.url };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `OpenEvalClient(${this.url})`;
  }

  async post<T = Record<string, unknown>>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.url}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new OpenEvalError(0, null, `Cannot connect to OpenEval at ${this.url}: ${why}`, null);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
      const code = typeof obj.code === "string" ? obj.code : null;
      const message =
        typeof obj.message === "string"
          ? obj.message
          : `OpenEval sent status ${res.status}.`;
      throw new OpenEvalError(res.status, code, message, parsed);
    }
    return parsed as T;
  }

  /** Call one tool. */
  tool<T = Record<string, unknown>>(name: string, body: Record<string, unknown>): Promise<T> {
    return this.post<T>(`/v1/tools/${name}`, body);
  }
}

// Tool shapes that openeval-tune reads. Only the fields in use are typed.

export type EvalInput = { eval_id: string; input: string };

export type EvalInputsPage = {
  eval_set_id: string;
  eval_set_version: number;
  system_prompt: string | null;
  n_evals: number;
  inputs: EvalInput[];
  next_cursor: string | null;
};

export type SubmitOutputsResult = {
  run_id: string;
  candidate_id: string;
  eval_set_id: string;
  n_scored: number;
  n_error: number;
  n_not_scored: number;
  n_person_evals_not_graded: number;
  grader_advice: string | null;
};

export type RunEvalsResult = { run_id: string; status: string; est_cost_usd: number };

export type EvalReport = {
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  code: string | null;
  summary: { run_id: string; cost_usd: number; n_pass: number; n_fail: number };
};

export type SplitComparison = {
  n_evals: number;
  baseline_pass_rate: number;
  candidate_pass_rate: number;
  delta: number;
  ci95: [number, number];
  noise_floor: number;
  n_regressed: number;
};

export type VerdictName =
  | "keep"
  | "revert_overfit"
  | "revert_regressed"
  | "within_noise"
  | "not_comparable";

export type VerdictResult = {
  verdict: VerdictName;
  reason: string;
  objective: "quality" | "cost";
  directional: boolean;
  underpowered: boolean;
  advice: string | null;
  train: SplitComparison;
  holdout: SplitComparison;
  cost_per_call_usd: { baseline: number; candidate: number; delta: number };
  p50_latency_ms: { baseline: number; candidate: number; delta: number };
  session_id: string | null;
  rounds: number | null;
  flat_rounds: number | null;
  plateau: boolean;
};

export type TrainingFailuresPage = {
  run_id: string;
  candidate_id: string;
  directional: boolean;
  train: Record<string, number>;
  holdout: Record<string, number>;
  failures: Array<{
    eval_id: string;
    title: string;
    input: string;
    archetype_id: string | null;
    scorer_primitive: string | null;
    flaky: boolean;
    reps: Array<{ rep: number; passed: boolean; reason_short: string; output: string | null }>;
  }>;
  next_cursor: string | null;
};
