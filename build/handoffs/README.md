# Slice handoffs

The orchestrator writes one file per **passed** slice, then starts the next slice at once.

Path: `build/handoffs/slice-N.md`  
N is the slice that just passed (0 through 10).

Write this file only after the reviewer passes. Do not write it to skip a slice.

## Template

```markdown
# Handoff: slice N

Status: passed
Next: slice N+1 (started at once)

## Done-when (from BUILD.md)

- [ ] item
- [ ] item

## Evidence

- Tests: (command and result)
- Demo: (curl or note)
- Reviewer: pass

## Blockers for next slice

None. / Needs OpenRouter key. / User said stop.

## Notes for implementer of N+1

(short)
```

## Chain

`slice-0.md` written → start slice 1 → `slice-1.md` written → start slice 2 → … → `slice-10.md` written → stop and wait.

If review fails, do not write a handoff. Stay on the current slice.
