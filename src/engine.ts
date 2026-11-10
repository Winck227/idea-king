import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { acceptEvidenceSupportsQuote, deliveryArtifactsValid, outDirFor, runAcceptor } from "./accept.ts";
import { captureFiles, executeProduct } from "./runner.ts";
import { applyRevisionCounters } from "./crew.ts";
import {
  fillLabel,
  resolveBoardTheme,
  resolveLabels,
  settingsRelativePath,
  type LabelPack,
} from "./labels.ts";
import type {
  AudienceReport,
  Cell,
  ConditionCode,
  Evidence,
  MarkInput,
  OptionRole,
  Quote,
  Session,
  SessionMode,
  SourceMark,
  Verdict,
} from "./schema.ts";

const memoryClaim = /^别人会记住：(.+)$/;
const joinConstraint = "交接接得上";
const tryConstraint = "别人能直接试用";
const notLiteralConstraint = "不是原话的字面";
const textLimit = 8000;
const snapshotLimit = 256 * 1024;
const runTimeoutMs = 10_000;
const grabSlice = 12;
const sessionIdPattern = /^[A-Za-z0-9_-]+$/;

const codeText: Record<ConditionCode, string> = {
  join: joinConstraint,
  not_literal: notLiteralConstraint,
  try: tryConstraint,
  memory: "别人会记住：…",
};

export function sha256Hex(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newEvidenceId(): string {
  return randomUUID();
}

function grabIdentityKey(item: Evidence): string {
  if (item.inode && item.inode.length > 0) {
    return `inode:${item.inode}`;
  }
  if (item.realPath && item.realPath.length > 0) {
    return `real:${item.realPath.replaceAll("\\", "/").toLowerCase()}`;
  }
  return `path:${path.normalize(item.path).replaceAll("\\", "/").toLowerCase()}`;
}

export function computeMaterialHash(session: Session): string {
  const parts = [
    ...session.evidence
      .filter((item) => !item.stale && (item.kind === "grab" || item.kind === "think" || item.kind === "file"))
      .map((item) => `${item.kind}:${item.contentHash ?? sha256Hex(item.text)}:${(item.snapshotFiles ?? []).map(file => file.hash).join(",")}`),
    `initial:${session.initialMaterial ?? ""}`,
    ...session.marks.filter((mark) => mark.kind === "fact").map((mark) => `fact:${mark.text}`),
  ];
  return sha256Hex(parts.join("\n"));
}

export function dependencyHashesOf(session: Session): string[] {
  return session.evidence
    .filter((item) => !item.stale && (item.kind === "grab" || item.kind === "think" || item.kind === "file"))
    .flatMap((item) => [item.contentHash ?? sha256Hex(item.text), ...(item.snapshotFiles ?? []).map(file => file.hash)]);
}

export function materialFromEvidence(session: Session): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (text: string) => {
    if (text.length === 0 || seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };
  push(session.initialMaterial ?? "");
  for (const mark of session.marks) {
    if (mark.kind === "fact") push(mark.text);
  }
  for (const item of session.evidence) {
    if (item.kind === "grab" || item.kind === "think" || item.kind === "file" || item.kind === "run" || item.kind === "accept") {
      push(item.text);
    }
  }
  return parts.join("\n");
}

export function invalidatePriorRuns(session: Session): Session {
  const evidence = session.evidence.map((item) => {
    if (item.kind === "run" || item.kind === "accept") {
      return { ...item, stale: true, acceptOk: false };
    }
    return item;
  });
  return clearDelivery({
    ...session,
    evidence,
    materialHash: computeMaterialHash({ ...session, evidence }),
  });
}

async function markReadonly(filePath: string): Promise<void> {
  try {
    await chmod(filePath, 0o444);
  } catch {
    // Windows may deny chmod on some volumes; isolation still uses out/ + permission flags.
  }
}

function blankEvidenceFields(): Pick<
  Evidence,
  | "inode"
  | "materialHash"
  | "dependencyHashes"
  | "acceptOk"
  | "stale"
  | "runId"
  | "manifestHash"
> {
  return {
    inode: null,
    materialHash: null,
    dependencyHashes: null,
    acceptOk: null,
    stale: false,
    runId: null,
    manifestHash: null,
  };
}

export function grabsReady(evidence: Evidence[]): boolean {
  const keys = new Set(
    evidence.filter((item) => item.kind === "grab").map((item) => grabIdentityKey(item)),
  );
  return keys.size >= 2;
}

export function thinkCount(evidence: Evidence[]): number {
  return new Set(evidence.filter((item) => item.kind === "think").map(item => item.text.trim().replace(/\s+/g, " "))).size;
}

export function constraintCodeOf(mark: SourceMark): ConditionCode | null {
  if (mark.kind !== "constraint") return null;
  if (mark.code) return mark.code;
  if (mark.text === joinConstraint) return "join";
  if (mark.text === notLiteralConstraint) return "not_literal";
  if (mark.text === tryConstraint) return "try";
  if (memoryClaim.test(mark.text)) return "memory";
  return null;
}

export function optionRoleOf(mark: SourceMark, options: SourceMark[]): OptionRole | null {
  if (mark.kind !== "option") return null;
  if (mark.role) return mark.role;
  const index = options.findIndex((item) => item.id === mark.id);
  if (index === 0) return "literal";
  if (index === 1) return "spark";
  return null;
}

function inferConstraintCode(text: string, code?: ConditionCode): ConditionCode | null {
  if (code) return code;
  if (text === joinConstraint) return "join";
  if (text === notLiteralConstraint) return "not_literal";
  if (text === tryConstraint) return "try";
  if (memoryClaim.test(text)) return "memory";
  return null;
}

function displayConstraintText(code: ConditionCode, text: string): string {
  if (code === "join") return joinConstraint;
  if (code === "not_literal") return notLiteralConstraint;
  if (code === "try") return tryConstraint;
  if (code === "memory") {
    const trimmed = text.trim();
    if (memoryClaim.test(trimmed)) return trimmed;
    if (trimmed.startsWith("别人会记住：")) return trimmed;
    return `别人会记住：${trimmed}`;
  }
  return text;
}

/** ideaKing always requires the full template; lattice only when spine texts appear. */
export function ideaKingTemplateMissing(
  marks: SourceMark[],
  mode: SessionMode = "lattice",
): string[] {
  const options = marks.filter((mark) => mark.kind === "option");
  const constraints = marks.filter((mark) => mark.kind === "constraint");
  if (mode === "ideaKing") {
    const missing: string[] = [];
    if (options.length !== 2) missing.push("exactly_two_options");
    const roles = new Set(
      options.map((mark) => optionRoleOf(mark, options)).filter(Boolean),
    );
    if (!roles.has("literal") || !roles.has("spark")) missing.push("option_roles");
    const codes = new Set(
      constraints.map((mark) => constraintCodeOf(mark)).filter(Boolean),
    );
    for (const code of ["join", "not_literal", "try", "memory"] as ConditionCode[]) {
      if (!codes.has(code)) missing.push(codeText[code]);
    }
    return missing;
  }
  const texts = constraints.map((mark) => mark.text);
  const usesIdeaKing = texts.some(
    (text) =>
      text === joinConstraint || text === tryConstraint || text === notLiteralConstraint,
  );
  if (!usesIdeaKing) return [];
  const missing: string[] = [];
  if (!texts.includes(joinConstraint)) missing.push(joinConstraint);
  if (!texts.includes(notLiteralConstraint)) missing.push(notLiteralConstraint);
  if (!texts.includes(tryConstraint)) missing.push(tryConstraint);
  if (!constraints.some((mark) => memoryClaim.test(mark.text))) missing.push("别人会记住：…");
  return missing;
}

export function ideaKingMaterialReady(session: Session, marks: SourceMark[]): boolean {
  const material = session.material.trim();
  if (material.length === 0) return false;
  const options = marks.filter((mark) => mark.kind === "option");
  for (const option of options) {
    if (!material.includes(option.text)) return false;
  }
  for (const mark of marks) {
    if (mark.kind !== "constraint") continue;
    const code = constraintCodeOf(mark);
    if (code === "memory") {
      const matched = memoryClaim.exec(mark.text);
      const claim = matched?.[1] ?? mark.text;
      if (!material.includes(claim) && !material.includes(mark.text)) return false;
    }
  }
  return material.includes("交接") || material.includes("没有交接") || material.includes("产出");
}

export function clearDelivery(session: Session): Session {
  return {
    ...session,
    verdict: null,
    lastRoundCells: [],
    deliveryStatus: "incomplete",
  };
}

export function boardPathFor(session: Session): string {
  return path.join("artifacts", session.id, "board.html");
}

export function blankCells(marks: SourceMark[]): Cell[] {
  const options = marks.filter((mark) => mark.kind === "option");
  const constraints = marks.filter((mark) => mark.kind === "constraint");
  const cells: Cell[] = [];
  for (const constraint of constraints) {
    for (const option of options) {
      cells.push({
        markId: constraint.id,
        optionId: option.id,
        status: "missing",
        scent: 1,
        evidenceQuote: null,
      });
    }
  }
  return cells;
}

function mergeBlank(existing: Cell[], marks: SourceMark[]): Cell[] {
  const cells = existing.map((cell) => ({ ...cell }));
  for (const blank of blankCells(marks)) {
    const found = cells.some(
      (cell) => cell.markId === blank.markId && cell.optionId === blank.optionId,
    );
    if (!found) cells.push(blank);
  }
  return cells;
}

export function freezeMarks(
  session: Session,
  incoming: MarkInput[],
  opts?: { allowRevisionReset?: boolean },
): { session: Session; added: boolean; replaced: boolean } {
  const marks = session.marks.map((mark) => ({ ...mark }));
  let added = false;
  let replaced = false;
  let optionIndex = marks.filter((mark) => mark.kind === "option").length;
  for (const item of incoming) {
    const text = item.text.trim();
    if (text.length === 0) continue;
    const existing = marks.find((mark) => mark.kind === item.kind && mark.text === text);
    if (existing) continue;
    let role: OptionRole | null = item.role ?? null;
    let code: ConditionCode | null = item.code ?? null;
    let storedText = text;
    if (item.kind === "option") {
      if (!role) role = optionIndex === 0 ? "literal" : optionIndex === 1 ? "spark" : null;
      // Shrink/replace: same role REPLACES prior option (never accumulate a third).
      if (role) {
        const optionsNow = marks.filter((mark) => mark.kind === "option");
        const priorIndex = marks.findIndex(
          (mark) =>
            mark.kind === "option" && (mark.role === role || optionRoleOf(mark, optionsNow) === role),
        );
        if (priorIndex >= 0) {
          const prior = marks[priorIndex]!;
          if (prior.text !== storedText) {
            marks[priorIndex] = {
              id: item.id ?? randomUUID(),
              kind: "option",
              text: storedText,
              scent: 1,
              role,
              code: null,
              replacedId: prior.id,
            };
            added = true;
            replaced = true;
          }
          continue;
        }
      }
      optionIndex += 1;
    }
    if (item.kind === "constraint") {
      // Replace constraint with same code (keep exactly four ideaKing codes).
      code = inferConstraintCode(text, item.code);
      if (code) {
        storedText = displayConstraintText(code, text);
        const priorIndex = marks.findIndex(
          (mark) => mark.kind === "constraint" && constraintCodeOf(mark) === code,
        );
        if (priorIndex >= 0) {
          const prior = marks[priorIndex]!;
          if (prior.text !== storedText) {
            marks[priorIndex] = {
              id: item.id ?? randomUUID(),
              kind: "constraint",
              text: storedText,
              scent: 1,
              role: null,
              code,
              replacedId: prior.id,
            };
            added = true;
            replaced = true;
          }
          continue;
        }
      }
    }
    marks.push({
      id: item.id ?? randomUUID(),
      kind: item.kind,
      text: storedText,
      scent: 1,
      role,
      code,
      replacedId: null,
    });
    added = true;
  }
  // Drop orphaned cells pointing at replaced option ids.
  const optionIds = new Set(marks.filter((mark) => mark.kind === "option").map((mark) => mark.id));
  const constraintIds = new Set(
    marks.filter((mark) => mark.kind === "constraint").map((mark) => mark.id),
  );
  const cells = mergeBlank(
    session.cells.filter(
      (cell) => optionIds.has(cell.optionId) && constraintIds.has(cell.markId),
    ),
    marks,
  );
  let next: Session = {
    ...session,
    marks,
    cells,
  };
  if (added) {
    if (opts?.allowRevisionReset && replaced) {
      next = applyRevisionCounters(session, next, clearDelivery);
    } else {
      next = clearDelivery(next);
      // Facts / non-revision adds must NOT reset stopped/voidCount.
    }
  }
  return { session: next, added, replaced };
}

export function depositFact(
  session: Session,
  text: string,
): { session: Session; error?: "bad_request" } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { session, error: "bad_request" };
  const frozen = freezeMarks(session, [{ kind: "fact", text: trimmed }]);
  if (!frozen.added) return { session: frozen.session };
  const withFact = frozen.session;
  const material = materialFromEvidence(withFact);
  return {
    session: clearDelivery({
      ...withFact,
      material: material.length > 0 ? material : trimmed,
      materialHash: computeMaterialHash(withFact),
    }),
  };
}

