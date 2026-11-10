import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registerManifest } from "./accept.ts";
import { activeTaskRole, appendTaskLog, enforceToolAccess, freezeCrewAtCreate, syncPhase } from "./crew.ts";
import {
  boardPathFor, depositFact, depositFile, depositGrab, depositRun, depositThink,
  freezeMarks, grabsReady, ideaKingMaterialReady, ideaKingTemplateMissing,
  invalidatePriorRuns, materialFromEvidence, validateDeliveryArtifacts, verdictSentence, writeBoard,
} from "./engine.ts";
import { resolveCrewSize } from "./labels.ts";
import { commitRound } from "./round.ts";
import { saveSession, updateSession } from "./session-store.ts";
import {
  callerRoleSchema, draftMarkSchema, productManifestSchema, sessionModeSchema,
  type CallerRole, type DraftMark, type ProductManifest, type Session, type SessionMode, type ToolError,
} from "./schema.ts";

export type ToolView = {
  error: ToolError | null;
  errorDetail: string | null;
  sessionId: string | null;
  sentence: string | null;
  boardPath: string | null;
  deliveryStatus: Session["deliveryStatus"] | null;
  revision: number | null;
  verdict: Session["verdict"];
  marks: Session["marks"];
  cells: Session["cells"];
  lastRoundCells: Session["lastRoundCells"];
  audience: Session["audience"];
  discardedText: string | null;
  evidence: Session["evidence"];
  budgetReady: boolean;
  voidCount: number;
  stopped: boolean;
  retry: boolean;
  phase: Session["phase"] | null;
};

function view(session: Session | undefined, root: string, error?: ToolError, errorDetail?: string): ToolView {
  return {
    error: error ?? null,
    errorDetail: errorDetail ?? (error ? error : null),
    sessionId: session?.id ?? null,
    sentence: session ? verdictSentence(session, root) : null,
    boardPath: session ? boardPathFor(session) : null,
    deliveryStatus: session?.deliveryStatus ?? null,
    revision: session?.revision ?? null,
    verdict: session?.verdict ?? null,
    marks: session?.marks ?? [],
    cells: session?.cells ?? [],
    lastRoundCells: session?.lastRoundCells ?? [],
    audience: session?.audience ?? null,
    discardedText: session?.discardedText ?? null,
    evidence: session?.evidence ?? [],
    budgetReady: session ? grabsReady(session.evidence) : false,
    voidCount: session?.voidCount ?? 0,
    stopped: session?.stopped ?? false,
    retry: Boolean(session && !error && !session.stopped && session.verdict === null && session.voidCount === 1),
    phase: session?.phase ?? null,
  };
}

function emptySession(userText: string, material: string, mode: SessionMode, crewSize: number): Session {
  const base: Session = {
    id: `s_${randomUUID()}`,
    mode,
    userText,
    initialMaterial: material,
    material,
    evidence: [],
    draftMarks: [],
    marks: [],
    cells: [],
    lastRoundCells: [],
    audience: null,
    verdict: null,
    deliveryStatus: "incomplete",
    discardedText: null,
    voidCount: 0,
    stopped: false,
    revision: 0,
    crewSize,
    crewPlan: null,
    phase: "spark",
    taskLog: [],
    createdAt: Date.now(),
    revisionCount: 0,
    productManifest: null,
    materialHash: null,
    observerPublicKey: null,
  };
  return freezeCrewAtCreate(base, crewSize);
}

type RoleInput = { callerRole?: CallerRole };
const identityShape = {
  sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  callerRole: callerRoleSchema.optional(),
};
const createInputSchema = z.object({ userText: z.string(), material: z.string().optional(), mode: sessionModeSchema.optional() });
const marksInputSchema = z.object({ ...identityShape, marks: z.array(draftMarkSchema) });
const textInputSchema = z.object({ ...identityShape, text: z.string() });
const grabInputSchema = z.object({ ...identityShape, path: z.string(), text: z.string() });
const thinkInputSchema = z.object({ ...identityShape, text: z.string(), role: z.string().optional() });
const pathInputSchema = z.object({ ...identityShape, path: z.string() });
const manifestInputSchema = z.object({ ...identityShape, manifest: productManifestSchema });
const commitInputSchema = z.object({ ...identityShape, quotes: z.string(), audience: z.string() });
type Outcome = { error?: ToolError; detail?: string };
type Mutation = { session: Session; error?: ToolError; detail?: string; persist?: boolean };

async function mutate(
  input: { sessionId: string } & RoleInput,
  tool: string,
  root: string,
  operation: (current: Session) => Mutation | Promise<Mutation>,
): Promise<ToolView> {
  const transaction = await updateSession<Outcome>(input.sessionId, async (current) => {
    const denied = enforceToolAccess(syncPhase(current), tool, input.callerRole);
    if (denied) return { session: current, value: { error: denied, detail: `tool=${tool} phase=${current.phase}` }, persist: false };
    const result = await operation(current);
    if (result.error && result.persist !== true) {
      return { session: current, value: { error: result.error, detail: result.detail }, persist: false };
    }
    let next = syncPhase(result.session);
    next = appendTaskLog(next, {
      role: activeTaskRole(current, tool),
      phase: next.phase,
      tool,
      ok: !result.error,
    });
    next = syncPhase(next);
    return { session: next, value: { error: result.error, detail: result.error ? result.detail : undefined } };
  }, root, (saved) => writeBoard(saved, root));
  if (!transaction) return view(undefined, root, "not_found");
  return view(transaction.session, root, transaction.value.error, transaction.value.detail);
}

