import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

async function main(): Promise<void> {
  const apiKey = process.env.EVALROUTER_KEY;
  if (!apiKey) {
    console.error("EVALROUTER_KEY is required");
    process.exit(1);
  }

  const baseUrl = process.env.EVALROUTER_URL ?? "http://127.0.0.1:3000";
  const server = createMcpServer({ baseUrl, apiKey });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
