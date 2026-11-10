import { randomUUID } from "node:crypto";
import type { CallerRole, CrewPhase, CrewPlan, Session, TaskLogEntry, ToolError } from "./schema.ts";

const defaultMaxRevisions = 3;
const defaultMaxVoid = 2;
const defaultWallClockMs = 30 * 60 * 1000;
const maxCrewSize = 12;
const phaseOrder: CrewPhase[] = ["spark", "think", "make", "finish", "commit", "done"];
const roleTools: Record<CallerRole, ReadonlySet<string>> = {
  spark: new Set(["deposit_grab", "add_fact", "confirm_marks"]),
  gather: new Set(["deposit_grab", "deposit_think", "add_fact"]),
  analyze: new Set(["deposit_think", "add_fact"]),
  critique: new Set(["deposit_think", "add_fact"]),
  maker: new Set(["deposit_file", "deposit_manifest"]),
  finisher: new Set(["deposit_run", "commit_round"]),
  host: new Set(),
};

export function buildCrewPlan(crewSize: number): CrewPlan {
  const size = Math.min(maxCrewSize, Math.max(3, Math.floor(Number.isFinite(crewSize) ? crewSize : 5)));
  const members: CrewPlan["members"] = [{ role: "spark", slot: 0 }];
  const roles: CallerRole[] = ["gather", "analyze", "critique"];
  for (let i = 0; i < size - 3; i += 1) members.push({ role: roles[i % roles.length]!, slot: i + 1 });
  members.push({ role: "maker", slot: size - 2 }, { role: "finisher", slot: size - 1 });
  return { size, members, maxRevisions: defaultMaxRevisions, maxVoid: defaultMaxVoid, wallClockMs: defaultWallClockMs };
}

export function freezeCrewAtCreate(session: Session, crewSize: number): Session {
  const plan = buildCrewPlan(crewSize);
  return { ...session, crewSize: plan.size, crewPlan: plan, phase: "spark", taskLog: [], createdAt: Date.now(), revisionCount: 0 };
}

function currentLogs(session: Session): TaskLogEntry[] {
  return session.taskLog.filter((entry) => entry.ok && entry.revision === session.revisionCount);
}

function pendingThinkSlot(session: Session): CrewPlan["members"][number] | undefined {
  const plan = session.crewPlan ?? buildCrewPlan(session.crewSize);
  const logs = currentLogs(session);
  return plan.members.find((member) =>
    ["gather", "analyze", "critique"].includes(member.role) &&
    !logs.some((entry) => entry.slot === member.slot && entry.role === member.role && entry.tool === "deposit_think"),
  );
}

export function inferPhase(session: Session): CrewPhase {
  if (session.deliveryStatus === "delivered") return "done";
  if (session.mode !== "ideaKing") return session.phase;
  const options = session.marks.filter((mark) => mark.kind === "option");
  if (options.length !== 2 || !options.some((mark) => mark.role === "literal") || !options.some((mark) => mark.role === "spark")) return "spark";
  if (pendingThinkSlot(session)) return "think";
  const logs = currentLogs(session);
  const hasFile = session.evidence.some((item) => item.kind === "file" && !item.stale) && logs.some((entry) => entry.role === "maker" && entry.tool === "deposit_file");
  const hasManifest = session.productManifest !== null && logs.some((entry) => entry.role === "maker" && entry.tool === "deposit_manifest");
  if (!hasFile || !hasManifest) return "make";
  const hasRun = session.evidence.some((item) => item.kind === "run" && !item.stale);
  const hasAccept = session.evidence.some((item) => item.kind === "accept" && !item.stale);
  return hasRun && hasAccept ? "commit" : "finish";
}

export function syncPhase(session: Session): Session {
  return { ...session, phase: inferPhase(session) };
}

export function advancePhase(session: Session, next: CrewPhase): Session {
  return phaseOrder.indexOf(next) < phaseOrder.indexOf(session.phase) ? session : { ...session, phase: next };
}

