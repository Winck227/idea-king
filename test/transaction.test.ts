import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { addFact, confirmMarks, createSession, getSession } from "../src/tools.ts";
import { loadSession, RevisionConflictError, saveSession, sessionsDir, updateSession } from "../src/session-store.ts";
import { blankSession } from "./fixtures.ts";

async function fixture() {
  return mkdtemp(path.join(tmpdir(), "idea-king-transaction-"));
}

async function clean(root: string) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith("idea-king-transaction-"));
  await rm(resolved, { recursive: true, force: true });
}

test("public concurrent add_fact transactions retain all facts, material and successful tasks", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "concurrent facts", mode: "lattice" }, root);
    const id = created.sessionId!;
    const texts = Array.from({ length: 8 }, (_, index) => `FACT_${index}`);
    const views = await Promise.all(texts.map((text) => addFact({ sessionId: id, text }, root)));
    assert.ok(views.every((item) => item.error === null));
    const saved = (await loadSession(id, root))!;
    assert.deepEqual(saved.marks.filter((mark) => mark.kind === "fact").map((mark) => mark.text).sort(), texts.sort());
    assert.ok(texts.every((text) => saved.material.includes(text)));
    assert.equal(saved.taskLog.filter((item) => item.tool === "add_fact" && item.ok).length, texts.length);
    assert.equal(new Set(views.map((item) => item.revision)).size, texts.length);
    const board = await readFile(path.join(root, "artifacts", id, "board.html"), "utf8");
    assert.ok(board.includes(`revision=${saved.revision}`));
  } finally { await clean(root); }
});

test("public concurrent confirm_marks transactions retain both independent mark updates", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "concurrent marks", mode: "lattice" }, root);
    const id = created.sessionId!;
    const responses = await Promise.all([
      confirmMarks({ sessionId: id, marks: [{ kind: "option", text: "A" }] }, root),
      confirmMarks({ sessionId: id, marks: [{ kind: "option", text: "B" }, { kind: "constraint", text: "C" }] }, root),
    ]);
    assert.ok(responses.every((item) => item.error === null));
    assert.deepEqual((await loadSession(id, root))!.marks.map((item) => item.text).sort(), ["A", "B", "C"]);
  } finally { await clean(root); }
});

test("saveSession rejects a stale revision without overwriting committed facts", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "CAS", mode: "lattice" }, root);
    const stale = (await loadSession(created.sessionId!, root))!;
    await addFact({ sessionId: stale.id, text: "COMMITTED" }, root);
    await assert.rejects(saveSession(stale, root), RevisionConflictError);
    assert.ok((await loadSession(stale.id, root))!.material.includes("COMMITTED"));
  } finally { await clean(root); }
});

test("initial material remains available after creation and later mutations", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "material", mode: "lattice", material: "INITIAL_MATERIAL" }, root);
    assert.equal((await loadSession(created.sessionId!, root))!.initialMaterial, "INITIAL_MATERIAL");
    await addFact({ sessionId: created.sessionId!, text: "NEW_FACT" }, root);
    const saved = (await loadSession(created.sessionId!, root))!;
    assert.ok(saved.material.includes("INITIAL_MATERIAL"));
    assert.ok(saved.material.includes("NEW_FACT"));
  } finally { await clean(root); }
});

test("legacy sessions retain their material when first updated", async () => {
  const root = await fixture();
  try {
    const raw: Record<string, unknown> = { ...blankSession("s_legacy", { material: "LEGACY_MATERIAL" }) };
    delete raw.initialMaterial;
    await mkdir(sessionsDir(root), { recursive: true });
    await writeFile(path.join(sessionsDir(root), "s_legacy.json"), JSON.stringify(raw));
    await addFact({ sessionId: "s_legacy", text: "NEW_FACT" }, root);
    const saved = (await loadSession("s_legacy", root))!;
    assert.equal(saved.initialMaterial, "LEGACY_MATERIAL");
    assert.ok(saved.material.includes("LEGACY_MATERIAL"));
    assert.ok(saved.material.includes("NEW_FACT"));
  } finally { await clean(root); }
});

test("business errors propagate once and release the transaction lock", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "failure", mode: "lattice" }, root);
    let calls = 0;
    const sentinel = new Error("ORIGINAL_BUSINESS_FAILURE");
    await assert.rejects(updateSession(created.sessionId!, () => { calls += 1; throw sentinel; }, root), (error) => error === sentinel);
    assert.equal(calls, 1);
    assert.equal((await getSession(created.sessionId!, root)).error, null);
    assert.ok((await readdir(sessionsDir(root))).every((name) => !name.endsWith(".lock") && !name.endsWith(".tmp")));
  } finally { await clean(root); }
});

test("invalid session data preserves the schema error and does not leave temporary files", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "invalid", mode: "lattice" }, root);
    const good = (await loadSession(created.sessionId!, root))!;
    const invalid = { ...good, crewSize: -1 };
    await assert.rejects(saveSession(invalid, root), (error: unknown) => error instanceof Error && error.name === "ZodError");
    assert.equal((await loadSession(good.id, root))!.crewSize, good.crewSize);
    assert.ok((await readdir(sessionsDir(root))).every((name) => !name.endsWith(".lock") && !name.endsWith(".tmp")));
  } finally { await clean(root); }
});

test("an old lock held by a live process is never stolen by time", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "live owner", mode: "lattice" }, root);
    const lock = path.join(sessionsDir(root), `${created.sessionId}.lock`);
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "live_owner", createdAt: 1 }));
    let completed = false;
    const request = addFact({ sessionId: created.sessionId!, text: "AFTER_RELEASE" }, root).then((result) => { completed = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(completed, false);
    await unlink(lock);
    assert.equal((await request).error, null);
  } finally { await clean(root); }
});

test("a well-formed lock left by a dead process is safely reclaimed", async () => {
  const root = await fixture();
  try {
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
      child.on("error", reject);
      child.on("exit", () => resolve(child.pid!));
    });
    const created = await createSession({ userText: "dead owner", mode: "lattice" }, root);
    const lock = path.join(sessionsDir(root), `${created.sessionId}.lock`);
    await writeFile(lock, JSON.stringify({ pid: deadPid, token: "dead_owner", createdAt: Date.now() }));
    assert.equal((await addFact({ sessionId: created.sessionId!, text: "RECOVERED" }, root)).error, null);
    assert.ok((await readdir(sessionsDir(root))).every((name) => !name.includes(".lock")));
  } finally { await clean(root); }
});

test("separate Node processes update the same session without losing facts", async () => {
  const root = await fixture();
  try {
    const created = await createSession({ userText: "cross process", mode: "lattice" }, root);
    const script = path.join(root, "child.mjs");
    const moduleUrl = pathToFileURL(path.resolve("src/tools.ts")).href;
    await writeFile(script, `import {addFact} from ${JSON.stringify(moduleUrl)}; const view=await addFact({sessionId:process.argv[3],text:process.argv[4]},process.argv[2]); if(view.error)throw Error(view.error);`);
    const run = (text: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", script, root, created.sessionId!, text], { windowsHide: true });
      let err = "";
      child.stderr.on("data", (chunk) => { err += String(chunk); });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(err)));
    });
    await Promise.all([run("PROCESS_A"), run("PROCESS_B")]);
    const saved = (await loadSession(created.sessionId!, root))!;
    assert.ok(saved.material.includes("PROCESS_A"));
    assert.ok(saved.material.includes("PROCESS_B"));
  } finally { await clean(root); }
});
