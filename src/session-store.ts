import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { materialFromEvidence } from "./engine.ts";
import { sessionSchema, type Evidence, type Session } from "./schema.ts";

const idPattern = /^[A-Za-z0-9_-]+$/;
const lockWaitMs = 120_000;
const lockDelayMs = 25;
type LockOwner = { pid: number; token: string; createdAt: number };

export class RevisionConflictError extends Error {
  readonly code = "revision_conflict";
  readonly expected: number;
  readonly received: number;
  constructor(expected: number, received: number) {
    super(`revision_conflict:expected=${expected}:received=${received}`);
    this.name = "RevisionConflictError";
    this.expected = expected;
    this.received = received;
  }
}

export function sessionsDir(root = process.cwd()): string {
  return path.join(root, "data", "sessions");
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function evidenceKey(item: Evidence): string {
  if (item.id && item.id.length > 0) return `id:${item.id}`;
  return `${item.kind}\0${item.path}\0${item.text}\0${item.exitCode ?? ""}\0${item.role ?? ""}\0${item.contentHash ?? ""}`;
}

/** Compatibility helper for append-only evidence; real writes use a versioned transaction. */
export function mergeEvidence(incoming: Evidence[], onDisk: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return [...incoming, ...onDisk].filter((item) => {
    const key = evidenceKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mergeSessionForSave(incoming: Session, onDisk: Session | undefined): Session {
  if (!onDisk) {
    if (incoming.revision !== 0) throw new RevisionConflictError(0, incoming.revision);
    return { ...incoming, material: materialFromEvidence(incoming) };
  }
  if (onDisk.id !== incoming.id || incoming.revision !== onDisk.revision) {
    throw new RevisionConflictError(onDisk.revision, incoming.revision);
  }
  const merged = { ...incoming, evidence: mergeEvidence(incoming.evidence, onDisk.evidence) };
  return { ...merged, material: materialFromEvidence(merged) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      raw && typeof raw === "object" && "pid" in raw && "token" in raw && "createdAt" in raw &&
      Number.isSafeInteger(raw.pid) && Number(raw.pid) > 0 &&
      typeof raw.token === "string" && /^[A-Za-z0-9_-]+$/.test(raw.token) &&
      typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
    ) return raw as LockOwner;
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
  }
  return undefined;
}

function ownerDefinitelyDead(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    // EPERM and unknown failures are not proof of death. Never steal a live lock by age.
    return hasCode(error, "ESRCH");
  }
}

async function reclaimDeadOwner(lockPath: string): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (!owner || !ownerDefinitelyDead(owner)) return;
  // Recovery is serialized per abandoned token; reapers never unlink a new owner's lock.
  const recoveryPath = `${lockPath}.recover-${owner.token}`;
  let recovery;
  try {
    recovery = await open(recoveryPath, "wx");
  } catch (error) {
    if (hasCode(error, "EEXIST")) return;
    throw error;
  }
  try {
    const current = await readLockOwner(lockPath);
    if (current?.token === owner.token && ownerDefinitelyDead(current)) {
      await unlink(lockPath).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    }
  } finally {
    await recovery.close();
    await unlink(recoveryPath).catch(() => undefined);
  }
}

async function withSessionLock<T>(root: string, id: string, work: () => Promise<T>): Promise<T> {
  if (!idPattern.test(id)) throw new Error("bad_session_id");
  const dir = sessionsDir(root);
  await mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `${id}.lock`);
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      await reclaimDeadOwner(lockPath);
      if (Date.now() >= deadline) throw new Error("session_lock_timeout");
      await sleep(lockDelayMs);
      continue;
    }
    const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
    try {
      await handle.writeFile(JSON.stringify(owner), "utf8");
      return await work();
    } finally {
      await handle.close();
      // Business failures propagate once; they are never mistaken for lock contention.
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

async function persistUnlocked(session: Session, existing: Session | undefined, root: string): Promise<Session> {
  const merged = mergeSessionForSave(session, existing);
  const checked = sessionSchema.parse({
    ...merged,
    revision: (existing?.revision ?? 0) + 1,
    material: materialFromEvidence(merged),
  });
  const dir = sessionsDir(root);
  const target = path.join(dir, `${session.id}.json`);
  const temp = path.join(dir, `${session.id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(checked, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(temp, target);
    return checked;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** CAS save for trusted callers; stale snapshots fail instead of overwriting another update. */
export async function saveSession(session: Session, root = process.cwd()): Promise<Session> {
  return withSessionLock(root, session.id, async () => {
    const existing = await loadSessionUnlocked(session.id, root);
    return persistUnlocked(session, existing, root);
  });
}

export type SessionMutation<T> = { session: Session; value: T; persist?: boolean };
export type SessionTransaction<T> = { session: Session; value: T } | undefined;

/** Hold the process-shared lock over load, validation, mutation, save and board rendering. */
export async function updateSession<T>(
  id: string,
  updater: (current: Session) => SessionMutation<T> | Promise<SessionMutation<T>>,
  root = process.cwd(),
  afterSave?: (saved: Session) => Promise<void>,
): Promise<SessionTransaction<T>> {
  if (!idPattern.test(id)) return undefined;
  return withSessionLock(root, id, async () => {
    const current = await loadSessionUnlocked(id, root);
    if (!current) return undefined;
    const mutation = await updater(current);
    if (mutation.session.id !== id) throw new Error("transaction_session_id_changed");
    if (mutation.persist === false) return { session: current, value: mutation.value };
    const saved = await persistUnlocked(mutation.session, current, root);
    if (afterSave) await afterSave(saved);
    return { session: saved, value: mutation.value };
  });
}

async function loadSessionUnlocked(id: string, root: string): Promise<Session | undefined> {
  if (!idPattern.test(id)) return undefined;
  let text: string;
  try {
    text = await readFile(path.join(sessionsDir(root), `${id}.json`), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const raw: unknown = JSON.parse(text);
  if (raw && typeof raw === "object" && !("initialMaterial" in raw)) {
    const legacy = raw as Record<string, unknown>;
    legacy.initialMaterial = typeof legacy.material === "string" ? legacy.material : "";
  }
  return sessionSchema.parse(raw);
}

export async function loadSession(id: string, root = process.cwd()): Promise<Session | undefined> {
  return loadSessionUnlocked(id, root);
}