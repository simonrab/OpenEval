import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatMcpToolContent } from "../src/mcp/server.js";

describe("MCP tool content for coding agents", () => {
  it("leads with a stop line and the accept URL", () => {
    const text = formatMcpToolContent({
      accept_url: "http://127.0.0.1:3000/accept?eval_set_id=ste_1&token=abc",
      next_action: {
        tool: null,
        args: {
          accept_url: "http://127.0.0.1:3000/accept?eval_set_id=ste_1&token=abc",
        },
        ask_human: "open accept_url",
      },
    });
    assert.match(text, /^Stop\. Show this URL to the user and wait: http:\/\/127\.0\.0\.1:3000\/accept/);
    assert.match(text, /"ask_human": "open accept_url"/);
  });

  it("leads with a stop line and the approve URL", () => {
    const text = formatMcpToolContent({
      named_model: { id: "openai/gpt-4.1-mini", backups: [] },
      approve_url: "http://127.0.0.1:3000/approve?recommendation_id=rec_1&token=xyz",
      next_action: {
        tool: null,
        args: {
          approve_url:
            "http://127.0.0.1:3000/approve?recommendation_id=rec_1&token=xyz",
        },
        ask_human: "open approve_url",
      },
    });
    assert.match(text, /^Stop\. Show this URL to the user and wait: http:\/\/127\.0\.0\.1:3000\/approve/);
  });

  it("names the next tool when the agent should continue", () => {
    const text = formatMcpToolContent({
      run_id: "run_1",
      next_action: {
        tool: "recommend_models",
        args: { project_id: "prj_1" },
        ask_human: null,
      },
    });
    assert.match(text, /^Next: call recommend_models\./);
  });
});
