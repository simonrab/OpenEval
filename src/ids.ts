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

export function newPolicyId(): string {
  return newId("pol_");
}

export function newSampleId(): string {
  return newId("smp_");
}

export function newRolloutId(): string {
  return newId("rlo_");
}

export function newAutomationId(): string {
  return newId("aut_");
}

export function newDecisionCycleId(): string {
  return newId("cyc_");
}

export function newAuditEventId(): string {
  return newId("aud_");
}

export function newSampleGroupId(): string {
  return newId("sgrp_");
}
