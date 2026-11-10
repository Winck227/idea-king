import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTaskRole, appendTaskLog, applyRevisionCounters, buildCrewPlan, checkLimits,
  enforceToolAccess, inferPhase, isValidRevision, roleAllowsTool, syncPhase,
} from "../src/crew.ts";
import type { Session, SourceMark } from "../src/schema.ts";
import { blankSession, ev } from "./fixtures.ts";

const options: SourceMark[] = [
  { id: "literal", kind: "option", text: "Literal", scent: 1, role: "literal", code: null, replacedId: null },
  { id: "spark", kind: "option", text: "Spark", scent: 1, role: "spark", code: null, replacedId: null },
];
function session(size = 5): Session {
  return blankSession("s_crew", {
    mode: "ideaKing", crewSize: size, crewPlan: buildCrewPlan(size), marks: options,
    createdAt: Date.now(),
  });
}
function completeThinking(value: Session): Session {
  let next = value;
  for (const member of value.crewPlan!.members.filter((row) => ["gather", "analyze", "critique"].includes(row.role))) {
    next = appendTaskLog(next, { role: member.role, phase: "think", tool: "deposit_think", ok: true });
  }
  return syncPhase(next);
}
function makeReady(): Session {
  let next = completeThinking(session());
  next.evidence = [ev({ id: "f", kind: "file", path: "work.cjs", text: "code", exitCode: null, elapsedMs: null, role: null, contentHash: null, byteLength: 4, realPath: null })];
  next = appendTaskLog(next, { role: "maker", phase: "make", tool: "deposit_file", ok: true });
  next.productManifest = { type: "page", entry: "page.html", inputs: [], expected: {}, action: "open" };
  next = appendTaskLog(next, { role: "maker", phase: "make", tool: "deposit_manifest", ok: true });
  return syncPhase(next);
}

test("crew plan is bounded and preserves ordered task slots", () => {
  const plan = buildCrewPlan(1_000_000);
  assert.equal(plan.size, 12);
  assert.equal(plan.members.length, 12);
  assert.equal(plan.members[0]!.role, "spark");
  assert.equal(plan.members.at(-2)!.role, "maker");
  assert.equal(plan.members.at(-1)!.role, "finisher");
  assert.deepEqual(plan.members.map((row) => row.slot), Array.from({ length: 12 }, (_, i) => i));
});

test("two grabs before frozen marks still belong to spark", () => {
  const value = session();
  value.marks = [];
  value.evidence = ["a", "b"].map((id) => ev({ id, kind: "grab", path: `${id}.txt`, text: id, exitCode: null, elapsedMs: null, role: null, contentHash: null, byteLength: 1, realPath: null }));
  assert.equal(inferPhase(value), "spark");
  assert.equal(activeTaskRole(value), "spark");
  assert.equal(enforceToolAccess(value, "confirm_marks"), null);
  assert.equal(enforceToolAccess(value, "deposit_file"), "phase_denied");
});

test("callerRole is only an assertion and cannot grant host or another role's powers", () => {
  const value = completeThinking(session());
  assert.equal(activeTaskRole(value), "maker");
  assert.equal(enforceToolAccess(value, "deposit_file"), null);
  assert.equal(enforceToolAccess(value, "deposit_file", "host"), "role_denied");
  assert.equal(enforceToolAccess(value, "deposit_file", "finisher"), "role_denied");
  assert.equal(enforceToolAccess(value, "deposit_run"), "phase_denied");
  assert.equal(roleAllowsTool(value, "commit_round", "host"), false);
});

test("each successful thought completes its assigned slot and exposes the next role", () => {
  let value = session(6);
  assert.equal(activeTaskRole(value), "gather");
  assert.equal(enforceToolAccess(value, "deposit_think", "analyze"), "role_denied");
  value = appendTaskLog(value, { role: "gather", phase: "think", tool: "deposit_think", ok: true });
  assert.equal(value.taskLog.at(-1)!.slot, 1);
  assert.equal(activeTaskRole(value), "analyze");
  value = appendTaskLog(value, { role: "analyze", phase: "think", tool: "deposit_think", ok: true });
  assert.equal(value.taskLog.at(-1)!.slot, 2);
  assert.equal(activeTaskRole(value), "critique");
  value = appendTaskLog(value, { role: "critique", phase: "think", tool: "deposit_think", ok: true });
  assert.equal(value.taskLog.at(-1)!.slot, 3);
  assert.equal(inferPhase(value), "make");
});

test("failed thoughts and add_fact events do not complete a thought slot", () => {
  let value = session();
  value = appendTaskLog(value, { role: "gather", phase: "think", tool: "deposit_think", ok: false });
  value = appendTaskLog(value, { role: "gather", phase: "think", tool: "add_fact", ok: true });
  assert.equal(activeTaskRole(value), "gather");
});

test("a new semantic revision requires fresh thought slots", () => {
  const completed = completeThinking(session());
  assert.equal(inferPhase(completed), "make");
  const next = { ...completed, revisionCount: completed.revisionCount + 1 };
  assert.equal(inferPhase(next), "think");
  assert.equal(activeTaskRole(next), "gather");
});

test("maker remains active until both file and manifest were registered in this revision", () => {
  const ready = makeReady();
  assert.equal(inferPhase(ready), "finish");
  const missingManifest = { ...ready, taskLog: ready.taskLog.filter((row) => row.tool !== "deposit_manifest") };
  assert.equal(inferPhase(missingManifest), "make");
  assert.equal(activeTaskRole(missingManifest), "maker");
  const revised = { ...ready, crewSize: 3, crewPlan: buildCrewPlan(3), revisionCount: 1 };
  assert.equal(inferPhase(revised), "make");
});

test("delivered sessions accept only reads, facts that clear delivery, and spark revision", () => {
  const value = { ...makeReady(), deliveryStatus: "delivered" as const };
  assert.equal(enforceToolAccess(value, "get_session"), null);
  assert.equal(enforceToolAccess(value, "confirm_marks"), null);
  assert.equal(enforceToolAccess(value, "add_fact"), null);
  assert.equal(enforceToolAccess(value, "confirm_marks", "finisher"), "role_denied");
  for (const tool of ["deposit_grab", "deposit_file", "deposit_manifest", "deposit_run", "commit_round"]) {
    assert.equal(enforceToolAccess(value, tool), "phase_denied", tool);
  }
});

test("the fourth revision is rejected before mutation, while the third can still be made and run", () => {
  const value = { ...makeReady(), revisionCount: 3 };
  assert.equal(checkLimits(value, "confirm_marks"), "limit_exceeded");
  assert.equal(checkLimits(value, "deposit_file"), null);
  assert.equal(checkLimits(value, "deposit_run"), null);
});

test("repeating a replacement record does not manufacture another valid revision", () => {
  const before = session();
  const after = { ...before, marks: before.marks.map((mark) => mark.role === "spark" ? { ...mark, id: "replacement", text: "Smaller", replacedId: mark.id } : mark) };
  assert.equal(isValidRevision(before, after), true);
  const counted = applyRevisionCounters(before, after, (current) => current);
  assert.equal(counted.revisionCount, 1);
  assert.equal(isValidRevision(counted, { ...counted }), false);
  assert.equal(applyRevisionCounters(counted, { ...counted }, (current) => current).revisionCount, 1);
});