function resolveInside(root: string, filePath: string): string | undefined {
  const trimmed = filePath.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) return undefined;
  const base = path.resolve(root);
  const full = path.resolve(base, trimmed);
  const rel = path.relative(base, full);
  if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return full;
}

async function resolveInsideReal(
  root: string,
  filePath: string,
): Promise<{ full: string; real: string; rel: string } | undefined> {
  const full = resolveInside(root, filePath);
  if (!full) return undefined;
  const base = path.resolve(root);
  let real: string;
  try {
    real = await realpath(full);
  } catch {
    return undefined;
  }
  let baseReal: string;
  try {
    baseReal = await realpath(base);
  } catch {
    baseReal = base;
  }
  const relReal = path.relative(baseReal, real);
  if (relReal.length === 0 || relReal.startsWith("..") || path.isAbsolute(relReal)) {
    return undefined;
  }
  return { full, real, rel: relativeInside(root, full) };
}

function relativeInside(root: string, full: string): string {
  return path.relative(path.resolve(root), full);
}

function appendMaterial(session: Session, text: string): Session {
  if (text.length === 0) return session;
  if (session.material.includes(text)) return session;
  const material = session.material.length === 0 ? text : `${session.material}\n${text}`;
  return { ...session, material };
}

function artifactPlace(
  session: Session,
  root: string,
  filePath: string,
): { full: string; rel: string; dir: string } | undefined {
  if (!sessionIdPattern.test(session.id)) return undefined;
  const full = resolveInside(root, filePath);
  if (!full) return undefined;
  const rel = relativeInside(root, full);
  const prefix = path.join("artifacts", session.id) + path.sep;
  if (!rel.startsWith(prefix)) return undefined;
  return { full, rel, dir: path.resolve(root, "artifacts", session.id) };
}

export function phaseAllowsFile(session: Session): boolean {
  if (session.mode !== "ideaKing") return grabsReady(session.evidence);
  if (!grabsReady(session.evidence)) return false;
  if (ideaKingTemplateMissing(session.marks, "ideaKing").length > 0) return false;
  const neededThink = Math.max(0, session.crewSize - 3);
  return thinkCount(session.evidence) >= neededThink;
}

export function phaseAllowsCommit(session: Session): boolean {
  if (session.mode !== "ideaKing") return true;
  if (ideaKingTemplateMissing(session.marks, "ideaKing").length > 0) return false;
  const hasLiveRun = session.evidence.some(
    (item) => item.kind === "run" && item.exitCode === 0 && !item.stale,
  );
  if (!hasLiveRun) return false;
  // ideaKing commit needs an accept record (ok or failed) so try grounding can decide.
  return session.evidence.some((item) => item.kind === "accept" && !item.stale);
}

