import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isJsonObjectJob } from "../../src/job-types/json_object.js";
import { isToneJob, toneDrafts } from "../../src/job-types/tone.js";

describe("isToneJob", () => {
  it("matches tone, warm, friendly, and good reply", () => {
    assert.equal(isToneJob("Write a warm friendly reply"), true);
    assert.equal(isToneJob("Check the tone of the agent"), true);
    assert.equal(isToneJob("Was this a good reply?"), true);
  });

  it("does not match a JSON-only job", () => {
    assert.equal(
      isToneJob("Return JSON with `line_items[]` and `total_cents`."),
      false,
    );
  });

  it("still matches mixed JSON plus tone", () => {
    const mixed = "Return JSON with line_items and a warm friendly tone";
    assert.equal(isJsonObjectJob(mixed), true);
    assert.equal(isToneJob(mixed), true);
  });
});

describe("toneDrafts", () => {
  it("writes person rubric drafts with no program_check", () => {
    const drafts = toneDrafts({
      description: "Write a warm friendly good reply to the customer",
    });
    assert.ok(drafts.length > 0);
    for (const d of drafts) {
      assert.equal(d.score_how, "person");
      assert.equal(d.status, "draft");
      assert.equal(d.program_check, null);
      assert.equal(d.form_type, "rubric");
    }
    const spec = drafts[0]?.form_spec as { rubric?: string[] } | undefined;
    assert.ok(spec?.rubric?.includes("tone"));
    assert.ok(!JSON.stringify(spec).includes("1-5"));
  });
});
