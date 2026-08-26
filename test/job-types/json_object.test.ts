import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isJsonObjectJob } from "../../src/job-types/json_object.js";

describe("isJsonObjectJob", () => {
  it("matches structural JSON signals", () => {
    assert.equal(
      isJsonObjectJob("Return JSON with `line_items[]` and `total_cents`."),
      true,
    );
    assert.equal(isJsonObjectJob("return a json object with fields"), true);
    assert.equal(isJsonObjectJob("output must include line_items"), true);
    assert.equal(isJsonObjectJob("put total_cents on the object"), true);
  });

  it("does not fake a match on invoice or PDF extract", () => {
    assert.equal(
      isJsonObjectJob("Extract fields from PDF invoices without a fixed schema"),
      false,
    );
    assert.equal(isJsonObjectJob("invoice processing for the finance team"), false);
  });

  it("still matches a mixed JSON plus tone job", () => {
    assert.equal(
      isJsonObjectJob("Return JSON with line_items and a warm friendly tone"),
      true,
    );
  });
});
