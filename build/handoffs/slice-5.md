# Handoff: slice 5

Status: passed
Next: slice 6 (started at once)

## Done-when (from BUILD.md)

- [x] Trusted eval set + limits → run_evals, poll, recommend_models (new_feature) → rec_ + model id or does_not_work
- [x] Too few trusted evals → need_more_evals, no fake name
- [x] Approve → EvalRouter does not write customer .env
- [x] max_wait_ms drop; failed models never named or backup

## Evidence

- Tests: `npm test` → 137 pass, 0 fail
- Demo: inject flow project → run → recommend → GET/POST /approve; live_traffic_changed false; rec_ in SQLite
- Reviewer: pass

## Blockers for next slice

None.

## Notes for implementer of N+1

Live tools: `generate_eval_suite`, `run_evals`, `get_eval_report`, `recommend_models`. Still NOT_BUILT: `queue_for_labeling`, `get_label_status`, `register_failure`.

Slice 6 is MCP. Stdio MCP server as HTTP client of `serve`. Same JSON as `POST /v1/tools/{name}`. Same Zod schemas from `src/tools/schema.ts`. Do not fork handlers. Do not let MCP child open SQLite while serve runs.

Register all seven tool names. Unbuilt tools return slice 1 NOT_BUILT envelope over MCP too.

Env: `EVALROUTER_URL`, `EVALROUTER_KEY`. Add `examples/mcp.json` for Cursor.

Do not edit `EVALROUTER_REQUIREMENTS.md` or `spec/`.