export async function createSession(input: { userText: string; material?: string; mode?: SessionMode }, root = process.cwd()): Promise<ToolView> {
  const parsed = createInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_create_input");
  const userText = parsed.data.userText.trim();
  if (!userText) return view(undefined, root, "bad_request", "empty_user_text");
  const session = emptySession(userText, parsed.data.material ?? "", parsed.data.mode ?? "ideaKing", resolveCrewSize(root));
  const saved = await saveSession(session, root);
  await writeBoard(saved, root);
  return view(saved, root);
}

export async function confirmMarks(input: { sessionId: string; marks: DraftMark[] } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = marksInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_marks_input");
  return mutate(parsed.data, "confirm_marks", root, (current) => {
    if (current.mode === "ideaKing" && parsed.data.marks.filter((mark) => mark.kind === "option").length !== 2) {
      return { session: current, error: "bad_request", detail: "ideaKing_requires_exactly_two_options" };
    }
    const frozen = freezeMarks(current, parsed.data.marks, { allowRevisionReset: true });
    if (ideaKingTemplateMissing(frozen.session.marks, frozen.session.mode).length > 0) {
      return { session: current, error: "bad_request", detail: "ideaKing_template_incomplete" };
    }
    if (current.mode === "ideaKing" && !ideaKingMaterialReady(frozen.session, frozen.session.marks)) {
      return { session: current, error: "bad_request", detail: "ideaKing_material_not_ready" };
    }
    const changed = JSON.stringify(current.marks) !== JSON.stringify(frozen.session.marks);
    return { session: changed ? invalidatePriorRuns(frozen.session) : frozen.session };
  });
}

export async function addFact(input: { sessionId: string; text: string } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = textInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_fact_input");
  return mutate(parsed.data, "add_fact", root, (current) => {
    const added = depositFact(current, parsed.data.text);
    if (added.error) return { ...added, detail: "empty_fact" };
    const changed = JSON.stringify(current.marks) !== JSON.stringify(added.session.marks);
    return { session: changed ? invalidatePriorRuns(added.session) : added.session };
  });
}

export async function depositGrabFact(input: { sessionId: string; path: string; text: string } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = grabInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_grab_input");
  return mutate(parsed.data, "deposit_grab", root, async (current) => ({ ...await depositGrab(current, parsed.data.path, parsed.data.text, root), detail: "grab_rejected" }));
}

export async function depositThinkFact(input: { sessionId: string; text: string; role?: string } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = thinkInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_think_input");
  return mutate(parsed.data, "deposit_think", root, async (current) => ({ ...await depositThink(current, parsed.data.text, root, current.mode === "ideaKing" ? activeTaskRole(current, "deposit_think") : parsed.data.role), detail: "think_rejected" }));
}

export async function depositFileFact(input: { sessionId: string; path: string } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = pathInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_file_input");
  return mutate(parsed.data, "deposit_file", root, async (current) => ({ ...await depositFile(current, parsed.data.path, root), detail: "file_rejected" }));
}

export async function depositManifestFact(input: { sessionId: string; manifest: ProductManifest } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = manifestInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_manifest_input");
  return mutate(parsed.data, "deposit_manifest", root, async (current) => {
    const registered = await registerManifest(current, parsed.data.manifest, root);
    if (registered.error) return { ...registered, detail: "manifest_rejected" };
    const changed = JSON.stringify(current.productManifest) !== JSON.stringify(registered.session.productManifest);
    return { session: changed ? invalidatePriorRuns(registered.session) : registered.session };
  });
}

export async function depositRunFact(input: { sessionId: string; path: string } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = pathInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_run_input");
  return mutate(parsed.data, "deposit_run", root, async (current) => ({ ...await depositRun(current, parsed.data.path, root), detail: "run_or_accept_rejected" }));
}

export async function commitSessionRound(input: { sessionId: string; quotes: string; audience: string } & RoleInput, root = process.cwd()): Promise<ToolView> {
  const parsed = commitInputSchema.safeParse(input);
  if (!parsed.success) return view(undefined, root, "bad_request", "invalid_commit_input");
  return mutate(parsed.data, "commit_round", root, async (current) => {
    let working = current;
    const hadAccepted = current.evidence.some((item) => item.acceptOk === true && !item.stale);
    // Mutated after a green accept: drop the stale pass, but still allow judging (try stays missing).
    if (current.mode === "ideaKing" && hadAccepted && !(await validateDeliveryArtifacts(current, root))) {
      working = invalidatePriorRuns(current);
    }
    const result = commitRound(working, parsed.data.quotes, parsed.data.audience, root);
    let session = { ...result.session, material: materialFromEvidence(result.session) };
    if (
      session.mode === "ideaKing" &&
      session.deliveryStatus === "delivered" &&
      !(await validateDeliveryArtifacts(session, root))
    ) {
      session = { ...session, deliveryStatus: "incomplete" };
    }
    return { ...result, session, detail: result.error };
  });
}

export async function getSession(sessionId: string, root = process.cwd()): Promise<ToolView> {
  const transaction = await updateSession(sessionId, async (current) => {
    const hasAcceptedProduct = current.deliveryStatus === "delivered" || current.deliveryStatus === "selected" ||
      current.evidence.some((item) => item.acceptOk === true && !item.stale);
    if (current.mode === "ideaKing" && hasAcceptedProduct && !await validateDeliveryArtifacts(current, root)) {
      return { session: syncPhase(invalidatePriorRuns(current)), value: null };
    }
    return { session: current, value: null, persist: false };
  }, root, (saved) => writeBoard(saved, root));
  return transaction ? view(transaction.session, root) : view(undefined, root, "not_found");
}
