import { newIdempotencyKey, OpenEvalError, type OpenEvalClient } from "./client.js";
import { pollReport, UsageError, type Log } from "./ops.js";
import { findRun, saveState, type DirectSetup, type PromoteStage, type TuneState } from "./state.js";
import { EXIT } from "./verdict.js";

export type PromoteContext = {
  admin: OpenEvalClient;
  state: TuneState;
  stateDir: string;
  keysRef: string | null;
  pollMs: number;
  pollTimeoutMs: number;
  log: Log;
};

export type PromoteOutput = {
  exitCode: number;
  body: {
    stage: PromoteStage;
    done: boolean;
    waiting_for_person: boolean;
    approve_url: string | null;
    human_gate: string | null;
    next_command: string | null;
    note: string | null;
    details: Record<string, unknown>;
  };
};

const CONTINUE = "openeval-tune promote --continue";

const SYSTEM_PROMPT_NOTE =
  "The winning setup has a system prompt. The OpenEval SDK sends it only when you set applyPolicySystemPrompt: true. The proxy sends it only with the header x-openeval-apply-system-prompt: true. When it is sent, it replaces the system prompt of your app. Set the opt-in in app code before the canary.";

type LiveReport = {
  policy_id: string | null;
  candidate_id: string | null;
  canary: boolean;
  canary_candidate_id: string | null;
  observed_split: number;
  fallback_rate: number;
  sample_counts: { stored: number; dropped: number; pii_blocked: number };
};

function out(
  exitCode: number,
  stage: PromoteStage,
  fields: Partial<PromoteOutput["body"]>,
): PromoteOutput {
  return {
    exitCode,
    body: {
      stage,
      done: stage === "done",
      waiting_for_person: exitCode === EXIT.waiting_for_person,
      approve_url: null,
      human_gate: null,
      next_command: null,
      note: null,
      details: {},
      ...fields,
    },
  };
}

function setStage(ctx: PromoteContext, stage: PromoteStage, extra: Partial<NonNullable<TuneState["promote"]>> = {}) {
  const p = ctx.state.promote!;
  Object.assign(p, extra, { stage, updated_at: new Date().toISOString() });
  saveState(ctx.stateDir, ctx.state);
}

async function liveReport(ctx: PromoteContext): Promise<LiveReport> {
  return ctx.admin.tool<LiveReport>("get_live_report", { project_id: ctx.state.project_id, limit: 1 });
}

export type StartOptions = {
  runId: string;
  candidateId: string;
  setup?: DirectSetup;
  reuseRun: boolean;
  maxSpendUsd: number;
  intent: "new_feature" | "add_feature";
};

