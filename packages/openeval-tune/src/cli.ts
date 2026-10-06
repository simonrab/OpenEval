import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isOptimizerKey,
  OpenEvalClient,
  OpenEvalError,
  type FetchLike,
  type TrainingFailuresPage,
  type VerdictResult,
} from "./client.js";
import {
  LimitError,
  scoreDirect,
  scoreHarness,
  UsageError,
  type OpsContext,
} from "./ops.js";
import { continuePromote, startPromote } from "./promote.js";
import {
  DEFAULT_STATE_DIR,
  loadState,
  newState,
  remainingBudget,
  saveState,
  type DirectSetup,
  type Mode,
  type RunRef,
  type TuneState,
} from "./state.js";
import { EXIT, runVerdict } from "./verdict.js";

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: FetchLike;
  cwd?: string;
};

const defaultIo: Io = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  url: { type: "string" },
  project: { type: "string" },
  "eval-set": { type: "string" },
  "keys-ref": { type: "string" },
  "state-dir": { type: "string" },
  mode: { type: "string" },
  candidate: { type: "string" },
  cmd: { type: "string" },
  label: { type: "string" },
  reps: { type: "string" },
  concurrency: { type: "string" },
  "timeout-ms": { type: "string" },
  commit: { type: "string" },
  description: { type: "string" },
  "max-spend": { type: "string" },
  budget: { type: "string" },
  "max-rounds": { type: "string" },
  objective: { type: "string" },
  "min-effect": { type: "string" },
  "new-session": { type: "boolean" },
  run: { type: "string" },
  "baseline-run": { type: "string" },
  "baseline-candidate": { type: "string" },
  limit: { type: "string" },
  continue: { type: "boolean" },
  full: { type: "boolean" },
  rollback: { type: "boolean" },
  "reuse-run": { type: "boolean" },
  setup: { type: "string" },
  intent: { type: "string" },
  "poll-ms": { type: "string" },
  "poll-timeout-ms": { type: "string" },
} as const;