export async function depositFile(
  session: Session,
  filePath: string,
  root: string,
): Promise<{ session: Session; error?: "bad_request" }> {
  if (!phaseAllowsFile(session)) return { session, error: "bad_request" };
  const place = artifactPlace(session, root, filePath);
  if (!place) return { session, error: "bad_request" };
  const { full } = place;
  try {
    const actual = await realpath(full);
    const actualRoot = await realpath(place.dir);
    const inside = path.relative(actualRoot, actual);
    if (inside.startsWith("..") || path.isAbsolute(inside) || /^(out|grabs|think|snapshots)[\\/]/.test(inside) || inside === "board.html") return { session, error: "bad_request" };
    const info = await stat(full);
    if (!info.isFile()) return { session, error: "bad_request" };
    const buf = await readFile(full);
    if (buf.byteLength === 0 || buf.byteLength > snapshotLimit) {
      return { session, error: "bad_request" };
    }
    const raw = buf.toString("utf8");
    if (raw.trim().length === 0) return { session, error: "bad_request" };
    const hash = sha256Hex(buf);
    const snapDir = path.join(place.dir, "snapshots");
    await mkdir(snapDir, { recursive: true });
    const snapPath = path.join(snapDir, hash);
    try { await writeFile(snapPath, buf, { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || sha256Hex(await readFile(snapPath)) !== hash) throw error; }
    await markReadonly(snapPath);
    await mkdir(outDirFor(session.id, root), { recursive: true });
    const id = newEvidenceId();
    const deps = dependencyHashesOf(session);
    const captured = await captureFiles(place.dir);
    const snapshotFiles = Object.entries(captured)
      .filter(([name]) => !/^(out|grabs|think)[/]/.test(name) && /\.(c?js|mjs|json)$/.test(name))
      .map(([name, text]) => ({ path: name, hash: sha256Hex(text), text }));
    if (!snapshotFiles.some(file => file.path === inside.replaceAll("\\", "/"))) return { session, error: "bad_request" };
    const provisional: Evidence = {
      ...blankEvidenceFields(),
      id,
      kind: "file",
      path: place.rel,
      text: raw,
      exitCode: null,
      elapsedMs: null,
      role: null,
      contentHash: hash,
      byteLength: buf.byteLength,
      realPath: null,
      materialHash: null,
      dependencyHashes: deps,
      snapshotFiles,
    };
    const currentEvidence = session.evidence.map(item => item.kind === "file" && item.path === place.rel ? {...item, stale: true} : item);
    const withFile = { ...session, evidence: [...currentEvidence, provisional] };
    const materialHash = computeMaterialHash(withFile);
    const evidence: Evidence = { ...provisional, materialHash };
    const bound = {
      ...withFile,
      evidence: [...currentEvidence, evidence],
    };
    const next = {
      ...invalidatePriorRuns(bound),
      material: materialFromEvidence(bound),
      materialHash,
    };
    await writeBoard(next, root);
    return { session: next };
  } catch {
    return { session, error: "bad_request" };
  }
}

function isUnderArtifacts(rel: string): boolean {
  const normalized = rel.replaceAll("\\", "/").toLowerCase();
  return normalized === "artifacts" || normalized.startsWith("artifacts/");
}

export async function depositGrab(
  session: Session,
  filePath: string,
  quote: string,
  root: string,
): Promise<{ session: Session; error?: "bad_request" }> {
  const excerpt = quote.trim();
  if (excerpt.length === 0) return { session, error: "bad_request" };
  if (!sessionIdPattern.test(session.id)) return { session, error: "bad_request" };
  const resolved = await resolveInsideReal(root, filePath);
  if (!resolved) return { session, error: "bad_request" };
  if (isUnderArtifacts(resolved.rel)) return { session, error: "bad_request" };
  try {
    const info = await stat(resolved.full);
    if (!info.isFile()) return { session, error: "bad_request" };
    const raw = await readFile(resolved.full, "utf8");
    if (!raw.includes(excerpt)) return { session, error: "bad_request" };
    const id = newEvidenceId();
    const dir = path.resolve(root, "artifacts", session.id, "grabs");
    await mkdir(dir, { recursive: true });
    const grabPath = path.join(dir, `${id}.txt`);
    await writeFile(grabPath, excerpt, "utf8");
    await markReadonly(grabPath);
    const inode = `${info.dev}:${info.ino}`;
    const evidence: Evidence = {
      ...blankEvidenceFields(),
      id,
      kind: "grab",
      path: resolved.rel,
      text: excerpt,
      exitCode: null,
      elapsedMs: null,
      role: null,
      contentHash: sha256Hex(excerpt),
      byteLength: Buffer.byteLength(excerpt, "utf8"),
      realPath: resolved.real,
      inode,
    };
    const withGrab = { ...session, evidence: [...session.evidence, evidence] };
    const next = invalidatePriorRuns({
      ...withGrab,
      material: materialFromEvidence(withGrab),
      materialHash: computeMaterialHash(withGrab),
    });
    await writeBoard(next, root);
    return { session: next };
  } catch {
    return { session, error: "bad_request" };
  }
}

export async function depositThink(
  session: Session,
  text: string,
  root: string,
  role?: string | null,
): Promise<{ session: Session; error?: "bad_request" }> {
  const body = text.trim();
  if (body.length === 0) return { session, error: "bad_request" };
  if (!sessionIdPattern.test(session.id)) return { session, error: "bad_request" };
  if (session.evidence.some(item => item.kind === "think" && item.text.trim().replace(/\s+/g, " ") === body.replace(/\s+/g, " "))) return { session, error: "bad_request" };
  const dir = path.resolve(root, "artifacts", session.id, "think");
  try {
    await mkdir(dir, { recursive: true });
    const id = newEvidenceId();
    const rel = path.join("artifacts", session.id, "think", `${id}.md`);
    const full = path.join(root, rel);
    await writeFile(full, body, "utf8");
    await markReadonly(full);
    const trimmedRole = role?.trim();
    const evidence: Evidence = {
      ...blankEvidenceFields(),
      id,
      kind: "think",
      path: rel,
      text: body,
      exitCode: null,
      elapsedMs: null,
      role: trimmedRole && trimmedRole.length > 0 ? trimmedRole : null,
      contentHash: sha256Hex(body),
      byteLength: Buffer.byteLength(body, "utf8"),
      realPath: null,
    };
    const withThink = { ...session, evidence: [...session.evidence, evidence] };
    const next = invalidatePriorRuns({
      ...withThink,
      material: materialFromEvidence(withThink),
      materialHash: computeMaterialHash(withThink),
    });
    await writeBoard(next, root);
    return { session: next };
  } catch {
    return { session, error: "bad_request" };
  }
}

export async function verifyExecutionInputs(session: Session, root: string): Promise<boolean> {
  const dir = path.resolve(root, "artifacts", session.id);
  try {
    for (const item of session.evidence.filter(row => !row.stale)) {
      if (item.kind === "grab" || item.kind === "think") {
        if (!item.contentHash || !item.id) { if (session.mode === "ideaKing") return false; else continue; }
        const file = item.kind === "grab" ? path.join(dir,"grabs",item.id+".txt") : path.resolve(root,item.path);
        const actual = await realpath(file);
        const rel = path.relative(await realpath(dir),actual);
        if (rel.startsWith("..") || path.isAbsolute(rel) || sha256Hex(await readFile(actual)) !== item.contentHash) return false;
      }
      if (item.kind === "file") {
        if (!item.contentHash) return false;
        if (sha256Hex(await readFile(path.join(dir,"snapshots",item.contentHash))) !== item.contentHash) return false;
        for (const file of item.snapshotFiles ?? []) {
          const target = path.resolve(dir,file.path);
          const rel = path.relative(dir,target);
          if (rel.startsWith("..") || path.isAbsolute(rel) || sha256Hex(await readFile(target)) !== file.hash || sha256Hex(file.text) !== file.hash) return false;
        }
      }
    }
    return true;
  } catch { return false; }
}

export async function validateDeliveryArtifacts(session: Session, root: string): Promise<boolean> {
  return await verifyExecutionInputs(session, root) && await deliveryArtifactsValid(session, root);
}

export async function depositRun(
  session: Session,
  filePath: string,
  root: string,
): Promise<{ session: Session; error?: "bad_request" | "accept_failed" }> {
  const place = artifactPlace(session, root, filePath);
  if (!place) return { session, error: "bad_request" };
  const { full, rel, dir } = place;
  const fileEv = [...session.evidence]
    .reverse()
    .find((item) => item.kind === "file" && item.path === rel && !item.stale);
  if (!fileEv?.contentHash) return { session, error: "bad_request" };
  const materialHash = computeMaterialHash(session);
  if (fileEv.materialHash && fileEv.materialHash !== materialHash) {
    return { session, error: "bad_request" };
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) return { session, error: "bad_request" };
    const live = await readFile(full);
    if (sha256Hex(live) !== fileEv.contentHash) return { session, error: "bad_request" };
  } catch {
    return { session, error: "bad_request" };
  }
  const snapPath = path.join(dir, "snapshots", fileEv.contentHash);
  try {
    if (sha256Hex(await readFile(snapPath)) !== fileEv.contentHash) return { session, error: "bad_request" };
    if (!await verifyExecutionInputs(session, root)) return { session, error: "bad_request" };
  } catch {
    return { session, error: "bad_request" };
  }
  const outWrite = outDirFor(session.id, root);
  await mkdir(outWrite, { recursive: true });
  const captured: Record<string,string> = Object.create(null);
  for (const file of fileEv.snapshotFiles ?? []) captured[file.path] = file.text;
  if (Object.keys(captured).length === 0) captured[path.relative(dir, full).replaceAll("\\", "/")] = fileEv.text;
  for (const item of session.evidence) {
    if (item.kind === "grab" && item.id) captured["grabs/"+item.id+".txt"] = item.text;
    if (item.kind === "think") captured[path.relative(dir,path.resolve(root,item.path)).replaceAll("\\", "/")] = item.text;
  }
  const ran = await executeProduct(full, dir, outWrite, [], captured);
  if (!ran) return { session, error: "bad_request" };
  const id = newEvidenceId();
  const deps = dependencyHashesOf(session);
  const evidence: Evidence = {
    ...blankEvidenceFields(),
    id,
    kind: "run",
    path: rel,
    text: ran.text,
    exitCode: ran.exitCode,
    elapsedMs: ran.elapsedMs,
    role: null,
    contentHash: fileEv.contentHash,
    byteLength: Buffer.byteLength(ran.text, "utf8"),
    realPath: null,
    materialHash,
    dependencyHashes: deps,
    acceptOk: null,
  };
  let next: Session = {
    ...session,
    evidence: [...session.evidence, evidence],
  };
  next = {
    ...next,
    material: materialFromEvidence(next),
    materialHash,
  };
  const accepted = await runAcceptor(next, root, evidence);
  next = {
    ...accepted.session,
    material: materialFromEvidence(accepted.session),
    materialHash: computeMaterialHash(accepted.session),
  };
  await writeBoard(next, root);
  return { session: next };
}

