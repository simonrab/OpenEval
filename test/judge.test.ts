import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agreementStats,
  buildJudgePrompt,
  callJudge,
  defaultRubric,
  judgeConfigHash,
  JUDGE_MIN_ACCURACY,
  JUDGE_MIN_KAPPA,
  JUDGE_MIN_TEST_ITEMS,
  parseJudgeReply,
  trustDecision,
  type Verdict,
} from "../src/judge/judge.js";
import { scoreOutput, PERSON_MARK_REUSED, type ScorableEval } from "../src/runner/score.js";

describe("judge reply parsing", () => {
  it("reads strict JSON", () => {
    assert.deepEqual(parseJudgeReply('{"verdict":"pass","reason":"ok"}'), { verdict: "pass", reason: "ok" });
  });

  it("reads fenced JSON, extra text, and odd case", () => {
    assert.deepEqual(parseJudgeReply('```json\n{"verdict":"FAIL","reason":"no total"}\n```'), {
      verdict: "fail",
      reason: "no total",
    });
    assert.equal(parseJudgeReply('Here is my grade: {"verdict": " pass "} done')?.verdict, "pass");
  });

  it("returns null for a reply that is not a verdict", () => {
    for (const bad of ["pass", "", "{}", '{"verdict":"maybe"}', "[1]", '{"verdict":true}', "{broken"]) {
      assert.equal(parseJudgeReply(bad), null, bad);
    }
  });

  it("keeps the reason short and on one line", () => {
    const parsed = parseJudgeReply(JSON.stringify({ verdict: "fail", reason: `a\nb ${"x".repeat(300)}` }));
    assert.ok(parsed);
    assert.ok(parsed.reason.length <= 80);
    assert.equal(parsed.reason.includes("\n"), false);
  });
});

describe("calibration math", () => {
  const pairs = (spec: Array<[Verdict, Verdict | null]>) => spec.map(([human, judge]) => ({ human, judge }));

  it("computes accuracy and Cohen's kappa on a fixed table", () => {
    // 20 items: TP 8, FN 2, FP 1, TN 9.
    const table = pairs([
      ...Array<[Verdict, Verdict]>(8).fill(["pass", "pass"]),
      ...Array<[Verdict, Verdict]>(2).fill(["pass", "fail"]),
      ...Array<[Verdict, Verdict]>(1).fill(["fail", "pass"]),
      ...Array<[Verdict, Verdict]>(9).fill(["fail", "fail"]),
    ]);
    const stats = agreementStats(table);
    assert.equal(stats.n, 20);
    assert.equal(stats.n_agree, 17);
    assert.equal(stats.accuracy, 0.85);
    // po 0.85, pe = 0.5*0.45 + 0.5*0.55 = 0.5, kappa = 0.7.
    assert.ok(Math.abs(stats.kappa - 0.7) < 1e-9);
  });

  it("counts a judge parse failure as a disagreement", () => {
    const stats = agreementStats(pairs([["pass", null], ["fail", null], ["pass", "pass"], ["fail", "fail"]]));
    assert.equal(stats.n_agree, 2);
    assert.equal(stats.accuracy, 0.5);
  });

  it("gives kappa 0 when one class makes chance agreement 1", () => {
    const stats = agreementStats(pairs(Array<[Verdict, Verdict]>(25).fill(["pass", "pass"])));
    assert.equal(stats.accuracy, 1);
    assert.equal(stats.kappa, 0);
  });

  it("gives kappa 0 for a judge that always says pass", () => {
    const stats = agreementStats(
      pairs([...Array<[Verdict, Verdict]>(18).fill(["pass", "pass"]), ...Array<[Verdict, Verdict]>(2).fill(["fail", "pass"])]),
    );
    assert.equal(stats.accuracy, 0.9);
    assert.equal(stats.kappa, 0);
  });

  it("applies the trust thresholds", () => {
    assert.equal(JUDGE_MIN_TEST_ITEMS, 20);
    assert.equal(JUDGE_MIN_ACCURACY, 0.85);
    assert.equal(JUDGE_MIN_KAPPA, 0.6);
    assert.equal(trustDecision({ n_test: 20, accuracy: 0.85, kappa: 0.6 }).trusted, true);
    assert.equal(trustDecision({ n_test: 19, accuracy: 1, kappa: 1 }).trusted, false);
    assert.equal(trustDecision({ n_test: 40, accuracy: 0.84, kappa: 0.9 }).trusted, false);
    assert.equal(trustDecision({ n_test: 40, accuracy: 0.95, kappa: 0.59 }).trusted, false);
    assert.match(trustDecision({ n_test: 3, accuracy: null, kappa: null }).reason, /Need 20/);
  });
});

