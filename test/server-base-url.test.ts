import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveBaseUrl } from "../src/server.js";

describe("server baseUrl", () => {
  it("derives from HOST and PORT when EVALROUTER_BASE_URL is unset", () => {
    assert.equal(
      deriveBaseUrl({
        HOST: "127.0.0.1",
        PORT: "3120",
      }),
      "http://127.0.0.1:3120",
    );
  });

  it("uses EVALROUTER_BASE_URL when set", () => {
    assert.equal(
      deriveBaseUrl({
        HOST: "127.0.0.1",
        PORT: "3120",
        EVALROUTER_BASE_URL: "https://evalrouter.example",
      }),
      "https://evalrouter.example",
    );
  });
});