/** Sync helper used when realpath must stay under root (tests / junctions). */
export function realpathInsideRoot(root: string, filePath: string): string | undefined {
  const full = resolveInside(root, filePath);
  if (!full) return undefined;
  try {
    const real = realpathSync(full);
    const base = realpathSync(path.resolve(root));
    const rel = path.relative(base, real);
    if (rel.length === 0 || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function charCount(items: Evidence[]): number {
  return items.reduce((sum, item) => sum + item.text.length, 0);
}

function estimateTokens(count: number): number {
  return Math.ceil(count / 2);
}

function barPercent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((value / max) * 100);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}

function cssValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("</", "<\\/");
}

function statusLabel(labels: LabelPack, status: Cell["status"]): string {
  if (status === "supported") return labels.statusSupported;
  if (status === "contradicts") return labels.statusContradicts;
  return labels.statusMissing;
}

function markText(marks: SourceMark[], id: string): string {
  return marks.find((mark) => mark.id === id)?.text ?? id;
}

type MediaKind = "image" | "video" | "audio" | "page";

const mediaExt: Record<MediaKind, RegExp> = {
  image: /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i,
  video: /\.(mp4|webm|ogg|mov|m4v)$/i,
  audio: /\.(mp3|wav|ogg|m4a|aac|flac)$/i,
  page: /\.html?$/i,
};

function mediaKindOf(filePath: string): MediaKind | null {
  const base = filePath.split(/[?#]/)[0] ?? filePath;
  if (mediaExt.image.test(base)) return "image";
  if (mediaExt.video.test(base)) return "video";
  if (mediaExt.audio.test(base)) return "audio";
  if (mediaExt.page.test(base)) return "page";
  return null;
}

function boardRelativeSrc(sessionId: string, rawPath: string): string | null {
  const normalized = rawPath.replaceAll("\\", "/").trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null;
  if (normalized.includes("..")) return null;
  const prefix = `artifacts/${sessionId}/`;
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  if (!normalized.includes("/")) return normalized;
  if (normalized.startsWith("/")) return null;
  return normalized;
}

function mediaExists(root: string | undefined, sessionId: string, relSrc: string): boolean {
  if (!root) return false;
  const full = path.resolve(root, "artifacts", sessionId, relSrc);
  try {
    const real = realpathSync(full);
    const base = realpathSync(path.resolve(root, "artifacts", sessionId));
    const rel = path.relative(base, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
    return true;
  } catch {
    return false;
  }
}

function renderMedia(
  sessionId: string,
  rawPath: string,
  root?: string,
): string {
  const kind = mediaKindOf(rawPath);
  if (!kind) return "";
  const src = boardRelativeSrc(sessionId, rawPath);
  if (!src) return "";
  if (!mediaExists(root, sessionId, src)) return "";
  const safe = escapeAttr(src);
  const label = escapeHtml(rawPath.replaceAll("\\", "/"));
  if (kind === "image") {
    return `<figure class="media media-image"><img src="${safe}" alt="${label}" loading="lazy"><figcaption>${label}</figcaption></figure>`;
  }
  if (kind === "video") {
    return `<figure class="media media-video"><video src="${safe}" controls playsinline></video><figcaption>${label}</figcaption></figure>`;
  }
  if (kind === "audio") {
    return `<figure class="media media-audio"><audio src="${safe}" controls></audio><figcaption>${label}</figcaption></figure>`;
  }
  return `<p class="media media-page"><a href="${safe}" target="_blank" rel="noreferrer">${label}</a></p>`;
}

function collectMediaPaths(sessionId: string, root: string | undefined, ...chunks: string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:artifacts[\\/][A-Za-z0-9_-]+[\\/])?[^\s"'<>]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|mp4|webm|ogg|mov|m4v|mp3|wav|m4a|aac|flac|html?)/gi;
  for (const chunk of chunks) {
    for (const match of chunk.matchAll(pattern)) {
      const raw = match[0];
      const key = raw.replaceAll("\\", "/").toLowerCase();
      if (seen.has(key)) continue;
      if (!mediaKindOf(raw)) continue;
      const src = boardRelativeSrc(sessionId, raw);
      if (!src) continue;
      if (!mediaExists(root, sessionId, src)) continue;
      seen.add(key);
      found.push(raw);
    }
  }
  return found;
}

function renderRichText(sessionId: string, text: string, root?: string): string {
  const media = collectMediaPaths(sessionId, root, text)
    .map((item) => renderMedia(sessionId, item, root))
    .join("");
  return `<div class="prose">${escapeHtml(text)}</div>${media}`;
}

function evidenceCard(opts: {
  sessionId: string;
  root: string;
  eyebrow: string;
  title: string;
  body: string;
  meta?: string;
  extraPaths?: string[];
}): string {
  const pathMedia = (opts.extraPaths ?? [])
    .map((item) => renderMedia(opts.sessionId, item, opts.root))
    .join("");
  const meta = opts.meta ? `<span class="chip">${escapeHtml(opts.meta)}</span>` : "";
  return `<article class="card">
  <header class="card-head">
    <div>
      <p class="eyebrow">${escapeHtml(opts.eyebrow)}</p>
      <h2 class="card-title">${escapeHtml(opts.title)}</h2>
    </div>
    ${meta}
  </header>
  ${renderRichText(opts.sessionId, opts.body, opts.root)}
  ${pathMedia}
</article>`;
}

export async function writeBoard(session: Session, root: string): Promise<void> {
  if (!sessionIdPattern.test(session.id)) return;
  const dir = path.resolve(root, "artifacts", session.id);
  await mkdir(dir, { recursive: true });
  const { code, labels } = resolveLabels(session.userText, root);
  const theme = resolveBoardTheme(root);
  const grabs = session.evidence.filter((item) => item.kind === "grab");
  const files = session.evidence.filter((item) => item.kind === "file");
  const runs = session.evidence.filter((item) => item.kind === "run");
  const thinks = session.evidence.filter((item) => item.kind === "think");
  const grabChars = charCount(grabs);
  const productChars = charCount(files);
  const outputChars = charCount(runs);
  const budgetReady = grabsReady(session.evidence);
  const expectedOutputChars = budgetReady ? grabChars : 0;
  const expectedTokens = budgetReady
    ? estimateTokens(grabChars + productChars + expectedOutputChars)
    : 0;
  const actualTokens = runs.length > 0 ? estimateTokens(grabChars + productChars + outputChars) : 0;
  const productCell = files.length > 0 ? String(productChars) : "";
  const budgetRow = budgetReady
    ? `<tr><td>${grabs.map((item) => escapeHtml(item.path)).join("<br>")}</td><td>${grabChars}</td><td>${productCell}</td><td>${expectedOutputChars}</td><td>${expectedTokens}</td></tr>`
    : "<tr><td></td><td></td><td></td><td></td><td></td></tr>";
  const budgetStats = budgetReady
    ? `<div class="budget-stats">
  <div class="budget-stat"><span class="label">${escapeHtml(labels.grabbedFiles)}</span><span class="value">${grabs.length}</span><div class="paths">${grabs.map((item) => escapeHtml(item.path)).join("<br>")}</div></div>
  <div class="budget-stat"><span class="label">${escapeHtml(labels.grabChars)}</span><span class="value">${grabChars}</span></div>
  <div class="budget-stat"><span class="label">${escapeHtml(labels.productChars)}</span><span class="value">${productCell || "0"}</span></div>
  <div class="budget-stat"><span class="label">${escapeHtml(labels.expectedOutputChars)}</span><span class="value">${expectedOutputChars}</span><div class="paths">${escapeHtml(labels.expectedTokens)} ${expectedTokens}</div></div>
</div>`
    : "";
  const grabbedRows =
    grabs.length > 0
      ? grabs
          .map((item) =>
            evidenceCard({
              sessionId: session.id,
              root,
              eyebrow: labels.file,
              title: item.path,
              body: item.text,
              meta: `${item.text.length}`,
              extraPaths: [item.path],
            }),
          )
          .join("\n")
      : `<p class="empty">${escapeHtml(labels.emptyWho)}</p>`;
  const thinkRows =
    thinks.length > 0
      ? thinks
          .map((item) =>
            evidenceCard({
              sessionId: session.id,
              root,
              eyebrow: labels.role,
              title: item.role && item.role.length > 0 ? item.role : labels.think,
              body: item.text,
              meta: path.basename(item.path),
              extraPaths: [item.path],
            }),
          )
          .join("\n")
      : `<p class="empty">${escapeHtml(labels.emptyThink)}</p>`;
  const boardCells =
    session.lastRoundCells.length > 0 ? session.lastRoundCells : session.cells;
  const cellRows =
    boardCells.length > 0
      ? boardCells
          .map((cell) => {
            const quote = cell.evidenceQuote ?? "";
            const scentLabel = `scent=${cell.scent}`;
            return `<tr><td>${escapeHtml(markText(session.marks, cell.optionId))}</td><td>${escapeHtml(markText(session.marks, cell.markId))}</td><td class="status-cell ${cell.status}"><span class="status-dot"></span><span class="status-text">${escapeHtml(statusLabel(labels, cell.status))}</span> <span class="chip scent">${escapeHtml(scentLabel)}</span></td><td>${renderRichText(session.id, quote, root)}</td></tr>`;
          })
          .join("\n")
      : "<tr><td></td><td></td><td></td><td></td></tr>";
  const sentence = verdictSentence(session, root);
  const audience = session.audience;
  const deliveryMeta = `<section class="meta-panel">
<h1>交付 / 修订</h1>
<p class="meta-line"><span class="chip">deliveryStatus=${escapeHtml(session.deliveryStatus)}</span>
<span class="chip">revision=${session.revision}</span>
<span class="chip">phase=${escapeHtml(session.phase)}</span>
<span class="chip">materialHash=${escapeHtml(session.materialHash ?? "none")}</span></p>
${
  audience
    ? `<p class="meta-line">观众 provenance=<strong>${escapeHtml(audience.provenance)}</strong>
 artifactHash=${escapeHtml(audience.artifactHash ?? "none")}<br>
 firstStop=${escapeHtml(audience.firstStop)} · skipped=${escapeHtml(audience.skipped)} · remembered=${escapeHtml(audience.remembered)}</p>`
    : `<p class="empty">尚无观众三行</p>`
}
${
  session.discardedText
    ? `<p class="discarded"><strong>丢弃 / 失败提示</strong><br>${escapeHtml(session.discardedText)}</p>`
    : ""
}
<p class="note">token 为字符估算（字数/2），非供应商用量。</p>
</section>`;
  const conclusionRow =
    sentence && sentence.length > 0
      ? `<tr><td colspan="4"><p class="conclusion">${escapeHtml(sentence)}</p></td></tr>`
      : "";
  const workRows =
    runs.length > 0
      ? runs
          .map((item) => {
            const exitLabel =
              item.exitCode === null
                ? ""
                : escapeHtml(fillLabel(labels.exitCodeLine, { code: item.exitCode }));
            const elapsedLabel =
              item.elapsedMs === null
                ? ""
                : escapeHtml(fillLabel(labels.elapsedLine, { ms: item.elapsedMs }));
            return `<article class="card work-card">
  <header class="card-head">
    <div>
      <p class="eyebrow">${escapeHtml(labels.script)}</p>
      <h2 class="card-title">${escapeHtml(item.path)}</h2>
    </div>
    <div class="chips">
      ${exitLabel ? `<span class="chip">${exitLabel}</span>` : ""}
      ${elapsedLabel ? `<span class="chip">${elapsedLabel}</span>` : ""}
    </div>
  </header>
  ${renderRichText(session.id, item.text, root)}
  ${renderMedia(session.id, item.path, root)}
</article>`;
          })
          .join("\n")
      : `<p class="empty">${escapeHtml(labels.emptyWork)}</p>`;
  const elapsedValues = runs.flatMap((item) => (item.elapsedMs === null ? [] : [item.elapsedMs]));
  const elapsedText =
    elapsedValues.length > 0
      ? fillLabel(labels.elapsedLine, {
          ms: elapsedValues.reduce((sum, value) => sum + value, 0),
        })
      : "";
  const widest = Math.max(expectedTokens, actualTokens, 1);
  const charMax = Math.max(grabChars, productChars, outputChars, 1);
  const shareTotal = Math.max(grabChars + productChars + outputChars, 1);
  const grabShare = Math.round((grabChars / shareTotal) * 100);
  const productShare = Math.round((productChars / shareTotal) * 100);
  const outputShare = Math.max(0, 100 - grabShare - productShare);
  const spendDetail = escapeHtml(
    fillLabel(labels.spendLine, {
      grab: grabChars,
      product: productChars,
      output: outputChars,
    }),
  );
  const spendElapsed =
    elapsedText.length > 0 ? escapeHtml(fillLabel(labels.elapsedJoin, { elapsed: elapsedText })) : "";
  const spendRow =
    runs.length > 0
      ? `<tr><td><div class="spend-line"><span>${escapeHtml(fillLabel(labels.expectedTokensLine, { count: expectedTokens }))}</span> <span class="track"><span class="bar estimated" style="width:${barPercent(expectedTokens, widest)}%"></span></span></div><div class="spend-line"><span>${escapeHtml(fillLabel(labels.actualTokensLine, { count: actualTokens }))}</span> <span class="track"><span class="bar actual" style="width:${barPercent(actualTokens, widest)}%"></span></span></div><p>${spendDetail}${spendElapsed}</p></td></tr>`
      : `<tr><td><p class="empty">${escapeHtml(labels.emptySpend)}</p></td></tr>`;
  const donut = `<svg class="donut" viewBox="0 0 42 42" aria-hidden="true">
  <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--line)" stroke-width="6"></circle>
  <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--accent)" stroke-width="6" stroke-dasharray="${grabShare} ${100 - grabShare}" stroke-dashoffset="25"></circle>
  <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--warn)" stroke-width="6" stroke-dasharray="${productShare} ${100 - productShare}" stroke-dashoffset="${25 - grabShare}"></circle>
  <circle cx="21" cy="21" r="15.9" fill="transparent" stroke="var(--ok)" stroke-width="6" stroke-dasharray="${outputShare} ${100 - outputShare}" stroke-dashoffset="${25 - grabShare - productShare}"></circle>
</svg>`;
  const html = `<!DOCTYPE html>
<html lang="${escapeAttr(labels.htmlLang)}" data-theme="${escapeAttr(theme.id)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(labels.title)}</title>
<style>
  :root {
    --bg: ${cssValue(theme.bg)};
    --panel: ${cssValue(theme.panel)};
    --panel-2: ${cssValue(theme.panel2)};
    --line: ${cssValue(theme.line)};
    --text: ${cssValue(theme.text)};
    --muted: ${cssValue(theme.muted)};
    --accent: ${cssValue(theme.accent)};
    --ok: ${cssValue(theme.ok)};
    --warn: ${cssValue(theme.warn)};
    --bad: ${cssValue(theme.bad)};
    --shadow: ${cssValue(theme.shadow)};
    --page-bg: ${cssValue(theme.pageBg)};
    --hero-bg: ${cssValue(theme.heroBg)};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0 0 64px;
    background: var(--page-bg);
    background-attachment: fixed;
    color: var(--text);
    font: 15px/1.6 "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
  }
  .shell { max-width: 1080px; margin: 0 auto; padding: 28px clamp(14px, 3vw, 28px) 0; }
  .hero {
    position: relative;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
    border-radius: 22px;
    padding: 28px 26px 24px;
    margin-bottom: 22px;
    background: var(--hero-bg);
    box-shadow: var(--shadow);
  }
  .hero::after {
    content: "";
    position: absolute; inset: auto -10% -40% 40%;
    height: 180px;
    background: radial-gradient(circle, color-mix(in srgb, var(--accent) 35%, transparent), transparent 70%);
    pointer-events: none;
  }
  .brand {
    margin: 0 0 10px;
    font-size: 12px;
    letter-spacing: .18em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 700;
  }
  .hero-line {
    position: relative;
    z-index: 1;
    margin: 0;
    font-size: clamp(1.35rem, 3.2vw, 2rem);
    line-height: 1.35;
    font-weight: 750;
    max-width: 28ch;
  }
  .hero-foot {
    position: relative;
    z-index: 1;
    margin: 16px 0 0;
    color: var(--muted);
    font-size: 12px;
  }
  .hero-foot .language,
  .hero-foot .settings { color: inherit; }
  section {
    background: var(--panel);
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
    border-radius: 18px;
    padding: 20px 20px 18px;
    margin: 0 0 16px;
    box-shadow: var(--shadow);
  }
  h1 {
    margin: 0 0 14px;
    font-size: 1.05rem;
    font-weight: 750;
    letter-spacing: 0.01em;
  }
  .original-text {
    margin: 0;
    white-space: pre-wrap;
    color: var(--text);
    font-size: 1.08rem;
    line-height: 1.7;
  }
  .grabbed, .think, .work { display: grid; gap: 12px; }
  .card {
    background: var(--panel-2);
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
    border-radius: 14px;
    padding: 14px 16px 16px;
  }
  .card-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 10px;
  }
  .eyebrow {
    margin: 0 0 4px;
    color: var(--accent);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 700;
  }
  .card-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 650;
    word-break: break-word;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
    background: var(--panel-2);
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .prose {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text);
    font-size: 14px;
    line-height: 1.65;
  }
  .empty {
    margin: 0;
    padding: 18px 16px;
    border: 1px dashed color-mix(in srgb, var(--line) 70%, white);
    border-radius: 12px;
    color: var(--muted);
    background: var(--panel-2);
  }
  .budget-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  .budget-stat {
    background: var(--panel-2);
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
    border-radius: 14px;
    padding: 12px 14px;
  }
  .budget-stat .label {
    display: block;
    margin-bottom: 6px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }
  .budget-stat .value {
    font-size: 1.25rem;
    font-weight: 750;
    color: var(--text);
    word-break: break-word;
  }
  .budget-stat .paths {
    margin-top: 8px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.45;
    word-break: break-all;
  }
  table { border-collapse: separate; border-spacing: 0; width: 100%; overflow: hidden; border-radius: 12px; }
  th, td {
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
    padding: 10px 12px;
    vertical-align: top;
    text-align: left;
  }
  th {
    color: var(--muted);
    font-size: 12px;
    font-weight: 650;
    background: var(--panel-2);
  }
  td { background: var(--panel); color: var(--text); }
  .cells td:nth-child(3) {
    width: 7.5rem;
    min-width: 7.5rem;
    white-space: nowrap;
  }
  .status-cell {
    white-space: nowrap !important;
    vertical-align: middle !important;
  }
  .status-cell .status-text {
    white-space: nowrap;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .status-cell .status-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 8px;
    vertical-align: 1px;
  }
  .status-cell.supported {
    background: color-mix(in srgb, var(--ok) 18%, var(--panel));
    color: var(--text);
  }
  .status-cell.supported .status-dot { background: var(--ok); box-shadow: 0 0 10px color-mix(in srgb, var(--ok) 55%, transparent); }
  .status-cell.missing {
    background: var(--panel-2);
    color: var(--muted);
  }
  .status-cell.missing .status-dot { background: var(--muted); }
  .status-cell.contradicts {
    background: color-mix(in srgb, var(--warn) 16%, var(--panel));
    color: var(--text);
  }
  .status-cell.contradicts .status-dot { background: var(--warn); box-shadow: 0 0 10px color-mix(in srgb, var(--warn) 45%, transparent); }
  .conclusion {
    margin: 0;
    color: var(--accent);
    font-size: 1.05rem;
    font-weight: 700;
  }
  .media { margin: 12px 0 0; }
  .media img, .media video {
    display: block;
    width: 100%;
    max-height: 420px;
    object-fit: contain;
    border-radius: 12px;
    background: var(--panel-2);
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
  }
  .media audio { width: 100%; }
  .media figcaption, .media-page a {
    display: block;
    margin-top: 6px;
    color: var(--muted);
    font-size: 12px;
    word-break: break-all;
  }
  .media-page a { color: var(--accent); }
  .charts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 14px;
  }
  .chart-card {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 14px;
    min-height: 168px;
  }
  .chart-card h3 {
    margin: 0 0 12px;
    font-size: 12px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
    font-weight: 700;
  }
  .hbar {
    display: grid;
    gap: 10px;
  }
  .hbar-row {
    display: grid;
    grid-template-columns: 64px 1fr auto;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
  }
  .hbar-track {
    height: 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--line) 35%, var(--panel));
    overflow: hidden;
  }
  .hbar-fill { display: block; height: 100%; border-radius: 999px; }
  .hbar-fill.grab { background: var(--accent); }
  .hbar-fill.product { background: var(--warn); }
  .hbar-fill.output { background: var(--ok); }
  .vbars {
    display: flex;
    align-items: flex-end;
    gap: 18px;
    height: 110px;
    padding-top: 8px;
  }
  .vbar {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    height: 100%;
    justify-content: flex-end;
  }
  .vbar .shaft {
    width: 100%;
    max-width: 42px;
    height: 100%;
    display: flex;
    align-items: flex-end;
    background: color-mix(in srgb, var(--line) 28%, var(--panel));
    border-radius: 10px 10px 4px 4px;
    overflow: hidden;
  }
  .vbar .fill {
    width: 100%;
    border-radius: 10px 10px 4px 4px;
  }
  .vbar .fill.estimated { background: linear-gradient(180deg, color-mix(in srgb, var(--warn) 70%, white), var(--warn)); }
  .vbar .fill.actual { background: linear-gradient(180deg, color-mix(in srgb, var(--ok) 70%, white), var(--ok)); }
  .vbar span { font-size: 11px; color: var(--muted); }
  .donut-wrap {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 10px;
    align-items: center;
  }
  .donut { width: 110px; height: 110px; transform: rotate(-90deg); }
  .legend { display: grid; gap: 8px; font-size: 12px; color: var(--muted); }
  .legend i {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
  }
  .legend .g { background: var(--accent); }
  .legend .p { background: var(--warn); }
  .legend .o { background: var(--ok); }
  .track {
    display: inline-block;
    width: min(240px, 42vw);
    height: 14px;
    background: color-mix(in srgb, var(--line) 35%, var(--panel));
    vertical-align: middle;
    border-radius: 7px;
    overflow: hidden;
  }
  .spend-line { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 0 0 8px; }
  .bar { display: block; height: 14px; }
  .bar.estimated { background: var(--warn); }
  .bar.actual { background: var(--ok); }
  .note { color: var(--muted); font-size: 13px; margin: 10px 0 0; }
  @media (max-width: 860px) {
    .charts { grid-template-columns: 1fr; }
    .budget-stats { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 720px) {
    .shell { padding: 16px 12px 0; }
    .card-head { flex-direction: column; }
    .cells td:nth-child(3) { width: auto; min-width: 6.5rem; }
    .budget-stats { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="shell">
<header class="hero">
  <p class="brand">${escapeHtml(labels.title)}</p>
  <p class="hero-line">${escapeHtml(session.userText)}</p>
  <p class="hero-foot">
    <span class="language" data-language="${escapeAttr(code)}">${escapeHtml(labels.language)} ${escapeHtml(code)}</span>
    ·
    <span class="settings">${escapeHtml(labels.settings)} ${escapeHtml(settingsRelativePath)}</span>
    ·
    <span class="delivery">delivery=${escapeHtml(session.deliveryStatus)} · rev=${session.revision}</span>
  </p>
</header>
<section class="original">
<h1>${escapeHtml(labels.original)}</h1>
<p class="original-text">${escapeHtml(session.userText)}</p>
</section>
${deliveryMeta}
<section>
<h1>${escapeHtml(labels.budget)}</h1>
${budgetStats}
<table class="budget">
<thead><tr><th>${escapeHtml(labels.grabbedFiles)}</th><th>${escapeHtml(labels.grabChars)}</th><th>${escapeHtml(labels.productChars)}</th><th>${escapeHtml(labels.expectedOutputChars)}</th><th>${escapeHtml(labels.expectedTokens)}</th></tr></thead>
<tbody>
${budgetRow}
</tbody>
</table>
</section>
<section>
<h1>${escapeHtml(labels.who)}</h1>
<div class="grabbed">
${grabbedRows}
</div>
</section>
<section>
<h1>${escapeHtml(labels.think)}</h1>
<div class="think">
${thinkRows}
</div>
</section>
<section>
<h1>${escapeHtml(labels.cells)}</h1>
<table class="cells">
<thead><tr><th>${escapeHtml(labels.option)}</th><th>${escapeHtml(labels.constraint)}</th><th>${escapeHtml(labels.status)}</th><th>${escapeHtml(labels.quote)}</th></tr></thead>
<tbody>
${cellRows}
${conclusionRow}
</tbody>
</table>
</section>
<section>
<h1>${escapeHtml(labels.work)}</h1>
<div class="work">
${workRows}
</div>
</section>
<section>
<h1>${escapeHtml(labels.spend)}</h1>
<div class="charts">
  <div class="chart-card">
    <h3>${escapeHtml(labels.chartChars)}</h3>
    <div class="hbar">
      <div class="hbar-row"><span>${escapeHtml(labels.grabChars)}</span><div class="hbar-track"><span class="hbar-fill grab" style="width:${barPercent(grabChars, charMax)}%"></span></div><strong>${grabChars}</strong></div>
      <div class="hbar-row"><span>${escapeHtml(labels.productChars)}</span><div class="hbar-track"><span class="hbar-fill product" style="width:${barPercent(productChars, charMax)}%"></span></div><strong>${productChars}</strong></div>
      <div class="hbar-row"><span>${escapeHtml(labels.output)}</span><div class="hbar-track"><span class="hbar-fill output" style="width:${barPercent(outputChars, charMax)}%"></span></div><strong>${outputChars}</strong></div>
    </div>
  </div>
  <div class="chart-card">
    <h3>${escapeHtml(labels.chartTokens)}</h3>
    <div class="vbars">
      <div class="vbar"><div class="shaft"><div class="fill estimated" style="height:${barPercent(expectedTokens, widest)}%"></div></div><span>${expectedTokens}</span></div>
      <div class="vbar"><div class="shaft"><div class="fill actual" style="height:${barPercent(actualTokens, widest)}%"></div></div><span>${actualTokens}</span></div>
    </div>
  </div>
  <div class="chart-card">
    <h3>${escapeHtml(labels.chartShare)}</h3>
    <div class="donut-wrap">
      ${donut}
      <div class="legend">
        <div><i class="g"></i>${escapeHtml(labels.grabChars)} ${grabShare}%</div>
        <div><i class="p"></i>${escapeHtml(labels.productChars)} ${productShare}%</div>
        <div><i class="o"></i>${escapeHtml(labels.output)} ${outputShare}%</div>
      </div>
    </div>
  </div>
</div>
<table class="spend">
<tbody>
${spendRow}
</tbody>
</table>
<p class="note">${escapeHtml(labels.estimateNote)}</p>
</section>
</div>
</body>
</html>
`;
  await writeFile(path.join(dir, "board.html"), html, "utf8");
}

function productSource(evidence: Evidence[], runPath: string): string {
  return evidence
    .filter((item) => item.kind === "file" && item.path === runPath)
    .map((item) => item.text)
    .join("\n");
}

function sliceShown(grab: string, stdout: string, source: string): boolean {
  const size = Math.min(grabSlice, grab.length);
  if (size === 0) return false;
  for (let index = 0; index <= grab.length - size; index += 1) {
    const slice = grab.slice(index, index + size);
    if (stdout.includes(slice) && !source.includes(slice)) return true;
  }
  return false;
}

function isGrabEcho(quote: string, grabs: Evidence[]): boolean {
  const texts = grabs.map((item) => item.text);
  if (texts.some((text) => text === quote)) return true;
  const joined = [
    texts.join(""),
    texts.join("\n"),
    texts.join("+"),
  ];
  return joined.includes(quote);
}

const productPathPattern =
  /(?:^|[\s"'`=(])((?:artifacts[\\/][A-Za-z0-9_-]+[\\/])?(?:out[\\/])?[A-Za-z0-9._-]+\.(?:html?|js|mjs|cjs|json|txt|md|png|jpe?g|gif|webp|mp4|webm|mp3|wav))/gi;

function stdoutProductPaths(stdout: string): string[] {
  const found: string[] = [];
  for (const match of stdout.matchAll(productPathPattern)) {
    const raw = match[1];
    if (!raw) continue;
    found.push(raw.replaceAll("\\", "/"));
  }
  return found;
}

function isReservedArtifactPath(rel: string): boolean {
  const normalized = rel.replaceAll("\\", "/").toLowerCase();
  return (
    normalized.includes("/grabs/") ||
    normalized.includes("/think/") ||
    normalized.includes("/snapshots/") ||
    normalized.endsWith("/board.html") ||
    normalized === "board.html"
  );
}

function underOutPath(sessionId: string, rel: string): boolean {
  const normalized = rel.replaceAll("\\", "/");
  const prefix = `artifacts/${sessionId}/out/`;
  if (normalized.startsWith(prefix)) return true;
  if (normalized.startsWith("out/")) return true;
  // bare filename inside out/ is checked by existence under out/
  if (!normalized.includes("/")) return true;
  return false;
}

function tryProductExists(
  sessionId: string,
  root: string | undefined,
  stdout: string,
): boolean {
  if (!root || !sessionIdPattern.test(sessionId)) return false;
  const outRoot = outDirFor(sessionId, root);
  for (const raw of stdoutProductPaths(stdout)) {
    const prefix = `artifacts/${sessionId}/`;
    const rel = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
    if (rel.includes("..") || /^[a-z][a-z0-9+.-]*:/i.test(rel)) continue;
    if (isReservedArtifactPath(rel)) continue;
    if (!underOutPath(sessionId, raw.startsWith(prefix) ? raw : `out/${rel}`)) continue;
    const underOut = rel.startsWith("out/") ? rel.slice(4) : rel;
    const full = path.resolve(outRoot, underOut);
    try {
      const real = realpathSync(full);
      const base = realpathSync(outRoot);
      const inside = path.relative(base, real);
      if (inside.startsWith("..") || path.isAbsolute(inside)) continue;
      if (isReservedArtifactPath(inside.replaceAll("\\", "/"))) continue;
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function supportGrounded(
  quote: Quote,
  marks: SourceMark[],
  evidence: Evidence[],
  session?: Session,
  root?: string,
): boolean {
  if (quote.relation !== "supports") return true;
  const constraint = marks.find((mark) => mark.id === quote.markId);
  if (!constraint || constraint.kind !== "constraint") return true;
  const code = constraintCodeOf(constraint);
  if (code === "join" || constraint.text === joinConstraint) {
    if (!grabsReady(evidence)) return false;
    return evidence.some((item) => item.kind === "grab" && item.text.includes(quote.quote));
  }
  if (code === "try" || constraint.text === tryConstraint) {
    if (!grabsReady(evidence)) return false;
    const grabs = evidence.filter((item) => item.kind === "grab");
    if (isGrabEcho(quote.quote, grabs)) return false;
    const requireAccept = !session || session.mode === "ideaKing";
    if (requireAccept && !acceptEvidenceSupportsQuote(evidence, quote.quote)) {
      return false;
    }
    return evidence.some((item) => {
      if (item.stale) return false;
      if (requireAccept) {
        const fromAccept =
          (item.kind === "accept" && item.acceptOk === true) ||
          (item.kind === "run" && item.acceptOk === true && item.exitCode === 0);
        if (!fromAccept || !item.text.includes(quote.quote)) return false;
      } else if (item.kind !== "run" || item.exitCode !== 0 || !item.text.includes(quote.quote)) {
        return false;
      }
      const source = productSource(evidence, item.path);
      if (source.includes(quote.quote)) return false;
      if (grabs.some((grab) => grab.text.includes(quote.quote))) return false;
      const run =
        item.kind === "run"
          ? item
          : evidence.find(
              (row) =>
                row.kind === "run" &&
                row.path === item.path &&
                (!requireAccept || row.acceptOk === true) &&
                !row.stale,
            );
      if (run) {
        if (!grabs.every((grab) => sliceShown(grab.text, run.text, source))) return false;
        if (
          root !== undefined &&
          session &&
          !tryProductExists(session.id, root, run.text)
        ) {
          return false;
        }
      } else if (requireAccept) {
        return false;
      }
      return true;
    });
  }
  return true;
}

export function filterQuotes(
  quotes: Quote[],
  material: string,
  marks: SourceMark[],
  evidence: Evidence[] = [],
  session?: Session,
  root?: string,
): { kept: Quote[]; dropped: string[] } {
  const options = new Set(
    marks.filter((mark) => mark.kind === "option").map((mark) => mark.id),
  );
  const constraints = new Set(
    marks.filter((mark) => mark.kind === "constraint").map((mark) => mark.id),
  );
  const seen = new Set<string>();
  const kept: Quote[] = [];
  const dropped: string[] = [];
  for (const quote of quotes) {
    const key = `${quote.markId}\0${quote.optionId}`;
    const valid =
      quote.quote.length > 0 &&
      material.includes(quote.quote) &&
      options.has(quote.optionId) &&
      constraints.has(quote.markId) &&
      supportGrounded(quote, marks, evidence, session, root) &&
      !seen.has(key);
    if (!valid) {
      dropped.push(quote.quote);
      continue;
    }
    seen.add(key);
    kept.push(quote);
  }
  return { kept, dropped };
}

export function applyQuotes(marks: SourceMark[], quotes: Quote[]): Cell[] {
  const cells = blankCells(marks);
  for (const quote of quotes) {
    const cell = cells.find(
      (item) => item.markId === quote.markId && item.optionId === quote.optionId,
    );
    if (!cell || cell.evidenceQuote) continue;
    cell.status = quote.relation === "supports" ? "supported" : "contradicts";
    cell.scent = 1;
    cell.evidenceQuote = quote.quote;
  }
  return cells;
}

export function eraseUnsupported(cells: Cell[], material: string): Cell[] {
  return cells.map((cell) => {
    if (!cell.evidenceQuote) return cell;
    if (cell.evidenceQuote.length > 0 && material.includes(cell.evidenceQuote)) {
      return cell;
    }
    return { ...cell, status: "missing" as const, scent: 1 as const, evidenceQuote: null };
  });
}

export function applyAudience(
  cells: Cell[],
  report: AudienceReport,
  marks: SourceMark[],
): Cell[] {
  const zero = new Set<string>();
  for (const mark of marks) {
    if (mark.kind !== "constraint") continue;
    const matched = memoryClaim.exec(mark.text);
    if (!matched) continue;
    if (matched[1] !== report.remembered) zero.add(mark.id);
  }
  return cells.map((cell) =>
    zero.has(cell.markId) ? { ...cell, scent: 0 as const } : cell,
  );
}

export function judge(visibleCells: Cell[], marks: SourceMark[]): Verdict {
  const options = marks.filter((mark) => mark.kind === "option");
  const constraints = marks.filter((mark) => mark.kind === "constraint");
  const at = (markId: string, optionId: string) =>
    visibleCells.find(
      (cell) => cell.markId === markId && cell.optionId === optionId && cell.scent === 1,
    );

  const eliminated = new Set<string>();
  for (const option of options) {
    for (const constraint of constraints) {
      const cell = at(constraint.id, option.id);
      if (cell?.status === "contradicts") eliminated.add(option.id);
    }
  }

  const remaining = options.filter((option) => !eliminated.has(option.id));
  for (const constraint of constraints) {
    for (const option of remaining) {
      const cell = at(constraint.id, option.id);
      if (cell?.status === "missing") {
        return { type: "refuse", missingMarkId: constraint.id };
      }
    }
  }

  const visibleConstraints = constraints.filter((constraint) =>
    visibleCells.some((cell) => cell.markId === constraint.id && cell.scent === 1),
  );
  if (remaining.length === 1 && visibleConstraints.length > 0) {
    const winner = remaining[0];
    if (!winner) return { type: "refuse_tie" };
    const winnerReady = visibleConstraints.every(
      (constraint) => at(constraint.id, winner.id)?.status === "supported",
    );
    if (winnerReady) {
      const deciding = constraints.find((constraint) => {
        const winnerCell = at(constraint.id, winner.id);
        if (winnerCell?.status !== "supported") return false;
        return [...eliminated].every(
          (optionId) => at(constraint.id, optionId)?.status === "contradicts",
        );
      });
      if (deciding) {
        return { type: "select", optionId: winner.id, decidingMarkId: deciding.id };
      }
    }
  }

  return { type: "refuse_tie" };
}

export function evaporate(cells: Cell[], verdict: Verdict): Cell[] {
  if (verdict.type === "select") {
    return cells.filter((cell) => cell.markId === verdict.decidingMarkId && cell.scent === 1);
  }
  if (verdict.type === "refuse") {
    return cells.filter(
      (cell) => cell.markId === verdict.missingMarkId && cell.status === "missing",
    );
  }
  return cells.filter((cell) => cell.scent === 1);
}

export function memoryScentFailed(session: Session): boolean {
  return session.lastRoundCells.some((cell) => {
    const mark = session.marks.find((item) => item.id === cell.markId);
    if (!mark || mark.kind !== "constraint") return false;
    return constraintCodeOf(mark) === "memory" && cell.scent === 0;
  });
}

export function allHardConstraintsSupported(session: Session): boolean {
  const constraints = session.marks.filter((mark) => mark.kind === "constraint");
  const options = session.marks.filter((mark) => mark.kind === "option");
  const spark =
    options.find((mark) => optionRoleOf(mark, options) === "spark") ?? options[1];
  if (!spark) return false;
  for (const constraint of constraints) {
    const cell = session.lastRoundCells.find(
      (item) => item.markId === constraint.id && item.optionId === spark.id,
    );
    if (!cell || cell.status !== "supported" || cell.scent !== 1) return false;
  }
  return true;
}

export function artifactHashForDelivery(session: Session): string | null {
  const accept = [...session.evidence]
    .reverse()
    .find((item) => item.kind === "accept" && item.acceptOk === true && !item.stale);
  if (accept?.contentHash) return accept.contentHash;
  const file = [...session.evidence]
    .reverse()
    .find((item) => item.kind === "file" && !item.stale);
  return file?.contentHash ?? null;
}

export function resolveDeliveryStatus(session: Session): Session["deliveryStatus"] {
  const verdict = session.verdict;
  if (!verdict) return "incomplete";
  if (verdict.type === "refuse" || verdict.type === "refuse_tie") return "refused";
  if (verdict.type === "select") {
    if (session.mode === "ideaKing") {
      if (memoryScentFailed(session) || !allHardConstraintsSupported(session)) {
        return "incomplete";
      }
      const provenance = session.audience?.provenance ?? "unknown";
      // sim / unknown are rehearsal only — delivered needs a real receipt bound to the accepted digest.
      if (provenance !== "real") return "incomplete";
      const expectedHash = artifactHashForDelivery(session);
      if (!expectedHash) return "incomplete";
      if (session.audience?.artifactHash && session.audience.artifactHash !== expectedHash) {
        return "incomplete";
      }
      const receipt = session.audience?.receipt?.trim() ?? "";
      if (!receipt || receipt !== expectedHash) return "incomplete";
      return "delivered";
    }
    if (memoryScentFailed(session)) return "incomplete";
    return "selected";
  }
  return "incomplete";
}

export function verdictSentence(session: Session, root?: string): string | null {
  const verdict = session.verdict;
  if (!verdict && !session.stopped && session.voidCount === 0) return null;
  const { labels } = resolveLabels(session.userText, root);
  if (!verdict) return labels.noConclusion;
  if (verdict.type === "refuse_tie") return labels.refuseTie;
  if (verdict.type === "select") {
    if (session.deliveryStatus === "incomplete" || memoryScentFailed(session)) {
      return labels.incompleteDelivery;
    }
    if (session.mode === "ideaKing" && !allHardConstraintsSupported(session)) {
      return labels.incompleteDelivery;
    }
    const option = session.marks.find((mark) => mark.id === verdict.optionId);
    const condition = session.marks.find((mark) => mark.id === verdict.decidingMarkId);
    return fillLabel(labels.selected, {
      option: option?.text ?? "",
      condition: condition?.text ?? "",
    });
  }
  const missing = session.marks.find((mark) => mark.id === verdict.missingMarkId);
  return fillLabel(labels.missingOnly, { missing: missing?.text ?? "" });
}
