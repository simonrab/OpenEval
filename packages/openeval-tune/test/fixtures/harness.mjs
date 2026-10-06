#!/usr/bin/env node
// A tiny app harness for tests. Mode is the first argument.
// It reads {eval_id, input, system_prompt, rep} on stdin and writes the output on stdout.
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  const item = JSON.parse(raw);
  const mode = process.argv[2] ?? "echo";
  if (mode === "echo") {
    process.stdout.write(`echo ${item.eval_id} rep ${item.rep} sp ${item.system_prompt ?? "none"}\n`);
    return;
  }
  if (mode === "good") {
    process.stderr.write(`OPENEVAL_USAGE {"cost_usd":0.001,"prompt_tokens":10,"completion_tokens":5,"served_model":"fake/model"}\n`);
    process.stdout.write("fine answer\n");
    return;
  }
  if (mode === "bad") {
    process.stderr.write(`OPENEVAL_USAGE {"cost_usd":0.001}\n`);
    process.stdout.write("BAD answer\n");
    return;
  }
  if (mode === "half") {
    // Fails on the first half of the evals by sorted id, rep does not matter.
    const n = Number(item.input.match(/input-(\d+)/)?.[1] ?? 0);
    process.stdout.write(n % 2 === 0 ? "BAD answer\n" : "fine answer\n");
    return;
  }
  if (mode === "sleep") {
    await new Promise((r) => setTimeout(r, Number(process.argv[3] ?? 300)));
    process.stdout.write("slept\n");
    return;
  }
  if (mode === "fail") {
    process.stderr.write("something broke\n");
    process.exit(3);
  }
  if (mode === "env") {
    process.stdout.write(
      JSON.stringify({
        key: process.env.OPENEVAL_KEY ?? null,
        admin: process.env.OPENEVAL_ADMIN_KEY ?? null,
        eval_id: process.env.OPENEVAL_EVAL_ID,
        rep: process.env.OPENEVAL_REP,
      }),
    );
    return;
  }
  if (mode === "costly") {
    process.stderr.write(`OPENEVAL_USAGE {"cost_usd":1}\n`);
    process.stdout.write("fine\n");
    return;
  }
  process.stdout.write("unknown mode\n");
});
