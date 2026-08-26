import { isImageOrPdfPath } from "../eval-files.js";
import { truncateInput, type DraftEval } from "../eval-set.js";

const JUDGMENT_RE = /\b(judge|judgment|readable|appropriate)\b/i;
const IMAGE_WORD_RE = /\b(image|photo|screenshot|pdf|png)\b/i;
const LOCATION_RE =
  /\b(location|region|bounding box|where on the image|where the)\b/i;

export const DEFAULT_REGION_TOLERANCE = 8;

export type ImagePdfExtras = {
  needs_images?: boolean;
  sampleFiles?: Array<{ path: string; content?: string }>;
};

export function jobNeedsLocation(description: string): boolean {
  return LOCATION_RE.test(description);
}

export function isImagePdfJob(
  description: string | undefined,
  extras?: ImagePdfExtras,
): boolean {
  if (!description) {
    return false;
  }
  const hasJudgment = JUDGMENT_RE.test(description);
  const hasSample = extras?.sampleFiles?.some((f) => isImageOrPdfPath(f.path)) ?? false;
  const hasNeeds = extras?.needs_images === true;
  if (hasSample && hasJudgment) {
    return true;
  }
  if (hasNeeds && hasJudgment) {
    return true;
  }
  if (IMAGE_WORD_RE.test(description) && hasJudgment) {
    return true;
  }
  return false;
}

export function imagePdfDrafts(opts: { description: string }): DraftEval[] {
  const needsRegion = jobNeedsLocation(opts.description);
  return [
    {
      title: "Image or PDF judgment",
      score_how: "person",
      status: "draft",
      program_check: null,
      input_truncated: truncateInput(opts.description),
      form_type: "pass_fail",
      form_spec: needsRegion
        ? {
            needs_region: true,
            region_tolerance: DEFAULT_REGION_TOLERANCE,
          }
        : undefined,
    },
  ];
}
