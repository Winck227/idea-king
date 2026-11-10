import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { verifyPageActions, type PageAcceptanceCase } from "./browser-accept.ts";
import { executeProduct } from "./runner.ts";
import { productManifestSchema, type Evidence, type ProductManifest, type Session } from "./schema.ts";

const maxArtifactBytes = 8 * 1024 * 1024;
const maxFileBytes = 2 * 1024 * 1024;
const maxArtifactFiles = 128;
const sessionIdPattern = /^[A-Za-z0-9_-]+$/;

function sha256(raw: string | Buffer): string { return createHash("sha256").update(raw).digest("hex"); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("non_json_value");
  return result;
}

export function parseProductManifest(raw: unknown): ProductManifest | null {
  const parsed = productManifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  try { canonical(parsed.data); } catch { return null; }
  return parsed.data;
}

export function outDirFor(sessionId: string, root: string): string {
  if (!sessionIdPattern.test(sessionId)) throw new Error("invalid_session_id");
  return path.resolve(root, "artifacts", sessionId, "out");
}
export function normalizeEntry(entry: string): string { return entry.replaceAll("\\", "/").replace(/^\.\//, ""); }
export function entryUnderOut(sessionId: string, root: string, entry: string): string | undefined {
  const normalized = normalizeEntry(entry);
  if (!sessionIdPattern.test(sessionId) || !normalized || normalized.includes(":") || normalized.includes("\0") || normalized.split("/").some(part => part === ".." || part === "." || part === "") || path.isAbsolute(normalized)) return undefined;
  const base = outDirFor(sessionId, root);
  const full = path.resolve(base, normalized.startsWith("out/") ? normalized.slice(4) : normalized);
  const rel = path.relative(base, full);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? full : undefined;
}

export async function registerManifest(session: Session, manifest: ProductManifest, root: string): Promise<{ session: Session; error?: "bad_request" }> {
  const checked = parseProductManifest(manifest);
  if (!checked) return { session, error: "bad_request" };
  const full = entryUnderOut(session.id, root, checked.entry);
  if (!full) return { session, error: "bad_request" };
  const base = outDirFor(session.id, root);
  await mkdir(base, { recursive: true });
  const rootReal = await realpath(root);
  const baseReal = await realpath(base);
  const rel = path.relative(rootReal, baseReal);
  if (rel.startsWith("..") || path.isAbsolute(rel) || (await lstat(base)).isSymbolicLink()) return { session, error: "bad_request" };
  const stored = { ...checked, entry: path.relative(base, full).replaceAll("\\", "/") };
  await writeFile(path.join(base, "product.manifest.json"), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  const changed = !session.productManifest || canonical(stored) !== canonical(session.productManifest);
  return { session: changed ? {
    ...session, productManifest: stored, verdict: null, lastRoundCells: [], deliveryStatus: "incomplete", audience: null,
    evidence: session.evidence.map(item => item.kind === "run" || item.kind === "accept" ? { ...item, stale: true, acceptOk: false } : item),
  } : { ...session, productManifest: stored } };
}

export type ArtifactSnapshot = { digest: string; manifestHash: string; entry: string; files: Map<string, Buffer>; byteLength: number };

/** Hash the actual manifest, entry and every packaged resource. Reject links and oversized trees. */
export async function captureArtifacts(session: Session, root: string): Promise<ArtifactSnapshot> {
  const manifest = parseProductManifest(session.productManifest);
  if (!manifest) throw new Error("missing_executable_manifest");
  const base = outDirFor(session.id, root);
  const entryFull = entryUnderOut(session.id, root, manifest.entry);
  if (!entryFull) throw new Error("entry_outside_output");
  if ((await lstat(base)).isSymbolicLink()) throw new Error("linked_output_directory");
  const rootReal = await realpath(root);
  const baseReal = await realpath(base);
  const baseRel = path.relative(rootReal, baseReal);
  if (baseRel.startsWith("..") || path.isAbsolute(baseRel)) throw new Error("output_outside_repository");
  const files = new Map<string, Buffer>();
  let byteLength = 0;
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 8) throw new Error("artifact_tree_too_deep");
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) throw new Error("linked_artifact");
      if (info.isDirectory()) { await visit(full, depth + 1); continue; }
      if (!info.isFile() || info.nlink > 1 || info.size > maxFileBytes || files.size >= maxArtifactFiles) throw new Error("invalid_or_oversized_artifact");
      const resolved = await realpath(full);
      const inside = path.relative(baseReal, resolved);
      if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("artifact_outside_output");
      const data = await readFile(full);
      byteLength += data.length;
      if (byteLength > maxArtifactBytes) throw new Error("artifact_budget_exceeded");
      files.set(path.relative(base, full).replaceAll("\\", "/"), data);
    }
  }
  await visit(base, 0);
  const entry = path.relative(base, entryFull).replaceAll("\\", "/");
  if (!files.get(entry)?.length) throw new Error("missing_or_empty_entry");
  const disk = files.get("product.manifest.json");
  if (!disk || canonical(JSON.parse(disk.toString("utf8"))) !== canonical(manifest)) throw new Error("manifest_mismatch");
  const manifestHash = sha256(canonical(manifest));
  const digest = sha256(canonical({ manifestHash, files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, data]) => [file, sha256(data)]) }));
  return { digest, manifestHash, entry, files, byteLength };
}