/** Start promotion: a confirm run, then recommend_models. Stops at the first human gate. */
export async function startPromote(ctx: PromoteContext, opts: StartOptions): Promise<PromoteOutput> {
  const { admin, state } = ctx;
  const record = findRun(state, { run_id: opts.runId, candidate_id: opts.candidateId });
  if (record?.mode === "harness" || opts.candidateId.startsWith("harness")) {
    throw new UsageError(
      "This candidate is a harness candidate. Its changes are in app code. Merge the branch to ship it. OpenEval Live promotes direct setups only: model, settings, and system prompt.",
    );
  }
  const setup = opts.setup ?? record?.setup;
  if (!setup && !opts.reuseRun) {
    throw new UsageError(
      "The state has no setup for this candidate. Pass --setup <json|file> with the model, settings, and system prompt.",
    );
  }

  let confirmRunId = opts.runId;
  if (!opts.reuseRun) {
    if (!ctx.keysRef) {
      throw new UsageError("Promotion needs a keys_ref. Set OPENEVAL_KEYS_REF or pass --keys-ref.");
    }
    const started = await admin.tool<{ run_id: string }>("run_evals", {
      project_id: state.project_id,
      eval_set_id: state.eval_set_id,
      candidates: [setup],
      reps: state.reps,
      max_eval_spend_usd: opts.maxSpendUsd,
      keys_ref: ctx.keysRef,
      idempotency_key: newIdempotencyKey(),
    });
    ctx.log(`Confirm run ${started.run_id} started with the full key. Waiting for the run.`);
    const report = await pollReport(admin, state.project_id, started.run_id, {
      intervalMs: ctx.pollMs,
      timeoutMs: ctx.pollTimeoutMs,
    });
    state.spend_usd = Math.round((state.spend_usd + (report.summary?.cost_usd ?? 0)) * 1e8) / 1e8;
    confirmRunId = started.run_id;
  }

  let rec: { recommendation_id: string; approve_url: string; named_model: { id: string } | null };
  try {
    rec = await admin.tool("recommend_models", {
      project_id: state.project_id,
      eval_set_id: state.eval_set_id,
      run_id: confirmRunId,
      intent: opts.intent,
      idempotency_key: newIdempotencyKey(),
    });
  } catch (err) {
    saveState(ctx.stateDir, state);
    if (err instanceof OpenEvalError && err.code === "does_not_work") {
      const failing = (err.body as { failing_eval_ids?: string[] } | null)?.failing_eval_ids ?? [];
      throw new UsageError(
        `OpenEval did not name this setup. It fails ${failing.length} trusted evals in run ${confirmRunId}. OpenEval names a setup only when it passes every trusted eval. Do not promote it.`,
      );
    }
    throw err;
  }

  state.promote = {
    stage: "await_recommendation_approval",
    run_id: opts.runId,
    candidate_id: opts.candidateId,
    confirm_run_id: confirmRunId,
    recommendation_id: rec.recommendation_id,
    policy_id: null,
    has_system_prompt: Boolean(setup?.system_prompt),
    approve_urls: { recommendation: rec.approve_url },
    updated_at: new Date().toISOString(),
  };
  saveState(ctx.stateDir, state);
  return out(EXIT.waiting_for_person, "await_recommendation_approval", {
    approve_url: rec.approve_url,
    human_gate:
      "Gate 1 of 4. A person opens approve_url and approves or rejects the named setup. The agent does not open it.",
    next_command: CONTINUE,
    details: {
      confirm_run_id: confirmRunId,
      recommendation_id: rec.recommendation_id,
      named_model: rec.named_model,
    },
  });
}

