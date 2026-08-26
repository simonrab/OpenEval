# Handoff: slice 6

Status: passed
Next: slice 7 (started at once)

## Done-when (from BUILD.md)

- [x] Each MCP tool input schema equals the HTTP Zod schema
- [x] Round-trip MCP call ≡ POST /v1/tools/{name}
- [x] Auth: same API key via env on stdio process
- [x] Cursor MCP config in examples/mcp.json (all seven tools)

## Evidence

- Tests: `npm test` → 162 pass, 0 fail
- MCP is HTTP client only; no SQLite in src/mcp/*
- Reviewer: pass

## Blockers for next slice

None.

## Notes for implementer of N+1

Slice 7 is mark screen (J3): `queue_for_labeling`, `get_label_status`, mark/third HTML, dual-mark agreement, people table, marks, mark_queue.

queue_for_labeling only queues score_how person evals. Code evals never shown. Two people agree or third decides. Mark once per eval-set version.

generate_eval_suite already sets next_action to queue_for_labeling when n_person > 0; mark_url was null until now — implement signed mark_url tokens (HMAC).

Still NOT_BUILT: register_failure (slice 8).

Do not edit spec or spec/.
