import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LiveSample } from "./redact.js";

const SPOOL_SUFFIX = ".json";

async function listSpoolNames(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names.filter((name) => name.endsWith(SPOOL_SUFFIX));
  } catch {
    return [];
  }
}

export async function writeSpoolSample(
  dir: string,
  sample: LiveSample,
  maxFiles: number,
): Promise<boolean> {
  await mkdir(dir, { recursive: true });
  const names = await listSpoolNames(dir);
  if (names.length >= maxFiles) {
    return false;
  }
  const path = join(dir, `${sample.sample_id}${SPOOL_SUFFIX}`);
  await writeFile(path, JSON.stringify(sample), "utf8");
  return true;
}

export async function readSpoolSamples(dir: string): Promise<LiveSample[]> {
  const names = await listSpoolNames(dir);
  const samples: LiveSample[] = [];
  for (const name of names) {
    try {
      const text = await readFile(join(dir, name), "utf8");
      samples.push(JSON.parse(text) as LiveSample);
    } catch {
      continue;
    }
  }
  return samples;
}

export async function removeSpoolSample(dir: string, sampleId: string): Promise<void> {
  try {
    await unlink(join(dir, `${sampleId}${SPOOL_SUFFIX}`));
  } catch {
    return;
  }
}
