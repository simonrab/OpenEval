# Handoff: slice 10

Status: passed
Next: stop — v0 slices 0–10 complete. M7 extras wait for user.

## Done-when (from BUILD.md)

- [x] Recheck on frozen ste_ + named model → same evals/scoring, pass/fail/time/cost, no new name, live traffic unchanged
- [x] Named model fails → need_new_model, build fails, .env untouched
- [x] new_failures not in set → evals_missing_new_failures, not a pass
- [x] Cost cap mid-run → partial stored, build fails, live traffic unchanged

## Evidence

- Tests: `npm test` → 203 pass, 0 fail
- `examples/ci-recheck.sh` calls run_evals (recheck) + get_eval_report only; exits ci_exit; no recommend_models; no .env write
- `src/ci/exit.ts` maps report to ci_exit per spec §13
- Reviewer: pass

## Blockers for next slice

None for slice 10. **Do not auto-start M7** — wait for user before spec-gap extras (BUILD.md M7 week 6).

## Notes

Full v0 spine shipped: health/auth → seven tools → keys → generate/accept → run/report → recommend/approve → MCP → mark → register_failure → add_feature → CI recheck.

User `.env`: EVALROUTER_KEY + OPENROUTER_API_KEY. Store OpenRouter as pkr_ via POST /v1/keys before eval runs.

Run serve: `npm start`. MCP: `npm run mcp` with examples/mcp.json. CI: `examples/ci-recheck.sh`.