/** Go to the next step when the person approved the last gate. */
export async function continuePromote(
  ctx: PromoteContext,
  flags: { full: boolean; rollback: boolean },
): Promise<PromoteOutput> {
  const { admin, state } = ctx;
  const p = state.promote;
  if (!p) {
    throw new UsageError('There is no promotion in progress. Run "openeval-tune promote --run <id> --candidate <id>" first.');
  }
  const project_id = state.project_id;

  switch (p.stage) {
    case "await_recommendation_approval": {
      let policy: {
        policy_id: string;
        approve_url: string;
        primary: { has_system_prompt: boolean; candidate_id: string };
        system_prompt_note: string | null;
      };
      try {
        policy = await admin.tool("compile_policy", {
          project_id,
          recommendation_id: p.recommendation_id,
          eval_set_id: state.eval_set_id,
          idempotency_key: newIdempotencyKey(),
        });
      } catch (err) {
        if (err instanceof OpenEvalError && err.code === "REC_NOT_APPROVED") {
          return out(EXIT.waiting_for_person, p.stage, {
            approve_url: p.approve_urls.recommendation ?? null,
            human_gate:
              "No person approved the named setup yet. A person opens approve_url. If the person rejected it, stop.",
            next_command: CONTINUE,
          });
        }
        throw err;
      }
      setStage(ctx, "await_policy_approval", {
        policy_id: policy.policy_id,
        has_system_prompt: policy.primary.has_system_prompt,
        approve_urls: { ...p.approve_urls, policy: policy.approve_url },
      });
      return out(EXIT.waiting_for_person, "await_policy_approval", {
        approve_url: policy.approve_url,
        human_gate:
          "Gate 2 of 4. A person opens approve_url and approves the compiled policy. Live traffic does not change yet.",
        next_command: CONTINUE,
        note: policy.primary.has_system_prompt ? SYSTEM_PROMPT_NOTE : null,
        details: { policy_id: policy.policy_id, primary: policy.primary },
      });
    }

    case "await_policy_approval": {
      const live = await liveReport(ctx);
      if (live.policy_id === p.policy_id) {
        setStage(ctx, "done");
        return out(EXIT.ok, "done", {
          note: "This was the first approved policy for the project. It is now the last full policy. The SDK loads it. There is no canary step for a first policy.",
          details: { policy_id: p.policy_id },
        });
      }
      let rollout: { rollout_id: string; approve_url: string };
      try {
        rollout = await admin.tool("propose_rollout", {
          project_id,
          intent: "canary",
          idempotency_key: newIdempotencyKey(),
        });
      } catch (err) {
        if (err instanceof OpenEvalError && err.code === "POLICY_NOT_APPROVED") {
          return out(EXIT.waiting_for_person, p.stage, {
            approve_url: p.approve_urls.policy ?? null,
            human_gate:
              "No person approved the policy yet. A person opens approve_url. If the person rejected it, stop.",
            next_command: CONTINUE,
          });
        }
        throw err;
      }
      setStage(ctx, "await_canary_approval", {
        approve_urls: { ...p.approve_urls, canary: rollout.approve_url },
      });
      return out(EXIT.waiting_for_person, "await_canary_approval", {
        approve_url: rollout.approve_url,
        human_gate:
          "Gate 3 of 4. A person opens approve_url to start a 5% canary. Live traffic changes only after this approval.",
        next_command: CONTINUE,
        note: p.has_system_prompt ? SYSTEM_PROMPT_NOTE : null,
        details: { rollout_id: rollout.rollout_id },
      });
    }

    case "await_canary_approval": {
      const live = await liveReport(ctx);
      if (!live.canary) {
        return out(EXIT.waiting_for_person, p.stage, {
          approve_url: p.approve_urls.canary ?? null,
          human_gate: "The canary is not on yet. A person opens approve_url. If the person rejected it, stop.",
          next_command: CONTINUE,
        });
      }
      setStage(ctx, "canary_live");
      return canaryLive(live);
    }

    case "canary_live": {
      if (flags.full && flags.rollback) {
        throw new UsageError("Pass --full or --rollback, not both.");
      }
      if (!flags.full && !flags.rollback) {
        return canaryLive(await liveReport(ctx));
      }
      const intent = flags.full ? "full" : "rollback";
      const rollout = await admin.tool<{ rollout_id: string; approve_url: string }>("propose_rollout", {
        project_id,
        intent,
        idempotency_key: newIdempotencyKey(),
      });
      const stage = flags.full ? "await_full_approval" : "await_rollback_approval";
      setStage(ctx, stage, { approve_urls: { ...p.approve_urls, [intent]: rollout.approve_url } });
      return out(EXIT.waiting_for_person, stage, {
        approve_url: rollout.approve_url,
        human_gate: flags.full
          ? "Gate 4 of 4. A person opens approve_url to send all traffic to the new policy."
          : "A person opens approve_url to roll back to the last full policy.",
        next_command: CONTINUE,
        details: { rollout_id: rollout.rollout_id },
      });
    }

    case "await_full_approval": {
      const live = await liveReport(ctx);
      if (live.policy_id === p.policy_id) {
        setStage(ctx, "done");
        return out(EXIT.ok, "done", {
          note: "The new policy is the last full policy. All traffic uses it.",
          details: { policy_id: p.policy_id },
        });
      }
      return out(EXIT.waiting_for_person, p.stage, {
        approve_url: p.approve_urls.full ?? null,
        human_gate: "The full rollout is not approved yet. A person opens approve_url.",
        next_command: CONTINUE,
      });
    }

    case "await_rollback_approval": {
      const live = await liveReport(ctx);
      if (!live.canary && live.policy_id !== p.policy_id) {
        setStage(ctx, "done");
        return out(EXIT.ok, "done", {
          note: "The rollback is done. The last full policy is the old policy.",
          details: { policy_id: live.policy_id },
        });
      }
      return out(EXIT.waiting_for_person, p.stage, {
        approve_url: p.approve_urls.rollback ?? null,
        human_gate: "The rollback is not approved yet. A person opens approve_url.",
        next_command: CONTINUE,
      });
    }

    case "done":
      return out(EXIT.ok, "done", { note: "The promotion is done.", details: { policy_id: p.policy_id } });
  }
}

function canaryLive(live: LiveReport): PromoteOutput {
  return out(EXIT.waiting_for_person, "canary_live", {
    human_gate:
      "The 5% canary is on. A person reads the live report and decides. For all traffic, run the full command. To undo, run the rollback command.",
    next_command: `${CONTINUE} --full   (or: ${CONTINUE} --rollback)`,
    details: {
      canary_candidate_id: live.canary_candidate_id,
      observed_split: live.observed_split,
      fallback_rate: live.fallback_rate,
      sample_counts: live.sample_counts,
    },
  });
}
