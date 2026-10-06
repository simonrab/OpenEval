import {
  newIdempotencyKey,
  type EvalInput,
  type EvalInputsPage,
  type EvalReport,
  type OpenEvalClient,
  type RunEvalsResult,
  type SubmitOutputsResult,
} from "./client.js";
import { expandItems, runHarness, type HarnessOutput } from "./harness.js";
import {
  budgetSpent,
  remainingBudget,
  saveState,
  type DirectSetup,
  type Mode,
  type RunRecord,
  type TuneState,
} from "./state.js";

/** Limits of OpenEval submit_outputs. */
export const MAX_SUBMIT_OUTPUTS = 2000;
export const MAX_SUBMIT_BYTES = 16 * 1024 * 1024;

const LABEL_RE = /^[A-Za-z0-9._-]+$/;

/** A stop that is not an error: the budget or the round limit. */
export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

/** A wrong use of the tool. The message tells the user what to do. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type Log = (line: string) => void;

export type OpsContext = {
  client: OpenEvalClient;
  state: TuneState;
  stateDir: string;
  keysRef: string | null;
  pollMs: number;
  pollTimeoutMs: number;
  log: Log;
};

export function checkLabel(label: string): string {
  if (!LABEL_RE.test(label) || label.length > 64) {
    throw new UsageError(
      `The label "${label}" is not valid. Use letters, digits, dot, underscore, or dash. Use 64 characters or fewer.`,
    );
  }
  return label;
}

/** Read every input of the eval set, page by page. */
export async function fetchAllInputs(
  client: OpenEvalClient,
  projectId: string,
  evalSetId: string,
  pageSize = 200,
): Promise<{ system_prompt: string | null; inputs: EvalInput[]; n_evals: number }> {
  const inputs: EvalInput[] = [];
  let cursor: string | null = null;
  let systemPrompt: string | null = null;
  let nEvals = 0;
  for (let page = 0; page < 10_000; page += 1) {
    const body: Record<string, unknown> = {
      project_id: projectId,
      eval_set_id: evalSetId,
      limit: pageSize,
    };
    if (cursor) body.cursor = cursor;
    const res: EvalInputsPage = await client.tool<EvalInputsPage>("get_eval_inputs", body);
    if (page === 0) {
      systemPrompt = res.system_prompt;
      nEvals = res.n_evals;
    }
    inputs.push(...res.inputs);
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return { system_prompt: systemPrompt, inputs, n_evals: nEvals };
}

const DONE = new Set(["succeeded", "partial", "failed"]);

/** Ask for the run report until the run is done. */
export async function pollReport(
  client: OpenEvalClient,
  projectId: string,
  runId: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<EvalReport> {
  const start = Date.now();
  for (;;) {
    const report = await client.tool<EvalReport>("get_eval_report", {
      project_id: projectId,
      run_id: runId,
    });
    if (DONE.has(report.status)) {
      return report;
    }
    if (Date.now() - start > opts.timeoutMs) {
      throw new Error(
        `The run ${runId} is not done after ${opts.timeoutMs} ms. Run "openeval-tune status" later, or raise --poll-timeout-ms.`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
}

/** Stop before a new run when the budget is spent. */
export function assertBudget(state: TuneState): void {
  if (budgetSpent(state)) {
    throw new LimitError(
      `The budget is spent: ${state.spend_usd.toFixed(4)} USD of ${state.budget_usd} USD. Stop the loop.`,
    );
  }
}

/** A round candidate must use the same mode and reps as the baseline. */
export function assertSameShape(state: TuneState, mode: Mode, reps: number, isBaseline: boolean): void {
  if (isBaseline) return;
  if (!state.baseline) {
    throw new UsageError('There is no baseline. Run "openeval-tune baseline" first.');
  }
  if (state.mode !== mode) {
    throw new UsageError(
      `The baseline uses ${state.mode} mode. Score the candidate in ${state.mode} mode, or make a new baseline.`,
    );
  }
  if (state.reps !== reps) {
    throw new UsageError(
      `The baseline uses ${state.reps} reps. Score the candidate with ${state.reps} reps, or make a new baseline with --reps ${reps}.`,
    );
  }
}

function addRun(ctx: OpsContext, record: RunRecord, isBaseline: boolean): void {
  const { state } = ctx;
  state.runs.push(record);
  state.spend_usd = Math.round((state.spend_usd + record.cost_usd) * 1e8) / 1e8;
  if (isBaseline) {
    const ref = { run_id: record.run_id, candidate_id: record.candidate_id };
    state.mode = record.mode;
    state.reps = record.reps;
    state.baseline = ref;
    if (!state.original_baseline) state.original_baseline = ref;
  }
  saveState(ctx.stateDir, state);
}

export type HarnessRunOptions = {
  cmd: string;
  label: string;
  reps: number;
  concurrency: number;
  timeoutMs: number;
  commit?: string;
  description?: string;
  maxSpendUsd: number;
  isBaseline: boolean;
  cwd?: string;
};

/** Run the app harness over every input and rep, then submit the outputs. */
export async function scoreHarness(ctx: OpsContext, opts: HarnessRunOptions): Promise<RunRecord> {
  const { client, state } = ctx;
  assertBudget(state);
  assertSameShape(state, "harness", opts.reps, opts.isBaseline);
  const label = checkLabel(opts.label);
  const candidateId = `harness#${label}`;

  const all = await fetchAllInputs(client, state.project_id, state.eval_set_id);
  if (all.inputs.length === 0) {
    throw new UsageError("The eval set has no trusted evals to run. Ask a person to mark evals.");
  }
  const items = expandItems(all.inputs, opts.reps, all.system_prompt);
  if (items.length > MAX_SUBMIT_OUTPUTS) {
    throw new UsageError(
      `${all.inputs.length} inputs times ${opts.reps} reps is ${items.length} outputs. OpenEval takes ${MAX_SUBMIT_OUTPUTS} or fewer in one run. Use fewer reps.`,
    );
  }
  ctx.log(`Running the harness: ${all.inputs.length} inputs, ${opts.reps} reps, ${items.length} calls.`);
  const costLimit = remainingBudget(state);
  const run = await runHarness(items, {
    cmd: opts.cmd,
    concurrency: opts.concurrency,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
    costLimitUsd: costLimit,
    onResult: (out, done, total) => {
      if (out.error) ctx.log(`[${done}/${total}] ${out.eval_id} rep ${out.rep}: error: ${out.error}`);
      else if (done % 25 === 0 || done === total) ctx.log(`[${done}/${total}] done`);
    },
  });
  if (run.stopped) {
    state.spend_usd = Math.round((state.spend_usd + run.cost_usd) * 1e8) / 1e8;
    saveState(ctx.stateDir, state);
    throw new LimitError(
      `The harness cost got to the budget after ${run.outputs.length} of ${items.length} calls. Nothing was submitted. Stop the loop.`,
    );
  }

  const nErrors = run.outputs.filter((o) => o.error !== undefined).length;
  if (nErrors > 0) {
    ctx.log(`${nErrors} of ${items.length} harness calls failed. OpenEval counts them as errors.`);
  }
  const outputs = run.outputs.map(toSubmitEntry);
  const body: Record<string, unknown> = {
    project_id: state.project_id,
    eval_set_id: state.eval_set_id,
    candidate: {
      id: candidateId,
      label,
      ...(opts.description ? { description: opts.description.slice(0, 1000) } : {}),
      ...(opts.commit ? { commit: opts.commit.slice(0, 128) } : {}),
    },
    outputs,
    idempotency_key: newIdempotencyKey(),
  };
  const judgeCap = Math.min(opts.maxSpendUsd, remainingBudget(state) - run.cost_usd);
  if (ctx.keysRef && judgeCap > 0) {
    body.keys_ref = ctx.keysRef;
    body.max_eval_spend_usd = Math.round(judgeCap * 1e6) / 1e6;
  }
  const bytes = Buffer.byteLength(JSON.stringify(body));
  if (bytes > MAX_SUBMIT_BYTES) {
    throw new UsageError(
      `The outputs are ${bytes} bytes. OpenEval takes 16 MB or less in one call. Make the outputs shorter or use fewer reps.`,
    );
  }
  const submitted = await client.tool<SubmitOutputsResult>("submit_outputs", body);
  if (submitted.n_not_scored > 0) {
    ctx.log(`${submitted.n_not_scored} evals got no output. The verdict can be not_comparable.`);
  }
  if (submitted.grader_advice) ctx.log(`Grader advice: ${submitted.grader_advice}`);

  // The report has the run spend: caller cost plus any judge cost.
  const report = await pollReport(client, state.project_id, submitted.run_id, {
    intervalMs: ctx.pollMs,
    timeoutMs: ctx.pollTimeoutMs,
  });
  const record: RunRecord = {
    run_id: submitted.run_id,
    candidate_id: submitted.candidate_id,
    mode: "harness",
    label,
    reps: opts.reps,
    cost_usd: Math.max(report.summary?.cost_usd ?? 0, run.cost_usd),
    created_at: new Date().toISOString(),
    ...(opts.commit ? { commit: opts.commit } : {}),
  };
  addRun(ctx, record, opts.isBaseline);
  return record;
}

export function toSubmitEntry(out: HarnessOutput): Record<string, unknown> {
  const entry: Record<string, unknown> = { eval_id: out.eval_id, rep: out.rep };
  if (out.error !== undefined) entry.error = out.error;
  else entry.output = out.output ?? "";
  entry.time_ms = Math.round(out.time_ms);
  if (out.cost_usd !== undefined) entry.cost_usd = out.cost_usd;
  if (out.prompt_tokens !== undefined) entry.prompt_tokens = out.prompt_tokens;
  if (out.completion_tokens !== undefined) entry.completion_tokens = out.completion_tokens;
  if (out.served_model !== undefined) entry.served_model = out.served_model;
  return entry;
}

export type DirectRunOptions = {
  setup: DirectSetup;
  reps: number;
  maxSpendUsd: number;
  isBaseline: boolean;
  label: string | null;
};

/** Score one direct setup with run_evals, then wait for the run. */
export async function scoreDirect(ctx: OpsContext, opts: DirectRunOptions): Promise<RunRecord> {
  const { client, state } = ctx;
  assertBudget(state);
  assertSameShape(state, "direct", opts.reps, opts.isBaseline);
  if (!ctx.keysRef) {
    throw new UsageError("Direct mode needs a keys_ref. Set OPENEVAL_KEYS_REF or pass --keys-ref.");
  }
  const cap = Math.min(opts.maxSpendUsd, remainingBudget(state));
  const started = await client.tool<RunEvalsResult>("run_evals", {
    project_id: state.project_id,
    eval_set_id: state.eval_set_id,
    candidates: [opts.setup],
    reps: opts.reps,
    max_eval_spend_usd: Math.round(cap * 1e6) / 1e6,
    keys_ref: ctx.keysRef,
    idempotency_key: newIdempotencyKey(),
  });
  ctx.log(`Run ${started.run_id} started. Waiting for the run.`);
  const report = await pollReport(client, state.project_id, started.run_id, {
    intervalMs: ctx.pollMs,
    timeoutMs: ctx.pollTimeoutMs,
  });
  if (report.status !== "succeeded") {
    ctx.log(`The run ended with status ${report.status}${report.code ? ` (${report.code})` : ""}.`);
  }
  const record: RunRecord = {
    run_id: started.run_id,
    candidate_id: opts.setup.id,
    mode: "direct",
    label: opts.label,
    reps: opts.reps,
    cost_usd: report.summary?.cost_usd ?? 0,
    created_at: new Date().toISOString(),
    setup: opts.setup,
  };
  addRun(ctx, record, opts.isBaseline);
  return record;
}
