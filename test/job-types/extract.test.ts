import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractDrafts, isExtractJob } from "../../src/job-types/extract.js";
import { isJsonObjectJob } from "../../src/job-types/json_object.js";

describe("isExtractJob", () => {
  it("matches extract plus named fields", () => {
    assert.equal(
      isExtractJob("Extract named fields vendor and total from the document"),
      true,
    );
    assert.equal(
      isExtractJob("extract vendor, total, and date as expected values"),
      true,
    );
  });

  it("matches vendor plus total field paths", () => {
    assert.equal(
      isExtractJob("Read vendor and total from each line"),
      true,
    );
  });

  it("does not match bare invoice or unstructured extract", () => {
    assert.equal(isExtractJob("invoice"), false);
    assert.equal(
      isExtractJob("Extract fields from PDF invoices without a fixed schema"),
      false,
    );
    assert.equal(isExtractJob("invoice processing for the finance team"), false);
  });

  it("does not steal JSON-object jobs that already match structural JSON", () => {
    const jsonDesc = "Return JSON with `line_items[]` and `total_cents`.";
    assert.equal(isJsonObjectJob(jsonDesc), true);
  });
});

describe("extractDrafts", () => {
  it("writes field_equals code evals for named fields", () => {
    const drafts = extractDrafts({
      description: "Extract named fields vendor and total from the document",
    });
    const code = drafts.filter((d) => d.score_how === "code");
    assert.ok(code.length > 0);
    const paths = code
      .filter((d) => d.program_check?.kind === "field_equals")
      .map((d) => {
        const expected = d.program_check?.expected as { path?: string };
        return expected.path;
      });
    assert.ok(paths.includes("vendor"));
    assert.ok(paths.includes("total"));
    for (const d of code) {
      assert.equal(d.status, "draft");
    }
  });

  it("uses person fields form when there is no single right JSON", () => {
    const drafts = extractDrafts({
      description:
        "Extract named fields vendor and total with no single right JSON",
    });
    const person = drafts.filter((d) => d.score_how === "person");
    assert.ok(person.length > 0);
    assert.equal(person[0]?.form_type, "fields");
    assert.equal(person[0]?.program_check, null);
  });
});
