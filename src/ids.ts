import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

export function newProjectId(): string {
  return newId("prj_");
}

export function newKeysRefId(): string {
  return newId("pkr_");
}

export function newJobId(): string {
  return newId("job_");
}

export function newEvalSetId(): string {
  return newId("ste_");
}

export function newEvalId(): string {
  return newId("cas_");
}

export function newRunId(): string {
  return newId("run_");
}

export function newRecId(): string {
  return newId("rec_");
}

export function newPersonId(): string {
  return newId("per_");
}
