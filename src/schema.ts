import { z } from "zod";

const nonEmpty = z.string().max(16000).refine((value) => value.trim().length > 0);

export const markKindSchema = z.enum(["option", "constraint", "fact"]);
export const sessionModeSchema = z.enum(["ideaKing", "lattice"]);
export const optionRoleSchema = z.enum(["literal", "spark"]);
export const conditionCodeSchema = z.enum(["join", "not_literal", "try", "memory"]);
export const deliveryStatusSchema = z.enum([
  "incomplete",
  "selected",
  "delivered",
  "refused",
]);
export const audienceProvenanceSchema = z.enum(["real", "sim", "unknown"]);
export const crewPhaseSchema = z.enum([
  "spark",
  "think",
  "make",
  "finish",
  "commit",
  "done",
]);
export const callerRoleSchema = z.enum([
  "spark",
  "gather",
  "analyze",
  "critique",
  "maker",
  "finisher",
  "host",
]);
export const productTypeSchema = z.enum(["page", "cli"]);

export const draftMarkSchema = z.object({
  kind: markKindSchema,
  text: z.string(),
  role: optionRoleSchema.optional(),
  code: conditionCodeSchema.optional(),
});

export const sourceMarkSchema = z.object({
  id: z.string(),
  kind: markKindSchema,
  text: z.string(),
  scent: z.literal(1),
  role: optionRoleSchema.nullable().default(null),
  code: conditionCodeSchema.nullable().default(null),
  replacedId: z.string().nullable().default(null),
});

export const quoteSchema = z.object({
  markId: z.string(),
  optionId: z.string(),
  quote: z.string(),
  relation: z.enum(["supports", "contradicts"]),
});

export const quotesPayloadSchema = z.object({
  quotes: z.array(quoteSchema),
});

export const cellSchema = z.object({
  markId: z.string(),
  optionId: z.string(),
  status: z.enum(["supported", "missing", "contradicts"]),
  scent: z.union([z.literal(0), z.literal(1)]),
  evidenceQuote: z.string().nullable(),
});

export const evidenceSchema = z.object({
  id: z.string().default(() => ""),
  kind: z.enum(["file", "run", "grab", "think", "accept"]),
  path: z.string(),
  text: z.string(),
  exitCode: z.number().int().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable().default(null),
  role: z.string().nullable().default(null),
  contentHash: z.string().nullable().default(null),
  byteLength: z.number().int().nonnegative().nullable().default(null),
  realPath: z.string().nullable().default(null),
  inode: z.string().nullable().default(null),
  materialHash: z.string().nullable().default(null),
  dependencyHashes: z.array(z.string()).nullable().default(null),
  acceptOk: z.boolean().nullable().default(null),
  stale: z.boolean().nullable().default(null),
  runId: z.string().nullable().default(null),
  manifestHash: z.string().nullable().default(null),
  snapshotFiles: z.array(z.object({path: z.string(), hash: z.string(), text: z.string()})).optional(),
});

const pageStepSchema = z.object({
  op: z.enum(["fill", "click", "select"]),
  selector: z.string().min(1).max(256),
  value: z.string().max(4000).optional(),
}).strict();
const pageAssertionSchema = z.object({
  selector: z.string().min(1).max(256),
  text: z.string().max(16000).optional(),
  value: z.string().max(16000).optional(),
}).strict().refine((value) => value.text !== undefined || value.value !== undefined);

export const productManifestSchema = z.object({
  type: productTypeSchema,
  entry: z.string().min(1).max(1024),
  inputs: z.array(z.string().max(4000)).max(8).default([]),
  expected: z
    .object({
      schema: z.enum(["json", "text"]).optional(),
      cases: z.array(z.object({input: z.string().max(4000), output: z.unknown()}).strict()).max(8).optional(),
      pageCases: z.array(z.object({steps: z.array(pageStepSchema).min(1).max(12), assertion: pageAssertionSchema}).strict()).max(8).optional(),
    }).strict()
    .default({}),
  action: z.string().max(1000).optional(),
}).strict();