type Flags = {
  [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string;
};

export const HELP = `openeval-tune: improve an AI feature one change per round. OpenEval is the referee.

Usage: openeval-tune <command> [flags]

Commands:
  baseline     Score the baseline and start or update the session.
                 --mode direct --candidate <json|file>
                 --mode harness --cmd "<cmd>" [--label base]
               Session flags: --reps 3 --budget 10 --max-rounds 20
                 --objective quality|cost --min-effect 0.05 --new-session
  run-harness  Run the app harness on every eval input, then submit the outputs.
                 --cmd "<cmd>" --label <label> [--reps N] [--concurrency 4]
                 [--timeout-ms 60000] [--commit <sha>] [--description <text>]
  run-direct   Score a direct setup with run_evals and wait for the run.
                 --candidate <json|file> [--label <label>] [--reps N] [--max-spend 2]
  failures     Show the training failures. Default: the current baseline.
                 [--run <id> --candidate <id>] [--limit 20]
  verdict      Ask OpenEval for a verdict and update the session.
                 [--run <id> --candidate <id>] (default: the last run)
                 [--baseline-run <id> --baseline-candidate <id>]
                 [--objective quality|cost] [--min-effect 0.05]
  status       Show the session, baseline, rounds, and spend.
  report       Compare the current baseline with the first baseline (no round is recorded).
  promote      Ship a direct setup through the OpenEval Live human gates.
               Needs OPENEVAL_ADMIN_KEY (a full key). Never approves a gate.
                 --run <id> --candidate <id> [--reuse-run] [--setup <json|file>]
                 [--max-spend 2] [--intent new_feature|add_feature]
                 --continue [--full | --rollback]

Common flags: --url --project --eval-set --keys-ref --state-dir
              --poll-ms 2000 --poll-timeout-ms 1800000

Environment: OPENEVAL_URL, OPENEVAL_KEY (optimizer key, oeo_...),
  OPENEVAL_ADMIN_KEY (full key, promote only), OPENEVAL_PROJECT_ID,
  OPENEVAL_EVAL_SET_ID, OPENEVAL_KEYS_REF.

Exit codes:
  0 ok, or verdict keep        1 error
  2 revert_overfit or revert_regressed
  3 within_noise (revert)      4 not_comparable (fix and score again)
  5 plateau (stop)             6 budget spent or max rounds done (stop)
  7 promote waits for a person
`;

type Config = {
  url: string;
  key: string;
  adminKey: string;
  projectId: string;
  evalSetId: string;
  keysRef: string | null;
  stateDir: string;
  pollMs: number;
  pollTimeoutMs: number;
};

function num(flags: Flags, name: keyof Flags, fallback: number, opts: { min?: number; max?: number; int?: boolean } = {}): number {
  const raw = flags[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  const bad =
    typeof raw !== "string" ||
    raw.trim() === "" ||
    !Number.isFinite(n) ||
    (opts.int && !Number.isInteger(n)) ||
    (opts.min !== undefined && n < opts.min) ||
    (opts.max !== undefined && n > opts.max);
  if (bad) {
    const range = [opts.min !== undefined ? `at least ${opts.min}` : null, opts.max !== undefined ? `at most ${opts.max}` : null]
      .filter(Boolean)
      .join(" and ");
    throw new UsageError(`--${String(name)} must be a${opts.int ? "n integer" : " number"}${range ? ` ${range}` : ""}.`);
  }
  return n;
}

function loadConfig(flags: Flags, env: NodeJS.ProcessEnv, cwd: string): Config {
  return {
    url: flags.url ?? env.OPENEVAL_URL ?? "",
    key: env.OPENEVAL_KEY ?? "",
    adminKey: env.OPENEVAL_ADMIN_KEY ?? "",
    projectId: flags.project ?? env.OPENEVAL_PROJECT_ID ?? "",
    evalSetId: flags["eval-set"] ?? env.OPENEVAL_EVAL_SET_ID ?? "",
    keysRef: flags["keys-ref"] ?? env.OPENEVAL_KEYS_REF ?? null,
    stateDir: resolve(cwd, flags["state-dir"] ?? env.OPENEVAL_TUNE_DIR ?? DEFAULT_STATE_DIR),
    pollMs: num(flags, "poll-ms", Number(env.OPENEVAL_TUNE_POLL_MS ?? 2000), { min: 1 }),
    pollTimeoutMs: num(flags, "poll-timeout-ms", 30 * 60 * 1000, { min: 1 }),
  };
}

function optimizerClient(cfg: Config, io: Io): OpenEvalClient {
  if (!cfg.url) throw new UsageError("OPENEVAL_URL is missing. Set OPENEVAL_URL or pass --url.");
  if (!cfg.key) {
    throw new UsageError(
      "OPENEVAL_KEY is missing. Set it to an optimizer key (oeo_...). A person with a full key mints one: POST /v1/keys {\"project_id\":\"prj_...\",\"scope\":\"optimizer\"}.",
    );
  }
  if (!isOptimizerKey(cfg.key)) {
    throw new UsageError(
      "OPENEVAL_KEY is not an optimizer key. The tune loop uses only an optimizer key (oeo_...). Do not use a full key in the loop.",
    );
  }
  return new OpenEvalClient({ url: cfg.url, key: cfg.key, fetch: io.fetch });
}

function adminClient(cfg: Config, io: Io): OpenEvalClient {
  if (!cfg.url) throw new UsageError("OPENEVAL_URL is missing. Set OPENEVAL_URL or pass --url.");
  if (!cfg.adminKey) {
    throw new UsageError("promote needs OPENEVAL_ADMIN_KEY. Ask a person to set a full OpenEval key. The tune loop does not use it.");
  }
  if (isOptimizerKey(cfg.adminKey) || cfg.adminKey === cfg.key) {
    throw new UsageError(
      "OPENEVAL_ADMIN_KEY is an optimizer key. promote needs a full key. An optimizer key cannot promote a setup.",
    );
  }
  return new OpenEvalClient({ url: cfg.url, key: cfg.adminKey, fetch: io.fetch });
}

/** Read inline JSON, or a JSON file. */
function readJsonArg(value: string, cwd: string): { data: Record<string, unknown>; baseDir: string } {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      return { data: JSON.parse(trimmed) as Record<string, unknown>, baseDir: cwd };
    } catch {
      throw new UsageError("The candidate JSON is not valid.");
    }
  }
  const path = resolve(cwd, trimmed);
  if (!existsSync(path)) throw new UsageError(`The file ${path} does not exist.`);
  try {
    return { data: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>, baseDir: dirname(path) };
  } catch {
    throw new UsageError(`The file ${path} is not valid JSON.`);
  }
}

