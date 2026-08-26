import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SHORT_LIST_SIZE,
  parseOpenRouterModels,
  pickDefaultModels,
  type CatalogModel,
} from "../src/runner/catalog.js";

function model(
  id: string,
  opts: Partial<CatalogModel> = {},
): CatalogModel {
  return {
    id,
    supportsImages: opts.supportsImages ?? false,
    inputModalities: opts.inputModalities ?? ["text"],
    listCostPer1kUsd: opts.listCostPer1kUsd ?? 0.001,
    created: opts.created ?? 1_700_000_000,
  };
}

/** Stale frozen ids that v0 shipped, plus current cheap ids. */
const MIXED_CATALOG: CatalogModel[] = [
  model("openai/gpt-4.1-nano", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.0001,
    created: 1_740_000_000,
  }),
  model("google/gemini-2.5-flash", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.00015,
    created: 1_741_000_000,
  }),
  model("anthropic/claude-haiku-4.5", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.0004,
    created: 1_742_000_000,
  }),
  model("mistralai/mistral-small-3.1", {
    listCostPer1kUsd: 0.00008,
    created: 1_740_500_000,
  }),
  model("meta-llama/llama-3.3-70b-instruct", {
    listCostPer1kUsd: 0.00012,
    created: 1_730_000_000,
  }),
  model("openai/gpt-4o-mini", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.0002,
    created: 1_720_000_000,
  }),
  model("google/gemini-flash-1.5", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.000075,
    created: 1_700_000_000,
  }),
  model("anthropic/claude-3-haiku", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.00025,
    created: 1_710_000_000,
  }),
  model("meta-llama/llama-3.1-8b-instruct", {
    listCostPer1kUsd: 0.00005,
    created: 1_715_000_000,
  }),
  model("mistralai/mistral-7b-instruct", {
    listCostPer1kUsd: 0.00006,
    created: 1_705_000_000,
  }),
  model("openai/gpt-4o", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0.005,
    created: 1_718_000_000,
  }),
  model("google/gemini-2.5-flash:free", {
    supportsImages: true,
    inputModalities: ["text", "image"],
    listCostPer1kUsd: 0,
    created: 1_741_000_000,
  }),
];

const STALE_DEFAULTS = [
  "openai/gpt-4o-mini",
  "google/gemini-flash-1.5",
  "anthropic/claude-3-haiku",
  "meta-llama/llama-3.1-8b-instruct",
  "mistralai/mistral-7b-instruct",
];

describe("pickDefaultModels (short list that fits limits)", () => {
  it("returns at most 5 ids", () => {
    const picked = pickDefaultModels(MIXED_CATALOG, null);
    assert.equal(picked.length, DEFAULT_SHORT_LIST_SIZE);
  });

  it("does not ship the frozen stale five when newer cheaper models exist", () => {
    const ids = pickDefaultModels(MIXED_CATALOG, null).map((m) => m.id);
    assert.ok(ids.includes("openai/gpt-4.1-nano"));
    assert.ok(ids.includes("google/gemini-2.5-flash"));
    assert.ok(ids.includes("mistralai/mistral-small-3.1"));
    assert.deepEqual(
      ids.filter((id) => STALE_DEFAULTS.includes(id)).sort(),
      [],
      `stale defaults leaked into short list: ${ids.join(",")}`,
    );
  });

  it("skips :free models when paid models fit", () => {
    const ids = pickDefaultModels(MIXED_CATALOG, null).map((m) => m.id);
    assert.ok(!ids.some((id) => id.endsWith(":free")));
  });

  it("drops models that cannot see images when needs_images", () => {
    const ids = pickDefaultModels(MIXED_CATALOG, {
      needs_images: true,
    }).map((m) => m.id);
    assert.ok(ids.includes("openai/gpt-4.1-nano"));
    assert.ok(ids.includes("google/gemini-2.5-flash"));
    assert.ok(!ids.includes("mistralai/mistral-small-3.1"));
    assert.ok(!ids.includes("meta-llama/llama-3.3-70b-instruct"));
  });

  it("respects allowed_models", () => {
    const ids = pickDefaultModels(MIXED_CATALOG, {
      allowed_models: ["openai/*"],
    }).map((m) => m.id);
    assert.ok(ids.length >= 1);
    assert.ok(ids.every((id) => id.startsWith("openai/")));
    assert.ok(ids.includes("openai/gpt-4.1-nano"));
  });

  it("respects excluded_models", () => {
    const ids = pickDefaultModels(MIXED_CATALOG, {
      excluded_models: ["openai/*"],
    }).map((m) => m.id);
    assert.ok(!ids.some((id) => id.startsWith("openai/")));
  });

  it("drops models over max_spend_usd_per_1k before the run", () => {
    const ids = pickDefaultModels(MIXED_CATALOG, {
      max_spend_usd_per_1k: 0.0002,
    }).map((m) => m.id);
    assert.ok(!ids.includes("openai/gpt-4o"));
    assert.ok(!ids.includes("anthropic/claude-haiku-4.5"));
    assert.ok(ids.includes("openai/gpt-4.1-nano"));
  });

  it("returns fewer than 5 when fewer models fit limits", () => {
    const picked = pickDefaultModels(MIXED_CATALOG, {
      allowed_models: ["openai/gpt-4.1-nano"],
    });
    assert.equal(picked.length, 1);
    assert.equal(picked[0]?.id, "openai/gpt-4.1-nano");
  });

  it("returns empty when nothing fits", () => {
    const picked = pickDefaultModels(MIXED_CATALOG, {
      allowed_models: ["this-vendor-does-not-exist/*"],
    });
    assert.equal(picked.length, 0);
  });
});

describe("parseOpenRouterModels", () => {
  it("reads id, image input, and list price from OpenRouter JSON", () => {
    const parsed = parseOpenRouterModels({
      data: [
        {
          id: "openai/gpt-4.1-nano",
          created: 1740000000,
          architecture: { input_modalities: ["text", "image"] },
          pricing: { prompt: "0.0000001", completion: "0.0000004" },
        },
        { id: "not-a-model" },
        { name: "missing-id" },
      ],
    });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.id, "openai/gpt-4.1-nano");
    assert.equal(parsed[0]?.supportsImages, true);
    assert.ok((parsed[0]?.listCostPer1kUsd ?? 0) > 0);
  });
});
