import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { scoreFixture } from "../../src/scoring/fixture.js";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

for (const name of [
  "pass-always.sh",
  "fail-always.sh",
  "check-stdin-contains.sh",
  "sleep-forever.sh",
]) {
  chmodSync(join(FIXTURE_ROOT, name), 0o755);
}

describe("scoreFixture", () => {
  it("passes when fixture script exits 0", () => {
    const r = scoreFixture("anything", {
      path: "pass-always.sh",
      root: FIXTURE_ROOT,
    });
    assert.equal(r.passed, true);
    assert.match(r.reason_short, /pass-always\.sh/);
  });

  it("fails when fixture script exits non-zero", () => {
    const r = scoreFixture("anything", {
      path: "fail-always.sh",
      root: FIXTURE_ROOT,
    });
    assert.equal(r.passed, false);
    assert.match(r.reason_short, /fail-always\.sh/);
  });

  it("passes model output on stdin to the fixture script", () => {
    const pass = scoreFixture("hello PASS world", {
      path: "check-stdin-contains.sh",
      root: FIXTURE_ROOT,
    });
    assert.equal(pass.passed, true);

    const fail = scoreFixture("no match", {
      path: "check-stdin-contains.sh",
      root: FIXTURE_ROOT,
    });
    assert.equal(fail.passed, false);
  });

  it("fails closed on timeout", () => {
    const r = scoreFixture("x", {
      path: "sleep-forever.sh",
      root: FIXTURE_ROOT,
      timeout_ms: 200,
    });
    assert.equal(r.passed, false);
    assert.match(r.reason_short, /timeout/i);
  });

  it("fails when fixture path is missing", () => {
    const r = scoreFixture("x", {
      path: "no-such-fixture.sh",
      root: FIXTURE_ROOT,
    });
    assert.equal(r.passed, false);
    assert.match(r.reason_short, /missing/i);
  });

  it("fails on bad spec", () => {
    const r = scoreFixture("x", {});
    assert.equal(r.passed, false);
    assert.match(r.reason_short, /bad fixture/i);
  });

  it("reason_short never echoes model output", () => {
    const secret = "sk-secret-should-not-appear";
    const r = scoreFixture(secret, {
      path: "fail-always.sh",
      root: FIXTURE_ROOT,
    });
    assert.equal(r.passed, false);
    assert.doesNotMatch(r.reason_short, /sk-secret/);
  });
});
