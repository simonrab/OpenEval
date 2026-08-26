# Handoff: After M7

Status: passed
Next: stop — wait for the user. Do not auto-start further work.

## Done-when (from BUILD.md After M7)

- [x] Retire an old eval: `generate_eval_suite` with `retire_eval_ids` copy-forwards to a new `ste_` and omits those `cas_` ids. History is not deleted. Old `ste_` is unchanged.
- [x] Known job types: extract, tone, and image/PDF. Detection uses structural signals. Bare `"invoice"` is still not a known type.
- [x] Region mark on image/PDF when the job needs a location. Region is extra payload on the mark, not `form_type: "file"`.

## Evidence

- Tests: `npm test` → 312 pass, 0 fail
- Spec freeze: `EVALROUTER_REQUIREMENTS.md` and `spec/` not edited
- Still seven agent tools. No dashboard or React app
- Reviewer: pass

## Blockers for next slice

None. Stop and wait for the user.

## Notes

Retire is not an eighth tool. Call `generate_eval_suite` with `eval_set_id`, `retire_eval_ids`, and `idempotency_key`. Combine with `intent: "add_feature"` to add drafts and omit retired ids in one new version.

Region is `{ x, y, width, height }` on the mark. Two people agree if each edge differs by at most `region_tolerance` (default 8px).