export const audienceSchema = z.object({
  firstStop: nonEmpty,
  skipped: nonEmpty,
  remembered: nonEmpty,
  provenance: audienceProvenanceSchema.default("unknown"),
  artifactHash: z.string().nullable().default(null),
  receipt: z.string().max(12000).nullable().default(null),
});

export const crewMemberSchema = z.object({
  role: callerRoleSchema,
  slot: z.number().int().nonnegative(),
});

export const crewPlanSchema = z.object({
  size: z.number().int().min(3).max(12),
  members: z.array(crewMemberSchema),
  maxRevisions: z.number().int().positive().default(3),
  maxVoid: z.number().int().positive().default(2),
  wallClockMs: z.number().int().positive().default(30 * 60 * 1000),
});

export const taskLogEntrySchema = z.object({
  id: z.string(),
  role: callerRoleSchema,
  phase: crewPhaseSchema,
  tool: z.string(),
  at: z.number().int().nonnegative(),
  ok: z.boolean(),
  slot: z.number().int().nonnegative().nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
});

export const verdictSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("select"),
    optionId: z.string(),
    decidingMarkId: z.string(),
  }),
  z.object({
    type: z.literal("refuse"),
    missingMarkId: z.string(),
  }),
  z.object({
    type: z.literal("refuse_tie"),
  }),
]);

export const sessionSchema = z.object({
  id: z.string(),
  mode: sessionModeSchema.default("lattice"),
  userText: z.string(),
  material: z.string(),
  initialMaterial: z.string().default(""),
  evidence: z.array(evidenceSchema).default([]),
  draftMarks: z.array(draftMarkSchema),
  marks: z.array(sourceMarkSchema),
  cells: z.array(cellSchema),
  lastRoundCells: z.array(cellSchema),
  audience: audienceSchema.nullable(),
  verdict: verdictSchema.nullable(),
  deliveryStatus: deliveryStatusSchema.default("incomplete"),
  discardedText: z.string().nullable(),
  voidCount: z.number().int().nonnegative(),
  stopped: z.boolean(),
  revision: z.number().int().nonnegative().default(0),
  crewSize: z.number().int().min(3).max(12).default(5),
  crewPlan: crewPlanSchema.nullable().default(null),
  phase: crewPhaseSchema.default("spark"),
  taskLog: z.array(taskLogEntrySchema).default([]),
  createdAt: z.number().int().nonnegative().default(0),
  revisionCount: z.number().int().nonnegative().default(0),
  productManifest: productManifestSchema.nullable().default(null),
  materialHash: z.string().nullable().default(null),
  observerPublicKey: z.string().nullable().default(null),
});

export const toolErrorSchema = z.enum([
  "bad_request",
  "not_found",
  "marks_not_frozen",
  "need_two_options",
  "stopped",
  "phase_denied",
  "role_denied",
  "accept_failed",
  "limit_exceeded",
  "unknown_flag",
  "duplicate_flag",
  "revision_conflict",
  "sandbox_failed",
]);

export type DraftMark = z.infer<typeof draftMarkSchema>;
export type SourceMark = z.infer<typeof sourceMarkSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type Cell = z.infer<typeof cellSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type AudienceReport = z.infer<typeof audienceSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type ToolError = z.infer<typeof toolErrorSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type OptionRole = z.infer<typeof optionRoleSchema>;
export type ConditionCode = z.infer<typeof conditionCodeSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type AudienceProvenance = z.infer<typeof audienceProvenanceSchema>;
export type CrewPhase = z.infer<typeof crewPhaseSchema>;
export type CallerRole = z.infer<typeof callerRoleSchema>;
export type ProductManifest = z.infer<typeof productManifestSchema>;
export type CrewPlan = z.infer<typeof crewPlanSchema>;
export type TaskLogEntry = z.infer<typeof taskLogEntrySchema>;

export type MarkInput = DraftMark & { id?: string };