/** The tool task slot is derived from frozen session state, never from a model supplied role. */
export function activeTaskRole(session: Session, tool = ""): CallerRole {
  if (session.mode !== "ideaKing") return "host";
  if (tool === "confirm_marks") return "spark";
  // After think, spark may still add_fact before shrinking/reconfirming options.
  if (tool === "add_fact") {
    const phase = inferPhase(session);
    if (phase === "think") return pendingThinkSlot(session)?.role ?? "spark";
    return "spark";
  }
  const phase = inferPhase(session);
  if (phase === "spark") return "spark";
  if (phase === "think") return pendingThinkSlot(session)?.role ?? "spark";
  if (phase === "make") return "maker";
  return "finisher";
}

function taskSlot(session: Session, entry: Pick<TaskLogEntry, "role" | "tool">): number | null {
  if (session.mode !== "ideaKing") return null;
  if (entry.tool === "deposit_think") {
    const pending = pendingThinkSlot(session);
    return pending?.role === entry.role ? pending.slot : null;
  }
  const plan = session.crewPlan ?? buildCrewPlan(session.crewSize);
  return plan.members.find((member) => member.role === entry.role)?.slot ?? null;
}

export function appendTaskLog(
  session: Session,
  entry: Omit<TaskLogEntry, "id" | "at" | "slot" | "revision"> & Partial<Pick<TaskLogEntry, "id" | "at">>,
): Session {
  const row: TaskLogEntry = {
    ...entry,
    id: entry.id ?? randomUUID(),
    at: entry.at ?? Date.now(),
    slot: taskSlot(session, entry),
    // The generation is the semantic option revision; ordinary save counters do not reset slots.
    revision: session.revisionCount,
  };
  return { ...session, taskLog: [...session.taskLog, row] };
}

export function checkLimits(session: Session, tool: string): ToolError | null {
  const plan = session.crewPlan;
  if (!plan) return null;
  if (session.revisionCount > plan.maxRevisions) return "limit_exceeded";
  if (tool === "confirm_marks" && session.revisionCount >= plan.maxRevisions) return "limit_exceeded";
  if (session.createdAt > 0 && Date.now() - session.createdAt > plan.wallClockMs) return "limit_exceeded";
  if (session.stopped && (tool === "commit_round" || tool === "deposit_run")) return "stopped";
  return null;
}

export function phaseAllowsTool(session: Session, tool: string): boolean {
  if (session.mode !== "ideaKing" || tool === "get_session") return true;
  const phase = inferPhase(session);
  // New facts (and reconfirm) must clear a false delivered state; done is not a write lock on marks.
  if (phase === "done") return tool === "confirm_marks" || tool === "add_fact";
  if (tool === "confirm_marks" || tool === "add_fact") return true;
  return roleTools[activeTaskRole(session, tool)].has(tool);
}

export function roleAllowsTool(session: Session, tool: string, callerRole?: CallerRole | null): boolean {
  if (session.mode !== "ideaKing" || tool === "get_session") return true;
  if (callerRole === "host") return false;
  const assigned = activeTaskRole(session, tool);
  if (callerRole && callerRole !== assigned) return false;
  return roleTools[assigned].has(tool);
}

export function enforceToolAccess(session: Session, tool: string, callerRole?: CallerRole | null): ToolError | null {
  const limit = checkLimits(session, tool);
  if (limit) return limit;
  if (!phaseAllowsTool(session, tool)) return "phase_denied";
  if (!roleAllowsTool(session, tool, callerRole)) return "role_denied";
  return null;
}

export function isValidRevision(before: Session, after: Session): boolean {
  const prior = before.marks.filter((mark) => mark.kind === "option");
  const next = after.marks.filter((mark) => mark.kind === "option");
  if (prior.length !== 2 || next.length !== 2) return false;
  return next.some((mark) => {
    const previous = prior.find((item) => item.role === mark.role);
    return previous && previous.text !== mark.text && previous.id !== mark.id;
  });
}

export function applyRevisionCounters(before: Session, after: Session, clearDelivery: (s: Session) => Session): Session {
  const next = clearDelivery(after);
  return isValidRevision(before, after)
    ? { ...next, stopped: false, voidCount: 0, revisionCount: before.revisionCount + 1 }
    : next;
}