const SETTING_KEYS = new Set(["temperature", "top_p", "max_tokens", "reasoning_effort"]);

/**
 * A direct setup from JSON: {model, id?, label?, settings?, system_prompt?, system_prompt_file?}.
 * system_prompt_file is relative to the JSON file.
 */
export function parseDirectSetup(value: string, cwd: string, labelFlag?: string): { setup: DirectSetup; label: string | null } {
  const { data, baseDir } = readJsonArg(value, cwd);
  const model = data.model;
  if (typeof model !== "string" || model.length === 0) {
    throw new UsageError('The candidate needs "model", for example {"model":"openai/gpt-4o-mini"}.');
  }
  if (model.includes("#")) throw new UsageError('"model" must not have "#".');
  let id: string;
  if (labelFlag) id = `${model}#${labelFlag}`;
  else if (typeof data.id === "string") id = data.id;
  else if (typeof data.label === "string") id = `${model}#${data.label}`;
  else id = model;
  if (id.split("#")[0] !== model) {
    throw new UsageError("The candidate id must be the model id, or model#label.");
  }
  if (!/^[^#]+(#[A-Za-z0-9._-]+)?$/.test(id)) {
    throw new UsageError("The label must have only letters, digits, dot, underscore, or dash.");
  }
  const setup: DirectSetup = { id, model };
  if (data.settings !== undefined) {
    if (!data.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) {
      throw new UsageError('"settings" must be an object.');
    }
    for (const key of Object.keys(data.settings)) {
      if (!SETTING_KEYS.has(key)) {
        throw new UsageError(`The setting "${key}" is not known. Use temperature, top_p, max_tokens, or reasoning_effort.`);
      }
    }
    setup.settings = data.settings as Record<string, unknown>;
  }
  if (typeof data.system_prompt_file === "string") {
    const path = resolve(baseDir, data.system_prompt_file);
    if (!existsSync(path)) throw new UsageError(`The system prompt file ${path} does not exist.`);
    setup.system_prompt = readFileSync(path, "utf8");
  } else if (typeof data.system_prompt === "string") {
    setup.system_prompt = data.system_prompt;
  }
  if (setup.system_prompt !== undefined && setup.system_prompt.trim().length === 0) {
    delete setup.system_prompt;
  }
  return { setup, label: id.includes("#") ? id.slice(id.indexOf("#") + 1) : null };
}

function requireState(cfg: Config): TuneState {
  const state = loadState(cfg.stateDir);
  if (!state) {
    throw new UsageError(`There is no session in ${cfg.stateDir}. Run "openeval-tune baseline" first.`);
  }
  return state;
}

function opsContext(cfg: Config, client: OpenEvalClient, state: TuneState, io: Io): OpsContext {
  return {
    client,
    state,
    stateDir: cfg.stateDir,
    keysRef: cfg.keysRef,
    pollMs: cfg.pollMs,
    pollTimeoutMs: cfg.pollTimeoutMs,
    log: (line) => io.stderr(`${line}\n`),
  };
}

function print(io: Io, body: unknown): void {
  io.stdout(`${JSON.stringify(body, null, 2)}\n`);
}

function parseMode(value: string | undefined): Mode {
  if (value === "direct" || value === "harness") return value;
  throw new UsageError("Pass --mode direct or --mode harness.");
}

function parseObjective(value: string | undefined): "quality" | "cost" | undefined {
  if (value === undefined) return undefined;
  if (value === "quality" || value === "cost") return value;
  throw new UsageError("--objective must be quality or cost.");
}

function runRefFromFlags(flags: Flags, state: TuneState, fallback: "baseline" | "latest"): RunRef {
  if (flags.run || flags.candidate) {
    if (!flags.run || !flags.candidate) throw new UsageError("Pass --run and --candidate together.");
    return { run_id: flags.run, candidate_id: flags.candidate };
  }
  if (fallback === "baseline" && state.baseline) return state.baseline;
  const latest = state.runs.at(-1);
  if (!latest) throw new UsageError("There is no run in this session. Pass --run and --candidate.");
  return { run_id: latest.run_id, candidate_id: latest.candidate_id };
}

async function cmdBaseline(flags: Flags, cfg: Config, io: Io, cwd: string): Promise<number> {
  const mode = parseMode(flags.mode);
  const client = optimizerClient(cfg, io);
  let state = loadState(cfg.stateDir);
  const fresh = !state || flags["new-session"] === true;
  if (fresh) {
    if (!cfg.projectId || !cfg.evalSetId) {
      throw new UsageError("Set OPENEVAL_PROJECT_ID and OPENEVAL_EVAL_SET_ID, or pass --project and --eval-set.");
    }
    state = newState({ project_id: cfg.projectId, eval_set_id: cfg.evalSetId, mode });
  } else if (state && ((cfg.projectId && cfg.projectId !== state.project_id) || (cfg.evalSetId && cfg.evalSetId !== state.eval_set_id))) {
    throw new UsageError("The project or eval set is not the same as in the session. Pass --new-session to start a new session.");
  }
  const s = state!;
  const reps = num(flags, "reps", s.reps, { min: 1, max: 10, int: true });
  s.budget_usd = num(flags, "budget", s.budget_usd, { min: 0 });
  s.max_rounds = num(flags, "max-rounds", s.max_rounds, { min: 1, int: true });
  s.objective = parseObjective(flags.objective) ?? s.objective;
  if (flags["min-effect"] !== undefined) s.min_effect = num(flags, "min-effect", 0.05, { min: 0.0001, max: 1 });
  saveState(cfg.stateDir, s);

  const ctx = opsContext(cfg, client, s, io);
  const maxSpend = num(flags, "max-spend", 2, { min: 0 });
  let record;
  if (mode === "harness") {
    if (!flags.cmd) throw new UsageError('Harness mode needs --cmd "<command>".');
    record = await scoreHarness(ctx, {
      cmd: flags.cmd,
      label: flags.label ?? "base",
      reps,
      concurrency: num(flags, "concurrency", 4, { min: 1, int: true }),
      timeoutMs: num(flags, "timeout-ms", 60_000, { min: 1, int: true }),
      commit: flags.commit,
      description: flags.description,
      maxSpendUsd: maxSpend,
      isBaseline: true,
      cwd,
    });
  } else {
    if (!flags.candidate) throw new UsageError("Direct mode needs --candidate <json|file>.");
    const { setup, label } = parseDirectSetup(flags.candidate, cwd, flags.label);
    record = await scoreDirect(ctx, { setup, reps, maxSpendUsd: maxSpend, isBaseline: true, label });
  }
  print(io, {
    session_id: s.session_id,
    mode: s.mode,
    reps: s.reps,
    run_id: record.run_id,
    candidate_id: record.candidate_id,
    cost_usd: record.cost_usd,
    spend_usd: s.spend_usd,
    budget_usd: s.budget_usd,
    next: 'Read the training failures: openeval-tune failures',
  });
  return EXIT.ok;
}

async function cmdRunHarness(flags: Flags, cfg: Config, io: Io, cwd: string): Promise<number> {
  const client = optimizerClient(cfg, io);
  const state = requireState(cfg);
  if (!flags.cmd) throw new UsageError('Pass --cmd "<command>".');
  if (!flags.label) throw new UsageError("Pass --label <label> for this candidate.");
  const ctx = opsContext(cfg, client, state, io);
  const record = await scoreHarness(ctx, {
    cmd: flags.cmd,
    label: flags.label,
    reps: num(flags, "reps", state.reps, { min: 1, max: 10, int: true }),
    concurrency: num(flags, "concurrency", 4, { min: 1, int: true }),
    timeoutMs: num(flags, "timeout-ms", 60_000, { min: 1, int: true }),
    commit: flags.commit,
    description: flags.description,
    maxSpendUsd: num(flags, "max-spend", 2, { min: 0 }),
    isBaseline: false,
    cwd,
  });
  print(io, {
    run_id: record.run_id,
    candidate_id: record.candidate_id,
    cost_usd: record.cost_usd,
    spend_usd: state.spend_usd,
    budget_usd: state.budget_usd,
    next: `openeval-tune verdict --run ${record.run_id} --candidate ${record.candidate_id}`,
  });
  return EXIT.ok;
}

async function cmdRunDirect(flags: Flags, cfg: Config, io: Io, cwd: string): Promise<number> {
  const client = optimizerClient(cfg, io);
  const state = requireState(cfg);
  if (!flags.candidate) throw new UsageError("Pass --candidate <json|file>.");
  const { setup, label } = parseDirectSetup(flags.candidate, cwd, flags.label);
  const ctx = opsContext(cfg, client, state, io);
  const record = await scoreDirect(ctx, {
    setup,
    reps: num(flags, "reps", state.reps, { min: 1, max: 10, int: true }),
    maxSpendUsd: num(flags, "max-spend", 2, { min: 0 }),
    isBaseline: false,
    label,
  });
  print(io, {
    run_id: record.run_id,
    candidate_id: record.candidate_id,
    cost_usd: record.cost_usd,
    spend_usd: state.spend_usd,
    budget_usd: state.budget_usd,
    next: `openeval-tune verdict --run ${record.run_id} --candidate ${record.candidate_id}`,
  });
  return EXIT.ok;
}

async function cmdFailures(flags: Flags, cfg: Config, io: Io): Promise<number> {
  const client = optimizerClient(cfg, io);
  const state = requireState(cfg);
  const ref = runRefFromFlags(flags, state, "baseline");
  const max = num(flags, "limit", 20, { min: 1, max: 200, int: true });
  const failures: TrainingFailuresPage["failures"] = [];
  let cursor: string | null = null;
  let first: TrainingFailuresPage | null = null;
  while (failures.length < max) {
    const body: Record<string, unknown> = {
      project_id: state.project_id,
      run_id: ref.run_id,
      candidate_id: ref.candidate_id,
      limit: Math.min(20, max - failures.length),
    };
    if (cursor) body.cursor = cursor;
    const page: TrainingFailuresPage = await client.tool<TrainingFailuresPage>("get_training_failures", body);
    first ??= page;
    failures.push(...page.failures);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  print(io, {
    run_id: ref.run_id,
    candidate_id: ref.candidate_id,
    directional: first?.directional ?? false,
    train: first?.train,
    holdout_counts: first?.holdout,
    more: cursor !== null,
    failures: failures.map((f) => ({
      eval_id: f.eval_id,
      title: f.title,
      input: f.input,
      flaky: f.flaky,
      scorer: f.scorer_primitive,
      reps: f.reps.map((r) => ({
        rep: r.rep,
        passed: r.passed,
        reason: r.reason_short,
        ...(r.output !== null ? { output: r.output } : {}),
      })),
    })),
  });
  return EXIT.ok;
}

function compactSplit(s: VerdictResult["train"]) {
  return {
    n_evals: s.n_evals,
    baseline_pass_rate: s.baseline_pass_rate,
    candidate_pass_rate: s.candidate_pass_rate,
    delta: s.delta,
    ci95: s.ci95,
    noise_floor: s.noise_floor,
    n_regressed: s.n_regressed,
  };
}

async function cmdVerdict(flags: Flags, cfg: Config, io: Io): Promise<number> {
  const client = optimizerClient(cfg, io);
  const state = requireState(cfg);
  const candidate = runRefFromFlags(flags, state, "latest");
  let baseline: RunRef | undefined;
  if (flags["baseline-run"] || flags["baseline-candidate"]) {
    if (!flags["baseline-run"] || !flags["baseline-candidate"]) {
      throw new UsageError("Pass --baseline-run and --baseline-candidate together.");
    }
    baseline = { run_id: flags["baseline-run"], candidate_id: flags["baseline-candidate"] };
  }
  const current = baseline ?? state.baseline;
  if (current && current.run_id === candidate.run_id && current.candidate_id === candidate.candidate_id) {
    throw new UsageError("The candidate is the baseline. Score a new candidate first.");
  }
  const outcome = await runVerdict(client, state, cfg.stateDir, {
    candidate,
    baseline,
    objective: parseObjective(flags.objective),
    minEffect: flags["min-effect"] !== undefined ? num(flags, "min-effect", 0.05, { min: 0.0001, max: 1 }) : undefined,
  });
  const r = outcome.result;
  print(io, {
    verdict: r.verdict,
    action: outcome.action,
    reason: r.reason,
    stop: outcome.stop,
    underpowered: r.underpowered,
    advice: r.advice,
    directional: r.directional,
    train: compactSplit(r.train),
    holdout: compactSplit(r.holdout),
    cost_per_call_usd: r.cost_per_call_usd,
    p50_latency_ms: r.p50_latency_ms,
    rounds: r.rounds,
    flat_rounds: r.flat_rounds,
    plateau: r.plateau,
    baseline: state.baseline,
    spend_usd: state.spend_usd,
    budget_usd: state.budget_usd,
    rounds_left: Math.max(0, state.max_rounds - state.rounds.length),
  });
  const msg: Record<string, string> = {
    keep: "Keep the commit. The candidate is the new baseline.",
    revert: "Revert the commit of this round.",
    fix_and_rescore: "The runs are not comparable. Fix the coverage or errors, then score again.",
  };
  io.stderr(`${msg[outcome.action]}\n`);
  if (outcome.stop === "plateau") io.stderr("Plateau: stop. Put the remaining failures into groups.\n");
  if (outcome.stop === "budget") io.stderr("The budget is spent: stop.\n");
  if (outcome.stop === "max_rounds") io.stderr("The round limit is done: stop.\n");
  return outcome.exitCode;
}

function cmdStatus(cfg: Config, io: Io): number {
  const state = requireState(cfg);
  const last = state.rounds.at(-1);
  let flat = 0;
  for (const r of [...state.rounds].reverse()) {
    if (r.verdict === "not_comparable") continue;
    if (r.verdict === "keep") break;
    flat += 1;
  }
  print(io, {
    session_id: state.session_id,
    project_id: state.project_id,
    eval_set_id: state.eval_set_id,
    mode: state.mode,
    reps: state.reps,
    objective: state.objective,
    min_effect: state.min_effect,
    baseline: state.baseline,
    original_baseline: state.original_baseline,
    rounds: state.rounds.length,
    max_rounds: state.max_rounds,
    flat_rounds: flat,
    kept: state.rounds.filter((r) => r.verdict === "keep").length,
    last_round: last ?? null,
    spend_usd: state.spend_usd,
    budget_usd: state.budget_usd,
    budget_left_usd: remainingBudget(state),
    promote: state.promote ? { stage: state.promote.stage, policy_id: state.promote.policy_id } : null,
  });
  return EXIT.ok;
}

async function cmdReport(cfg: Config, io: Io): Promise<number> {
  const client = optimizerClient(cfg, io);
  const state = requireState(cfg);
  if (!state.baseline || !state.original_baseline) {
    throw new UsageError('There is no baseline. Run "openeval-tune baseline" first.');
  }
  const kept = state.rounds
    .filter((r) => r.verdict === "keep")
    .map((r) => {
      const run = state.runs.find((x) => x.run_id === r.run_id && x.candidate_id === r.candidate_id);
      return {
        round: r.round,
        run_id: r.run_id,
        candidate_id: r.candidate_id,
        commit: run?.commit ?? null,
        reason: r.reason,
        train_delta: r.train_delta,
        holdout_delta: r.holdout_delta,
      };
    });
  let comparison: Record<string, unknown> | null = null;
  const same =
    state.baseline.run_id === state.original_baseline.run_id &&
    state.baseline.candidate_id === state.original_baseline.candidate_id;
  if (!same) {
    // No session_id: OpenEval does not record a round for this call.
    const r = await client.tool<VerdictResult>("get_verdict", {
      project_id: state.project_id,
      baseline_run_id: state.original_baseline.run_id,
      baseline_candidate_id: state.original_baseline.candidate_id,
      candidate_run_id: state.baseline.run_id,
      candidate_id: state.baseline.candidate_id,
      objective: state.objective,
    });
    comparison = {
      verdict_vs_original: r.verdict,
      reason: r.reason,
      train: compactSplit(r.train),
      holdout: compactSplit(r.holdout),
      cost_per_call_usd: r.cost_per_call_usd,
      p50_latency_ms: r.p50_latency_ms,
    };
  }
  print(io, {
    session_id: state.session_id,
    original_baseline: state.original_baseline,
    final_baseline: state.baseline,
    rounds: state.rounds.length,
    kept,
    reverted: state.rounds.filter((r) => r.verdict !== "keep").length,
    vs_original: comparison,
    spend_usd: state.spend_usd,
    budget_usd: state.budget_usd,
  });
  return EXIT.ok;
}

async function cmdPromote(flags: Flags, cfg: Config, io: Io, cwd: string): Promise<number> {
  const admin = adminClient(cfg, io);
  const state = requireState(cfg);
  const ctx = {
    admin,
    state,
    stateDir: cfg.stateDir,
    keysRef: cfg.keysRef,
    pollMs: cfg.pollMs,
    pollTimeoutMs: cfg.pollTimeoutMs,
    log: (line: string) => io.stderr(`${line}\n`),
  };
  let result;
  if (flags.continue) {
    result = await continuePromote(ctx, { full: flags.full === true, rollback: flags.rollback === true });
  } else {
    if (!flags.run || !flags.candidate) {
      throw new UsageError("Pass --run <id> --candidate <id>, or --continue.");
    }
    if (state.promote && state.promote.stage !== "done") {
      throw new UsageError(
        `A promotion is in progress at stage ${state.promote.stage}. Run "openeval-tune promote --continue".`,
      );
    }
    const intent = flags.intent ?? "new_feature";
    if (intent !== "new_feature" && intent !== "add_feature") {
      throw new UsageError("--intent must be new_feature or add_feature.");
    }
    result = await startPromote(ctx, {
      runId: flags.run,
      candidateId: flags.candidate,
      setup: flags.setup ? parseDirectSetup(flags.setup, cwd).setup : undefined,
      reuseRun: flags["reuse-run"] === true,
      maxSpendUsd: num(flags, "max-spend", 2, { min: 0.000001 }),
      intent,
    });
  }
  print(io, result.body);
  if (result.body.approve_url) {
    io.stderr(`A person must open this URL: ${result.body.approve_url}\nThe agent must not open or approve it.\n`);
  }
  return result.exitCode;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, io: Io = defaultIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return command ? EXIT.ok : EXIT.error;
  }
  try {
    const parsed = parseArgs({ args: rest, options: OPTIONS, strict: true, allowPositionals: false });
    const flags = parsed.values as Flags;
    if (flags.help) {
      io.stdout(HELP);
      return EXIT.ok;
    }
    const cfg = loadConfig(flags, env, cwd);
    switch (command) {
      case "baseline":
        return await cmdBaseline(flags, cfg, io, cwd);
      case "run-harness":
        return await cmdRunHarness(flags, cfg, io, cwd);
      case "run-direct":
        return await cmdRunDirect(flags, cfg, io, cwd);
      case "failures":
        return await cmdFailures(flags, cfg, io);
      case "verdict":
        return await cmdVerdict(flags, cfg, io);
      case "status":
        return cmdStatus(cfg, io);
      case "report":
        return await cmdReport(cfg, io);
      case "promote":
        return await cmdPromote(flags, cfg, io, cwd);
      default:
        io.stderr(`The command "${command}" is not known. Run "openeval-tune help".\n`);
        return EXIT.error;
    }
  } catch (err) {
    if (err instanceof LimitError) {
      io.stderr(`${err.message}\n`);
      return EXIT.limit;
    }
    if (err instanceof OpenEvalError) {
      const code = err.code ? ` [${err.code}]` : "";
      io.stderr(`OpenEval error${code} (status ${err.status}): ${err.message}\n`);
      if (err.code === "SCOPE_FORBIDDEN") {
        io.stderr("The key cannot do this call. The tune loop uses only optimizer tools.\n");
      }
      return EXIT.error;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}\n`);
    return EXIT.error;
  }
}
