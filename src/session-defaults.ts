import type { AudienceReport, Evidence, Session } from "./schema.ts";

export function evidenceDefaults(
  partial: Omit<Evidence, "inode" | "materialHash" | "dependencyHashes" | "acceptOk" | "stale" | "runId" | "manifestHash"> &
    Partial<
      Pick<Evidence, "inode" | "materialHash" | "dependencyHashes" | "acceptOk" | "stale" | "runId" | "manifestHash">
    >,
): Evidence {
  return {
    inode: null,
    materialHash: null,
    dependencyHashes: null,
    acceptOk: null,
    stale: false,
    runId: null,
    manifestHash: null,
    ...partial,
  };
}

export function audienceDefaults(
  partial: Pick<AudienceReport, "firstStop" | "skipped" | "remembered"> &
    Partial<Pick<AudienceReport, "provenance" | "artifactHash" | "receipt">>,
): AudienceReport {
  return {
    provenance: "unknown",
    artifactHash: null,
    receipt: null,
    ...partial,
  };
}

export function sessionDefaults(
  partial: Pick<
    Session,
    | "id"
    | "userText"
    | "material"
    | "draftMarks"
    | "marks"
    | "cells"
    | "lastRoundCells"
    | "audience"
    | "verdict"
    | "discardedText"
    | "voidCount"
    | "stopped"
  > &
    Partial<Session>,
): Session {
  return {
    mode: "lattice",
    initialMaterial: partial.initialMaterial ?? partial.material ?? "",
    evidence: [],
    deliveryStatus: "incomplete",
    revision: 0,
    crewSize: 5,
    crewPlan: null,
    phase: "spark",
    taskLog: [],
    createdAt: 0,
    revisionCount: 0,
    productManifest: null,
    materialHash: null,
    ...partial,
    observerPublicKey: partial.observerPublicKey ?? null,
  };
}
