import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  imagePdfDrafts,
  isImagePdfJob,
} from "../../src/job-types/image_pdf.js";
import { isJsonObjectJob } from "../../src/job-types/json_object.js";

describe("isImagePdfJob", () => {
  it("matches image sample plus judgment language", () => {
    assert.equal(
      isImagePdfJob("Judge whether this invoice photo is readable", {
        sampleFiles: [{ path: "fixtures/invoice.png", content: "x" }],
      }),
      true,
    );
  });

  it("matches needs_images plus judgment", () => {
    assert.equal(
      isImagePdfJob("Judge if the screenshot is appropriate", {
        needs_images: true,
      }),
      true,
    );
  });

  it("matches a description that is clearly image or PDF judgment", () => {
    assert.equal(
      isImagePdfJob("Judge this PDF page: is the stamp readable?"),
      true,
    );
  });

  it("does not match unstructured PDF extract or bare invoice", () => {
    assert.equal(
      isImagePdfJob("Extract fields from PDF invoices without a fixed schema"),
      false,
    );
    assert.equal(isImagePdfJob("invoice"), false);
    assert.equal(isJsonObjectJob("invoice"), false);
  });

  it("does not match a PNG sample without judgment", () => {
    assert.equal(
      isImagePdfJob("Return JSON with line_items and total_cents", {
        sampleFiles: [{ path: "fixtures/invoice.png", content: "x" }],
      }),
      false,
    );
  });
});

describe("imagePdfDrafts", () => {
  it("writes person evals without form_type file", () => {
    const drafts = imagePdfDrafts({
      description: "Judge whether this invoice photo is readable",
    });
    assert.ok(drafts.length > 0);
    for (const d of drafts) {
      assert.equal(d.score_how, "person");
      assert.equal(d.status, "draft");
      assert.notEqual(d.form_type, "file");
    }
  });

  it("sets needs_region when the job asks for a location", () => {
    const drafts = imagePdfDrafts({
      description:
        "Judge this invoice image and mark the bounding box where the total is",
    });
    const spec = drafts[0]?.form_spec as
      | { needs_region?: boolean; region_tolerance?: number }
      | undefined;
    assert.equal(spec?.needs_region, true);
    assert.equal(spec?.region_tolerance, 8);
  });
});