describe("judge config and prompt", () => {
  const base = { judge_model: "m/judge", rubric: "Be kind.", settings: { temperature: 0 } };

  it("changes the hash when model, rubric, or settings change", () => {
    const h = judgeConfigHash(base);
    assert.equal(judgeConfigHash({ ...base }), h);
    assert.notEqual(judgeConfigHash({ ...base, judge_model: "m/other" }), h);
    assert.notEqual(judgeConfigHash({ ...base, rubric: "Be brief." }), h);
    assert.notEqual(judgeConfigHash({ ...base, settings: { temperature: 0.5 } }), h);
  });

  it("derives a rubric from good-means text", () => {
    const rubric = defaultRubric({ how_it_should_behave: "warm tone", success: "helpful", must_never: "rude" });
    assert.match(rubric, /warm tone/);
    assert.match(rubric, /rude/);
    assert.equal(defaultRubric(null), "");
  });

  it("puts rubric, input, and output in the prompt", () => {
    const p = buildJudgePrompt({ rubric: "R1", input: "IN", output: "OUT" });
    assert.match(p.prompt, /<rubric>\nR1/);
    assert.match(p.prompt, /<task_input>\nIN/);
    assert.match(p.prompt, /<output>\nOUT/);
    assert.match(p.systemPrompt, /JSON only/);
  });

  it("callJudge returns bad_reply with the real cost when the reply is not JSON", async () => {
    const client = {
      async chatCompletion() {
        return { content: "I think it passes", time_ms: 1, cost_usd: 0.003 };
      },
    };
    const r = await callJudge({ client, apiKey: "k", config: base, input: "i", output: "o" });
    assert.deepEqual(r, { ok: false, error: "bad_reply", cost_usd: 0.003 });
  });

  it("callJudge returns call_failed after retries", async () => {
    let calls = 0;
    const client = {
      async chatCompletion(): Promise<never> {
        calls += 1;
        throw new Error("OpenRouter 500: down");
      },
    };
    const r = await callJudge({
      client,
      apiKey: "k",
      config: base,
      input: "i",
      output: "o",
      retry: { attempts: 2, baseDelayMs: 0 },
    });
    assert.equal(r.ok, false);
    assert.equal(calls, 2);
  });
});

describe("scoreOutput with person evals", () => {
  function personEval(mark: Record<string, unknown>): ScorableEval {
    return {
      kind: "person",
      trusted_mark: JSON.stringify(mark),
      eval_id: "evl_1",
      title: "t",
      score_how: "person",
      status: "trusted",
      archetype_id: null,
      scorer_primitive: null,
      program_check: null,
      input_truncated: "the input",
      form_spec: null,
      evidence_json: null,
    };
  }
  const passMark = personEval({ form_type: "pass_fail", pass_fail: "pass" });

  it("flags a reused mark when no judge is trusted", async () => {
    const r = await scoreOutput(passMark, "anything at all");
    assert.equal(r.passed, true);
    assert.ok(r.reason_short.startsWith(PERSON_MARK_REUSED));
    assert.equal(r.error, false);
  });

  it("uses the judge for pass_fail and rubric marks", async () => {
    const seen: string[] = [];
    const judge = async (input: string, output: string) => {
      seen.push(`${input}|${output}`);
      return output.includes("good")
        ? { ok: true as const, verdict: "pass" as const, reason: "fine", cost_usd: 0.01 }
        : { ok: true as const, verdict: "fail" as const, reason: "no total", cost_usd: 0.01 };
    };
    const good = await scoreOutput(passMark, "good answer", { judge });
    assert.deepEqual([good.passed, good.reason_short, good.judge_cost_usd], [true, "judge pass", 0.01]);
    const rubric = personEval({ form_type: "rubric", rubric: { tone: "pass" } });
    const bad = await scoreOutput(rubric, "bad answer", { judge });
    assert.deepEqual([bad.passed, bad.reason_short], [false, "judge fail: no total"]);
    assert.deepEqual(seen, ["the input|good answer", "the input|bad answer"]);
  });

  it("checks must_never before the judge and does not call it", async () => {
    let called = false;
    const judge = async () => {
      called = true;
      return { ok: true as const, verdict: "pass" as const, reason: "", cost_usd: 0 };
    };
    const r = await scoreOutput(passMark, "you are an IDIOT", { judge, mustNever: "idiot" });
    assert.equal(r.passed, false);
    assert.equal(r.reason_short, "must_never hit");
    assert.equal(called, false);
  });

  it("keeps text, fields, and tool marks as direct comparisons", async () => {
    const judge = async () => {
      throw new Error("must not call");
    };
    const r = await scoreOutput(personEval({ form_type: "text", expected_text: "Hi" }), "Hi", { judge });
    assert.deepEqual([r.passed, r.reason_short], [true, "matches trusted text"]);
  });

  it("returns an error, not a fail, when the judge reply is bad or the cap stops it", async () => {
    const bad = await scoreOutput(passMark, "x", {
      judge: async () => ({ ok: false, error: "bad_reply", cost_usd: 0.002 }),
    });
    assert.deepEqual([bad.error, bad.reason_short, bad.judge_cost_usd], [true, "judge reply not valid", 0.002]);
    const cap = await scoreOutput(passMark, "x", { judge: async () => "cap" as const });
    assert.deepEqual([cap.error, cap.cap_hit], [true, true]);
  });
});
