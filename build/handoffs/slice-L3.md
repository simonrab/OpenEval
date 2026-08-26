# Handoff: slice L3

Status: passed
Next: slice L4 (started at once)

## Done-when (from RUNTIME_BUILD.md)

- [x] Timeout
- [x] One backup
- [x] Stream pass-through
- [x] Fallback rate
- [x] R2 complete

## Evidence

- Tests: `npm test` — 370 pass, 0 fail.
- Demo: Primary 503 then backup 200. 429 retries. 400 does not retry. Timeout before first token tries backup. Stream error after first token does not try backup. `stats().fallback_rate` is set.
- Reviewer: pass ([Review](33165140-dc33-4387-b62a-867bed0f60a9))

## Blockers for next slice

None.

## Notes for implementer of L4

R3: redacted samples after the response. The request must not wait for upload.

A sample has redacted input, redacted output or error, `pol_`, failed model id, why (`vendor_error`, `timeout`, `app_reported`), and timestamp. Truncate. No traces. No headers. No cookies. Remove secret-shaped fields. Hash emails, phones, and card-like numbers.

Do not store a sample for a successful request.

If redaction cannot keep the example safe, drop it. Record `PII_BLOCKED`. Do not keep the raw example.

If upload fails, drop the sample. Do not fail the user.

If the control plane is down, write samples to disk. If the disk queue is full, drop samples.

Capture is not a fifth tool. Add ingest on the control plane. Do not add `promote_live_sample` (L5). Do not add a sample screen (L5).
