import { createHash } from "node:crypto";
import type { ModelSettings, OpenRouterClient } from "../runner/openrouter.js";
import { withRetries, type RetryOptions } from "../runner/retry.js";

/** A model judge is trusted only when it agrees with people on this much held-out data. */
export const JUDGE_MIN_TEST_ITEMS = 20;
export const JUDGE_MIN_ACCURACY = 0.85;
export const JUDGE_MIN_KAPPA = 0.6;
/** Share of human-marked outputs kept back to test the judge. */
export const CALIBRATION_TEST_FRACTION = 0.5;

/** Change this when the prompt text changes. It is part of the config hash. */
export const JUDGE_PROMPT_VERSION = "judge-prompt-v1";
export const DEFAULT_JUDGE_SETTINGS: ModelSettings = { temperature: 0, max_tokens: 300 };

const MAX_JUDGE_INPUT_CHARS = 8000;
const MAX_JUDGE_OUTPUT_CHARS = 20_000;
const MAX_REASON_CHARS = 80;

export type Verdict = "pass" | "fail";

export type JudgeConfig = {
  judge_model: string;
  rubric: string;
  settings: ModelSettings;
};

export function judgeConfigHash(cfg: JudgeConfig): string {
  const settings = Object.fromEntries(
    Object.entries(cfg.settings).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: JUDGE_PROMPT_VERSION,
        model: cfg.judge_model,
        rubric: cfg.rubric,
        settings,
      }),
    )
    .digest("hex");
}

/** A rubric from the job's good-means text. */
export function defaultRubric(goodMeans: {
  how_it_should_behave: string;
  success: string;
  must_never: string;
} | null): string {
  if (!goodMeans) {
    return "";
  }
  const lines = [
    goodMeans.how_it_should_behave && `How it must behave: ${goodMeans.how_it_should_behave}`,
    goodMeans.success && `Success: ${goodMeans.success}`,
    goodMeans.must_never && `It must never: ${goodMeans.must_never}`,
  ].filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  return lines.join("\n");
}

const SYSTEM_PROMPT = [
  "You grade one output from an AI feature.",
  "Read the rubric, the task input, and the output.",
  "Decide if the output meets the rubric.",
  'Reply with JSON only: {"verdict":"pass","reason":"..."} or {"verdict":"fail","reason":"..."}.',
  "Keep the reason to one short sentence. Do not copy the output into the reason.",
].join("\n");

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut]` : text;
}

export function buildJudgePrompt(args: {
  rubric: string;
  input: string;
  output: string;
}): { systemPrompt: string; prompt: string } {
  return {
    systemPrompt: SYSTEM_PROMPT,
    prompt: [
      "<rubric>",
      args.rubric,
      "</rubric>",
      "<task_input>",
      clip(args.input, MAX_JUDGE_INPUT_CHARS),
      "</task_input>",
      "<output>",
      clip(args.output, MAX_JUDGE_OUTPUT_CHARS),
      "</output>",
    ].join("\n"),
  };
}

function shortReason(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 3)}...` : flat;
}

/** Parse the judge reply. Returns null when the reply is not a valid verdict. */
export function parseJudgeReply(text: string): { verdict: Verdict; reason: string } | null {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```\s*$/i.exec(trimmed);
  const body = fence ? fence[1]!.trim() : trimmed;
  const candidates = [body];
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(body.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const verdict =
      typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : null;
    if (verdict === "pass" || verdict === "fail") {
      return { verdict, reason: shortReason(obj.reason) };
    }
  }
  return null;
}

export type JudgeCallResult =
  | { ok: true; verdict: Verdict; reason: string; cost_usd: number }
  | { ok: false; error: "call_failed" | "bad_reply"; cost_usd: number };

/** One judge call with retries. A reply that is not a verdict is bad_reply. */
export async function callJudge(args: {
  client: OpenRouterClient;
  apiKey: string;
  config: JudgeConfig;
  input: string;
  output: string;
  retry?: RetryOptions;
}): Promise<JudgeCallResult> {
  const { systemPrompt, prompt } = buildJudgePrompt({
    rubric: args.config.rubric,
    input: args.input,
    output: args.output,
  });
  const call = await withRetries(
    () =>
      args.client.chatCompletion({
        model: args.config.judge_model,
        prompt,
        apiKey: args.apiKey,
        systemPrompt,
        settings: args.config.settings,
      }),
    args.retry,
  );
  if (!call.ok) {
    return { ok: false, error: "call_failed", cost_usd: 0 };
  }
  const cost = Number.isFinite(call.value.cost_usd) ? call.value.cost_usd : 0;
  const parsed = parseJudgeReply(call.value.content);
  if (!parsed) {
    return { ok: false, error: "bad_reply", cost_usd: cost };
  }
  return { ok: true, verdict: parsed.verdict, reason: parsed.reason, cost_usd: cost };
}

export type AgreementStats = {
  n: number;
  n_agree: number;
  accuracy: number;
  kappa: number;
};

/**
 * Agreement of judge with people. A null judge verdict (no valid reply)
 * counts as a disagreement. Kappa is 0 when chance agreement is 1, for
 * example when every human mark has the same verdict.
 */
export function agreementStats(
  pairs: Array<{ human: Verdict; judge: Verdict | null }>,
): AgreementStats {
  const n = pairs.length;
  if (n === 0) {
    return { n: 0, n_agree: 0, accuracy: 0, kappa: 0 };
  }
  const flip = (v: Verdict): Verdict => (v === "pass" ? "fail" : "pass");
  const effective = pairs.map((p) => ({ human: p.human, judge: p.judge ?? flip(p.human) }));
  const nAgree = effective.filter((p) => p.human === p.judge).length;
  const po = nAgree / n;
  const humanPass = effective.filter((p) => p.human === "pass").length / n;
  const judgePass = effective.filter((p) => p.judge === "pass").length / n;
  const pe = humanPass * judgePass + (1 - humanPass) * (1 - judgePass);
  const kappa = pe >= 1 ? 0 : (po - pe) / (1 - pe);
  return { n, n_agree: nAgree, accuracy: po, kappa };
}

export function trustDecision(stats: {
  n_test: number;
  accuracy: number | null;
  kappa: number | null;
}): { trusted: boolean; reason: string } {
  if (stats.n_test < JUDGE_MIN_TEST_ITEMS) {
    return {
      trusted: false,
      reason: `Need ${JUDGE_MIN_TEST_ITEMS} held-out human-marked outputs. Found ${stats.n_test}.`,
    };
  }
  const accuracy = stats.accuracy ?? 0;
  const kappa = stats.kappa ?? 0;
  if (accuracy < JUDGE_MIN_ACCURACY) {
    return {
      trusted: false,
      reason: `Judge agrees with people on ${pct(accuracy)}. It must agree on ${pct(JUDGE_MIN_ACCURACY)}.`,
    };
  }
  if (kappa < JUDGE_MIN_KAPPA) {
    return {
      trusted: false,
      reason: `Judge kappa is ${kappa.toFixed(2)}. It must be ${JUDGE_MIN_KAPPA} or more.`,
    };
  }
  return {
    trusted: true,
    reason: `Judge agrees with people on ${pct(accuracy)} of ${stats.n_test} held-out outputs.`,
  };
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