type CliCase = { input: string; output: unknown };
function decodeOutput(text: string, schema: string): unknown {
  if (schema === "json") return JSON.parse(text);
  if (schema === "text") return text.replaceAll("\r\n", "\n").replace(/\n$/, "");
  throw new Error("unsupported_output_schema");
}

async function acceptCli(session: Session, manifest: ProductManifest, root: string, before: ArtifactSnapshot): Promise<{ ok: boolean; text: string }> {
  const expected = manifest.expected as { schema?: string; cases?: CliCase[] };
  const cases = expected.cases ?? [];
  if (!expected.schema || !["json", "text"].includes(expected.schema) || cases.length < 2 || cases.length > 8 || new Set(cases.map(row => row.input)).size < 2 || new Set(cases.map(row => canonical(row.output))).size < 2) return { ok: false, text: "accept:cli requires at least two distinct input/output cases and a fixed schema" };
  const script = entryUnderOut(session.id, root, manifest.entry)!;
  const cwd = path.resolve(root, "artifacts", session.id);
  const repeatCases = [...cases, cases[0]!];
  for (let index = 0; index < repeatCases.length; index++) {
    const test = repeatCases[index]!;
    const ran = await executeProduct(script, cwd, outDirFor(session.id, root), [test.input]);
    if (!ran || ran.exitCode !== 0) return { ok: false, text: `accept:cli case ${index + 1} execution failed` };
    let actual: unknown;
    try { actual = decodeOutput(ran.text, expected.schema); } catch { return { ok: false, text: `accept:cli case ${index + 1} invalid ${expected.schema}` }; }
    if (!isDeepStrictEqual(actual, test.output)) return { ok: false, text: `accept:cli case ${index + 1} output mismatch` };
  }
  if ((await captureArtifacts(session, root)).digest !== before.digest) return { ok: false, text: "accept:cli mutated packaged product during verification" };
  return { ok: true, text: `accept:cli ok cases=${cases.length} repeat=1 entry=${before.entry}` };
}

export async function runAcceptor(session: Session, root: string, runEvidence: Evidence): Promise<{ evidence: Evidence; session: Session }> {
  let result: { ok: boolean; text: string };
  let snapshot: ArtifactSnapshot | undefined;
  try {
    if (runEvidence.exitCode !== 0 || runEvidence.stale) throw new Error("producer_run_not_successful");
    snapshot = await captureArtifacts(session, root);
    const manifest = session.productManifest!;
    result = manifest.type === "page"
      ? await verifyPageActions(snapshot.entry, snapshot.files, ((manifest.expected as { pageCases?: PageAcceptanceCase[] }).pageCases ?? []))
      : await acceptCli(session, manifest, root, snapshot);
    if (result.ok && (await captureArtifacts(session, root)).digest !== snapshot.digest) result = { ok: false, text: "accept: product changed during verification" };
  } catch (error) {
    result = { ok: false, text: `accept: ${error instanceof Error ? error.message : "verification_failed"}` };
  }
  const evidence: Evidence = {
    id: randomUUID(), kind: "accept", path: runEvidence.path, text: result.text, exitCode: result.ok ? 0 : 1,
    elapsedMs: null, role: null, contentHash: result.ok ? snapshot!.digest : null, byteLength: snapshot?.byteLength ?? null,
    realPath: null, inode: null, materialHash: runEvidence.materialHash ?? session.materialHash,
    dependencyHashes: runEvidence.dependencyHashes, acceptOk: result.ok, stale: false,
    runId: runEvidence.id, manifestHash: snapshot?.manifestHash ?? null,
  };
  const patched = session.evidence.map(item => item.id === runEvidence.id ? { ...item, acceptOk: result.ok } : item);
  return { evidence, session: { ...session, evidence: [...patched, evidence] } };
}

export async function deliveryArtifactsValid(session: Session, root: string): Promise<boolean> {
  try {
    const accept = [...session.evidence].reverse().find(item => item.kind === "accept" && !item.stale);
    if (!accept?.acceptOk || !accept.contentHash || !accept.runId) return false;
    const run = session.evidence.find(item => item.kind === "run" && item.id === accept.runId && !item.stale && item.exitCode === 0 && item.acceptOk);
    if (!run) return false;
    const actual = await captureArtifacts(session, root);
    return accept.contentHash === actual.digest && accept.manifestHash === actual.manifestHash;
  } catch { return false; }
}

export function acceptEvidenceSupportsQuote(evidence: Evidence[], quote: string): boolean {
  return evidence.some(item => !item.stale && item.acceptOk === true && ((item.kind === "accept" && item.text.includes(quote)) || (item.kind === "run" && item.exitCode === 0 && item.text.includes(quote))));
}
