import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  depositFile,
  depositGrab,
  depositRun,
  freezeMarks,
  grabsReady,
  sha256Hex,
  writeBoard,
} from "../src/engine.ts";
import {
  addFact,
  commitSessionRound,
  confirmMarks,
  createSession,
  depositFileFact,
  depositGrabFact,
  depositManifestFact,
  depositRunFact,
  getSession,
} from "../src/tools.ts";
import { loadSession, saveSession } from "../src/session-store.ts";
import type { Session } from "../src/schema.ts";
import { blankSession, ev } from "./fixtures.ts";

async function seedIdeaKing(root: string, userText = "做个新点子") {
  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await writeFile(
    path.join(root, ".cursor", "idea-king.json"),
    JSON.stringify({ language: "zh", crewSize: 3 }),
    "utf8",
  );
  const created = await createSession({ userText }, root);
  assert.equal(created.error, null);
  const sessionId = created.sessionId!;
  await writeFile(path.join(root, "a.txt"), "路径甲的连续原文足够长。\n", "utf8");
  await writeFile(path.join(root, "b.txt"), "路径乙的连续原文足够长。\n", "utf8");
  assert.equal(
    (await depositGrabFact({ sessionId, path: "a.txt", text: "路径甲的连续原文足够长。" }, root))
      .error,
    null,
  );
  assert.equal(
    (await depositGrabFact({ sessionId, path: "b.txt", text: "路径乙的连续原文足够长。" }, root))
      .error,
    null,
  );
  for (const text of [
    "字面做法照做原话「做个新点子」本身，没有交接。",
    "和原话不同：原话是「做个新点子」，做成的是「点破做法」。",
    "制作手的产出交给收尾手做输入。",
    "字面做法",
    "点破做法",
  ]) {
    assert.equal((await addFact({ sessionId, text }, root)).error, null);
  }
  const confirmed = await confirmMarks(
    {
      sessionId,
      marks: [
        { kind: "option", text: "字面做法", role: "literal" },
        { kind: "option", text: "点破做法", role: "spark" },
        { kind: "constraint", text: "交接接得上", code: "join" },
        { kind: "constraint", text: "不是原话的字面", code: "not_literal" },
        { kind: "constraint", text: "别人能直接试用", code: "try" },
        {
          kind: "constraint",
          text: "别人会记住：制作手的产出交给收尾手做输入。",
          code: "memory",
        },
      ],
    },
    root,
  );
  assert.equal(confirmed.error, null);
  assert.equal(
    (
      await depositManifestFact(
        {
          sessionId,
          manifest: { type: "cli", entry: "cli.cjs", inputs: [], expected: { schema: "json", cases: [
            { input: "aa", output: { echo: "aa", len: 2 } },
            { input: "bbb", output: { echo: "bbb", len: 3 } },
          ] } },
        },
        root,
      )
    ).error,
    null,
  );
  return sessionId;
}

async function writeCliProduct(root: string, sessionId: string) {
  const rel = path.join("artifacts", sessionId, "work.js");
  await mkdir(path.join(root, "artifacts", sessionId), { recursive: true });
  await writeFile(
    path.join(root, rel),
    `const fs = require("fs");
const path = require("path");
const rootDir = process.cwd();
const grabs = fs.readdirSync(path.join(rootDir, "grabs")).filter((n) => n.endsWith(".txt")).sort()
  .map((n) => fs.readFileSync(path.join(rootDir, "grabs", n), "utf8"));
const made = "做成：" + grabs.map((t) => String(t.length)).join("+");
fs.mkdirSync(path.join(rootDir, "out"), { recursive: true });
fs.writeFileSync(path.join(rootDir, "out", "cli.cjs"), 'const input=process.argv[2]||"";process.stdout.write(JSON.stringify({echo:input,len:String(input).length}));');
process.stdout.write(grabs.join("\\n") + "\\n" + made + "\\nout/cli.cjs\\n");
`,
    "utf8",
  );
  return rel;
}

async function acceptReceipt(sessionId: string, root: string) {
  const loaded = await loadSession(sessionId, root);
  const accept = [...(loaded?.evidence ?? [])].reverse().find((e) => e.kind === "accept" && e.acceptOk);
  return accept?.contentHash ?? null;
}

test("01 ideaKing refuses free constraints that opt out of the template", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-01-"));
  try {
    const created = await createSession({ userText: "随便" }, root);
    const sessionId = created.sessionId!;
    const frozen = await confirmMarks(
      {
        sessionId,
        marks: [
          { kind: "option", text: "随便选甲" },
          { kind: "option", text: "随便选乙" },
          { kind: "constraint", text: "够好" },
        ],
      },
      root,
    );
    assert.equal(frozen.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("02 ideaKing rejects three options and empty material freeze", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-02-"));
  try {
    const created = await createSession({ userText: "做个新点子" }, root);
    const sessionId = created.sessionId!;
    const three = await confirmMarks(
      {
        sessionId,
        marks: [
          { kind: "option", text: "甲" },
          { kind: "option", text: "乙" },
          { kind: "option", text: "丙" },
          { kind: "constraint", text: "交接接得上", code: "join" },
          { kind: "constraint", text: "不是原话的字面", code: "not_literal" },
          { kind: "constraint", text: "别人能直接试用", code: "try" },
          { kind: "constraint", text: "别人会记住：x", code: "memory" },
        ],
      },
      root,
    );
    assert.equal(three.error, "bad_request");
    const empty = await confirmMarks(
      {
        sessionId,
        marks: [
          { kind: "option", text: "字面做法", role: "literal" },
          { kind: "option", text: "点破做法", role: "spark" },
          { kind: "constraint", text: "交接接得上", code: "join" },
          { kind: "constraint", text: "不是原话的字面", code: "not_literal" },
          { kind: "constraint", text: "别人能直接试用", code: "try" },
          { kind: "constraint", text: "别人会记住：制作手的产出交给收尾手做输入。", code: "memory" },
        ],
      },
      root,
    );
    assert.equal(empty.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("03 grab concatenation alone cannot support try", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-03-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const art = path.join(root, "artifacts", sessionId);
    await mkdir(art, { recursive: true });
    const rel = path.join("artifacts", sessionId, "work.js");
    await writeFile(
      path.join(root, rel),
      `process.stdout.write(${JSON.stringify("路径甲的连续原文足够长。\n路径乙的连续原文足够长。")});\n`,
      "utf8",
    );
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    const loaded = await loadSession(sessionId, root);
    const cTry = loaded!.marks.find((m) => m.text === "别人能直接试用")!;
    const spark = loaded!.marks.find((m) => m.role === "spark")!;
    const echo = "路径甲的连续原文足够长。\n路径乙的连续原文足够长。";
    const committed = await commitSessionRound(
      {
        sessionId,
        quotes: JSON.stringify({
          quotes: [{ markId: cTry.id, optionId: spark.id, quote: echo, relation: "supports" }],
        }),
        audience: JSON.stringify({
          firstStop: "a",
          skipped: "b",
          remembered: "制作手的产出交给收尾手做输入。",
        }),
      },
      root,
    );
    assert.equal(committed.error, null);
    const cell = committed.lastRoundCells.find(
      (item) => item.markId === cTry.id && item.optionId === spark.id,
    );
    assert.equal(cell?.status, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("04 mutated source after deposit_file cannot be run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-04-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = path.join("artifacts", sessionId, "work.js");
    await mkdir(path.join(root, "artifacts", sessionId), { recursive: true });
    await writeFile(path.join(root, rel), "process.stdout.write('v1\\n');\n", "utf8");
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    await writeFile(path.join(root, rel), "process.stdout.write('v2-mutated\\n');\n", "utf8");
    const ran = await depositRunFact({ sessionId, path: rel }, root);
    assert.equal(ran.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("05 full source beyond 8KB is snapshotted and checked", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-05-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = path.join("artifacts", sessionId, "work.js");
    await mkdir(path.join(root, "artifacts", sessionId), { recursive: true });
    const pad = "x".repeat(8100);
    const body = `${pad}\nprocess.stdout.write('ok\\n');\n`;
    await writeFile(path.join(root, rel), body, "utf8");
    const filed = await depositFileFact({ sessionId, path: rel }, root);
    assert.equal(filed.error, null);
    const fileEv = filed.evidence.find((item) => item.kind === "file");
    assert.ok((fileEv?.text.length ?? 0) > 8000);
    assert.equal(fileEv?.contentHash, sha256Hex(body));
    const snap = await readFile(
      path.join(root, "artifacts", sessionId, "snapshots", fileEv!.contentHash!),
    );
    assert.equal(sha256Hex(snap), fileEv!.contentHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("06 memory failure yields incomplete delivery not selected sentence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-06-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = await writeCliProduct(root, sessionId);
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    const loaded = await loadSession(sessionId, root);
    const optLiteral = loaded!.marks.find((m) => m.role === "literal")!;
    const optSpark = loaded!.marks.find((m) => m.role === "spark")!;
    const cJoin = loaded!.marks.find((m) => m.code === "join")!;
    const cLit = loaded!.marks.find((m) => m.code === "not_literal")!;
    const cTry = loaded!.marks.find((m) => m.code === "try")!;
    const cMem = loaded!.marks.find((m) => m.code === "memory")!;
    const runText = loaded!.evidence.find((e) => e.kind === "run")!.text;
    const made = runText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("做成："))!;
    const receipt = await acceptReceipt(sessionId, root);
    assert.ok(receipt);
    const committed = await commitSessionRound(
      {
        sessionId,
        quotes: JSON.stringify({
          quotes: [
            {
              markId: cJoin.id,
              optionId: optLiteral.id,
              quote: "字面做法照做原话「做个新点子」本身，没有交接。",
              relation: "contradicts",
            },
            {
              markId: cLit.id,
              optionId: optLiteral.id,
              quote: "字面做法照做原话「做个新点子」本身，没有交接。",
              relation: "contradicts",
            },
            {
              markId: cJoin.id,
              optionId: optSpark.id,
              quote: "路径甲的连续原文足够长。",
              relation: "supports",
            },
            {
              markId: cLit.id,
              optionId: optSpark.id,
              quote: "和原话不同：原话是「做个新点子」，做成的是「点破做法」。",
              relation: "supports",
            },
            { markId: cTry.id, optionId: optSpark.id, quote: made, relation: "supports" },
            {
              markId: cMem.id,
              optionId: optSpark.id,
              quote: "制作手的产出交给收尾手做输入。",
              relation: "supports",
            },
          ],
        }),
        audience: JSON.stringify({
          firstStop: "做成",
          skipped: "原话",
          remembered: "还停在原话",
          provenance: "real",
          receipt,
          artifactHash: receipt,
        }),
      },
      root,
    );
    assert.equal(committed.error, null);
    assert.equal(committed.deliveryStatus, "incomplete");
    assert.equal(committed.sentence?.includes("选定"), false);
    assert.equal(committed.sentence?.includes("还不能交付"), true);
    assert.ok((committed.revision ?? 0) >= 1);
    const board = await readFile(path.join(root, "artifacts", sessionId, "board.html"), "utf8");
    assert.equal(board.includes("deliveryStatus=incomplete"), true);
    assert.equal(board.includes("scent=0"), true);
    assert.equal(board.includes("provenance="), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("07 complete grab echo is rejected for try", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-07-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = path.join("artifacts", sessionId, "work.js");
    await mkdir(path.join(root, "artifacts", sessionId), { recursive: true });
    const grab = "路径甲的连续原文足够长。";
    await writeFile(
      path.join(root, rel),
      `const fs=require("fs");const path=require("path");
fs.mkdirSync(path.join(process.cwd(),"out"),{recursive:true});fs.writeFileSync(path.join(process.cwd(),"out","play.html"),"x");
process.stdout.write(${JSON.stringify(grab + "\n路径乙的连续原文足够长。\nout/play.html\n")});`,
      "utf8",
    );
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    const loaded = await loadSession(sessionId, root);
    const cTry = loaded!.marks.find((m) => m.code === "try")!;
    const spark = loaded!.marks.find((m) => m.role === "spark")!;
    const committed = await commitSessionRound(
      {
        sessionId,
        quotes: JSON.stringify({
          quotes: [{ markId: cTry.id, optionId: spark.id, quote: grab, relation: "supports" }],
        }),
        audience: JSON.stringify({
          firstStop: "a",
          skipped: "b",
          remembered: "制作手的产出交给收尾手做输入。",
        }),
      },
      root,
    );
    const cell = committed.lastRoundCells.find(
      (item) => item.markId === cTry.id && item.optionId === spark.id,
    );
    assert.equal(cell?.status, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("08 other session artifacts cannot be grabbed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-08-"));
  try {
    const created = await createSession({ userText: "抓" }, root);
    const sessionId = created.sessionId!;
    await mkdir(path.join(root, "artifacts", "s_other"), { recursive: true });
    await writeFile(path.join(root, "artifacts", "s_other", "invented.txt"), "别人会话里的原文足够长。\n", "utf8");
    const grabbed = await depositGrabFact(
      {
        sessionId,
        path: path.join("artifacts", "s_other", "invented.txt"),
        text: "别人会话里的原文足够长。",
      },
      root,
    );
    assert.equal(grabbed.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("09 junctions to one real file do not make grabsReady", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-09-"));
  const outside = await mkdtemp(path.join(tmpdir(), "probe-09-out-"));
  try {
    await writeFile(path.join(outside, "shared.txt"), "同一份外面文件的连续原文足够。\n", "utf8");
    const linkA = path.join(root, "link_a");
    const linkB = path.join(root, "link_b");
    try {
      await symlink(outside, linkA, "junction");
      await symlink(outside, linkB, "junction");
    } catch {
      // Skip on platforms without junction support.
      return;
    }
    let session: Session = blankSession("s_junc", { mode: "lattice", userText: "j" });
    const g1 = await depositGrab(
      session,
      path.join("link_a", "shared.txt"),
      "同一份外面文件的连续原文足够。",
      root,
    );
    // realpath of outside file is outside root → reject
    assert.equal(g1.error, "bad_request");
    assert.equal(grabsReady(session.evidence), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("12 dangerous media protocols are not embedded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-12-"));
  try {
    const session: Session = freezeMarks(
      blankSession("s_media", {
        mode: "lattice",
        userText: "m",
        evidence: [
          ev({
            id: "r1",
            kind: "run",
            path: "artifacts/s_media/work.js",
            text: "javascript:alert(1)//.html\n",
            exitCode: 0,
            elapsedMs: 1,
            role: null,
            contentHash: null,
            byteLength: null,
            realPath: null,
          }),
        ],
      }),
      [],
    ).session;
    await writeBoard(session, root);
    const html = await readFile(path.join(root, "artifacts", "s_media", "board.html"), "utf8");
    assert.equal(html.includes('href="javascript:'), false);
    assert.equal(html.includes("javascript:alert"), true); // escaped prose only
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("14 CLI strips UTF-8 BOM on quotes-file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-14-"));
  const repo = process.cwd();
  try {
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({ language: "zh", crewSize: 3 }),
      "utf8",
    );
    const runCli = (args: string[]) =>
      new Promise<string>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", path.join(repo, "src", "cli.ts"), ...args],
          { cwd: root, windowsHide: true },
        );
        let out = "";
        child.stdout?.on("data", (c) => {
          out += String(c);
        });
        child.on("close", () => resolve(out));
      });
    const created = JSON.parse((await runCli(["create-session", "--text", "bom", "--mode", "lattice"])).trim().split("\n").at(-1)!);
    const sessionId = created.sessionId as string;
    // lattice still needs marks; freeze two options one constraint via tools API
    await confirmMarks(
      {
        sessionId,
        marks: [
          { kind: "option", text: "甲" },
          { kind: "option", text: "乙" },
          { kind: "constraint", text: "每天要多久" },
        ],
      },
      root,
    );
    const session = await loadSession(sessionId, root);
    session!.material = "甲单程 30 分钟";
    const { saveSession } = await import("../src/session-store.ts");
    await saveSession(session!, root);
    const marks = session!.marks;
    const quotes = {
      quotes: [
        {
          markId: marks.find((m) => m.kind === "constraint")!.id,
          optionId: marks.find((m) => m.text === "甲")!.id,
          quote: "甲单程 30 分钟",
          relation: "supports",
        },
      ],
    };
    const audience = { firstStop: "甲", skipped: "乙", remembered: "没有结论" };
    const qf = path.join(root, "quotes.json");
    const af = path.join(root, "audience.json");
    await writeFile(qf, `\uFEFF${JSON.stringify(quotes)}`, "utf8");
    await writeFile(af, `\uFEFF${JSON.stringify(audience)}`, "utf8");
    const out = await runCli([
      "commit-round",
      "--session",
      sessionId,
      "--quotes-file",
      qf,
      "--audience-file",
      af,
    ]);
    const view = JSON.parse(out.trim().split("\n").at(-1)!);
    assert.equal(view.error, null, out);
    assert.equal(view.voidCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("15 settings POST rejects foreign Origin", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-15-"));
  const repo = process.cwd();
  const port = 3937;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", path.join(repo, "src", "settings-server.ts")],
    {
      cwd: root,
      env: { ...process.env, IDEA_KING_SETTINGS_PORT: String(port) },
      windowsHide: true,
    },
  );
  try {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://evil.example",
        Host: "127.0.0.1:3937",
      },
      body: JSON.stringify({ accent: "</textarea><script>alert(1)</script>" }),
    });
    assert.equal(res.ok, false);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("16 new facts clear old selected verdict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-16-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const loaded = await loadSession(sessionId, root);
    loaded!.verdict = {
      type: "select",
      optionId: loaded!.marks.find((m) => m.role === "spark")!.id,
      decidingMarkId: loaded!.marks.find((m) => m.code === "join")!.id,
    };
    loaded!.deliveryStatus = "delivered";
    loaded!.lastRoundCells = loaded!.cells;
    const { saveSession } = await import("../src/session-store.ts");
    await saveSession(loaded!, root);
    const added = await addFact({ sessionId, text: "一条新的缩小事实" }, root);
    assert.equal(added.error, null);
    assert.equal(added.verdict, null);
    assert.equal(added.deliveryStatus, "incomplete");
    assert.equal(added.sentence, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("17 CLI rejects illegal marks without writing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-17-"));
  const repo = process.cwd();
  try {
    const runCli = (args: string[]) =>
      new Promise<string>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", path.join(repo, "src", "cli.ts"), ...args],
          { cwd: root, windowsHide: true },
        );
        let out = "";
        child.stdout?.on("data", (c) => {
          out += String(c);
        });
        child.on("close", () => resolve(out));
      });
    const created = JSON.parse((await runCli(["create-session", "--text", "x"])).trim().split("\n").at(-1)!);
    const sessionId = created.sessionId as string;
    const before = await loadSession(sessionId, root);
    const marksFile = path.join(root, "bad-marks.json");
    await writeFile(marksFile, JSON.stringify([{ kind: "nope", text: "x" }]), "utf8");
    const out = await runCli([
      "confirm-marks",
      "--session",
      sessionId,
      "--marks-file",
      marksFile,
    ]);
    const view = JSON.parse(out.trim().split("\n").at(-1)!);
    assert.equal(view.error, "bad_request");
    const after = await loadSession(sessionId, root);
    assert.deepEqual(after?.marks, before?.marks);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("18 missing product path cannot support try", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-18-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = path.join("artifacts", sessionId, "work.js");
    await mkdir(path.join(root, "artifacts", sessionId), { recursive: true });
    await writeFile(
      path.join(root, rel),
      `const grabs=["路径甲的连续原文足够长。","路径乙的连续原文足够长。"];
const made="做成："+grabs.map(t=>String(t.length)).join("+");
process.stdout.write(grabs.join("\\n")+"\\n"+made+"\\nout/missing-play.html\\n");
`,
      "utf8",
    );
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    const loaded = await loadSession(sessionId, root);
    const cTry = loaded!.marks.find((m) => m.code === "try")!;
    const spark = loaded!.marks.find((m) => m.role === "spark")!;
    const made = loaded!.evidence
      .find((e) => e.kind === "run")!
      .text.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("做成："))!;
    const committed = await commitSessionRound(
      {
        sessionId,
        quotes: JSON.stringify({
          quotes: [{ markId: cTry.id, optionId: spark.id, quote: made, relation: "supports" }],
        }),
        audience: JSON.stringify({
          firstStop: "a",
          skipped: "b",
          remembered: "制作手的产出交给收尾手做输入。",
        }),
      },
      root,
    );
    const cell = committed.lastRoundCells.find(
      (item) => item.markId === cTry.id && item.optionId === spark.id,
    );
    assert.equal(cell?.status, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ideaKing deposit_file requires frozen marks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-phase-"));
  try {
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({ crewSize: 3 }),
      "utf8",
    );
    const created = await createSession({ userText: "阶段" }, root);
    const sessionId = created.sessionId!;
    await writeFile(path.join(root, "a.txt"), "路径甲的连续原文足够长。\n", "utf8");
    await writeFile(path.join(root, "b.txt"), "路径乙的连续原文足够长。\n", "utf8");
    await depositGrabFact({ sessionId, path: "a.txt", text: "路径甲的连续原文足够长。" }, root);
    await depositGrabFact({ sessionId, path: "b.txt", text: "路径乙的连续原文足够长。" }, root);
    const rel = path.join("artifacts", sessionId, "work.js");
    await mkdir(path.join(root, "artifacts", sessionId), { recursive: true });
    await writeFile(path.join(root, rel), "console.log(1)\n", "utf8");
    const blocked = await depositFileFact({ sessionId, path: rel }, root);
    assert.ok(blocked.error === "bad_request" || blocked.error === "phase_denied");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("10 concurrent branches keep both grabs in material and evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-10-"));
  try {
    const created = await createSession({ userText: "合并", mode: "lattice" }, root);
    const sessionId = created.sessionId!;
    await writeFile(path.join(root, "a.txt"), "alpha-material-0123456789\n", "utf8");
    await writeFile(path.join(root, "b.txt"), "bravo-material-9876543210\n", "utf8");
    const [left, right] = await Promise.all([
      depositGrabFact({ sessionId, path: "a.txt", text: "alpha-material-0123456789" }, root),
      depositGrabFact({ sessionId, path: "b.txt", text: "bravo-material-9876543210" }, root),
    ]);
    assert.equal(left.error, null);
    assert.equal(right.error, null);
    const disk = await loadSession(sessionId, root);
    assert.equal(disk!.evidence.filter((item) => item.kind === "grab").length, 2);
    assert.equal(disk!.material.includes("alpha-material-0123456789"), true);
    assert.equal(disk!.material.includes("bravo-material-9876543210"), true);
    assert.equal(grabsReady(disk!.evidence), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("11 concurrent saves keep both evidence rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-11-"));
  try {
    const { updateSession } = await import("../src/session-store.ts");
    const created = await createSession({ userText: "并发", mode: "lattice" }, root);
    const sessionId = created.sessionId!;
    await Promise.all([
      updateSession(sessionId, (current) => ({
        session: {
          ...current,
          evidence: [
            ...current.evidence,
            ev({
              id: "left1",
              kind: "grab",
              path: "left.txt",
              text: "left-evidence-row",
              exitCode: null,
              elapsedMs: null,
              role: null,
              contentHash: "l",
              byteLength: 1,
              realPath: null,
            }),
          ],
        },
        value: null,
      }), root),
      updateSession(sessionId, (current) => ({
        session: {
          ...current,
          evidence: [
            ...current.evidence,
            ev({
              id: "right1",
              kind: "grab",
              path: "right.txt",
              text: "right-evidence-row",
              exitCode: null,
              elapsedMs: null,
              role: null,
              contentHash: "r",
              byteLength: 1,
              realPath: null,
            }),
          ],
        },
        value: null,
      }), root),
    ]);
    const disk = await loadSession(sessionId, root);
    const texts = disk!.evidence.map((item) => item.text);
    assert.equal(texts.includes("left-evidence-row"), true);
    assert.equal(texts.includes("right-evidence-row"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("13 run uses minimal env and omits allow-net; loopback not granted by flags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-13-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = path.join("artifacts", sessionId, "work.js");
    await mkdir(path.join(root, "artifacts", sessionId), { recursive: true });
    await writeFile(
      path.join(root, rel),
      `process.stdout.write("PATH=" + (process.env.PATH ? "set" : "missing") + "\\n");
process.stdout.write("HOME=" + (process.env.HOME || process.env.USERPROFILE || "cleared") + "\\n");
process.stdout.write("out/play.html\\n");
`,
      "utf8",
    );
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    const ran = await depositRunFact({ sessionId, path: rel }, root);
    assert.equal(ran.error, null);
    const run = ran.evidence.find((item) => item.kind === "run" && !item.stale);
    assert.ok(run?.text.includes("PATH=missing"));
    assert.ok(run?.text.includes("HOME=cleared"));
    // Accept may fail without product file; still proves env was scrubbed.
    assert.equal(run?.text.includes("AWS_"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("19 duplicate runs keep distinct evidence ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-19-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = path.join("artifacts", sessionId, "work.js");
    await mkdir(path.join(root, "artifacts", sessionId, "out"), { recursive: true });
    await writeFile(
      path.join(root, rel),
      `const fs=require("fs");const path=require("path");
fs.mkdirSync(path.join(process.cwd(),"out"),{recursive:true});
fs.writeFileSync(path.join(process.cwd(),"out","play.html"),"x");
process.stdout.write("路径甲的连续原文足够长。\\n路径乙的连续原文足够长。\\nout/play.html\\n");
`,
      "utf8",
    );
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    const disk = await loadSession(sessionId, root);
    const runs = disk!.evidence.filter((item) => item.kind === "run");
    assert.ok(runs.length >= 2);
    assert.notEqual(runs[0]!.id, runs[1]!.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shrink spark replaces prior option instead of adding a third", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-shrink-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const before = await loadSession(sessionId, root);
    const literal = before!.marks.find((m) => m.role === "literal")!;
    assert.equal((await addFact({ sessionId, text: "更短点破" }, root)).error, null);
    const again = await confirmMarks(
      {
        sessionId,
        marks: [
          { kind: "option", text: literal.text, role: "literal" },
          { kind: "option", text: "更短点破", role: "spark" },
          { kind: "constraint", text: "交接接得上", code: "join" },
          { kind: "constraint", text: "不是原话的字面", code: "not_literal" },
          { kind: "constraint", text: "别人能直接试用", code: "try" },
          {
            kind: "constraint",
            text: "别人会记住：制作手的产出交给收尾手做输入。",
            code: "memory",
          },
        ],
      },
      root,
    );
    assert.equal(again.error, null);
    const opts = again.marks.filter((m) => m.kind === "option");
    assert.equal(opts.length, 2);
    assert.equal(opts.some((m) => m.text === "更短点破" && m.role === "spark"), true);
    assert.equal(opts.some((m) => m.text === "点破做法"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("add_fact does not reset stopped voidCount", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-void-"));
  try {
    const created = await createSession({ userText: "停", mode: "lattice" }, root);
    const sessionId = created.sessionId!;
    await confirmMarks(
      {
        sessionId,
        marks: [
          { kind: "option", text: "甲" },
          { kind: "option", text: "乙" },
          { kind: "constraint", text: "每天要多久" },
        ],
      },
      root,
    );
    const s = await loadSession(sessionId, root);
    s!.stopped = true;
    s!.voidCount = 2;
    await saveSession(s!, root);
    const added = await addFact({ sessionId, text: "无关新事实一条" }, root);
    assert.equal(added.error, null);
    assert.equal(added.stopped, true);
    assert.equal(added.voidCount, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cli rejects unknown and duplicate flags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-argv-"));
  const repo = process.cwd();
  const runCli = (args: string[]) =>
    new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", path.join(repo, "src", "cli.ts"), ...args],
        { cwd: root, windowsHide: true },
      );
      let out = "";
      child.stdout?.on("data", (c) => {
        out += String(c);
      });
      child.on("close", () => resolve(out));
    });
  try {
    const unknown = JSON.parse(
      (await runCli(["create-session", "--text", "x", "--nope", "1"])).trim().split("\n").at(-1)!,
    );
    assert.equal(unknown.error, "unknown_flag");
    const dup = JSON.parse(
      (await runCli(["create-session", "--text", "x", "--text", "y"])).trim().split("\n").at(-1)!,
    );
    assert.equal(dup.error, "duplicate_flag");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("20 sim audience and missing receipt cannot deliver", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-20-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = await writeCliProduct(root, sessionId);
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    const loaded = await loadSession(sessionId, root);
    const optLiteral = loaded!.marks.find((m) => m.role === "literal")!;
    const optSpark = loaded!.marks.find((m) => m.role === "spark")!;
    const cJoin = loaded!.marks.find((m) => m.code === "join")!;
    const cLit = loaded!.marks.find((m) => m.code === "not_literal")!;
    const cTry = loaded!.marks.find((m) => m.code === "try")!;
    const cMem = loaded!.marks.find((m) => m.code === "memory")!;
    const made = loaded!.evidence
      .find((e) => e.kind === "run")!
      .text.split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("做成："))!;
    const receipt = await acceptReceipt(sessionId, root);
    assert.ok(receipt);
    const quotes = {
      quotes: [
        {
          markId: cJoin.id,
          optionId: optLiteral.id,
          quote: "字面做法照做原话「做个新点子」本身，没有交接。",
          relation: "contradicts",
        },
        {
          markId: cLit.id,
          optionId: optLiteral.id,
          quote: "字面做法照做原话「做个新点子」本身，没有交接。",
          relation: "contradicts",
        },
        { markId: cJoin.id, optionId: optSpark.id, quote: "路径甲的连续原文足够长。", relation: "supports" },
        {
          markId: cLit.id,
          optionId: optSpark.id,
          quote: "和原话不同：原话是「做个新点子」，做成的是「点破做法」。",
          relation: "supports",
        },
        { markId: cTry.id, optionId: optSpark.id, quote: made, relation: "supports" },
        {
          markId: cMem.id,
          optionId: optSpark.id,
          quote: "制作手的产出交给收尾手做输入。",
          relation: "supports",
        },
      ],
    };
    const sim = await commitSessionRound(
      {
        sessionId,
        quotes: JSON.stringify(quotes),
        audience: JSON.stringify({
          firstStop: "做成",
          skipped: "原话",
          remembered: "制作手的产出交给收尾手做输入。",
          provenance: "sim",
          receipt,
          artifactHash: receipt,
        }),
      },
      root,
    );
    assert.equal(sim.error, null);
    assert.equal(sim.deliveryStatus, "incomplete");
    const noReceipt = await commitSessionRound(
      {
        sessionId,
        quotes: JSON.stringify(quotes),
        audience: JSON.stringify({
          firstStop: "做成",
          skipped: "原话",
          remembered: "制作手的产出交给收尾手做输入。",
          provenance: "real",
          artifactHash: receipt,
        }),
      },
      root,
    );
    assert.equal(noReceipt.error, null);
    assert.equal(noReceipt.deliveryStatus, "incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("21 wiping product after accept blocks delivered and clears accept", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-21-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = await writeCliProduct(root, sessionId);
    assert.equal((await depositFileFact({ sessionId, path: rel }, root)).error, null);
    assert.equal((await depositRunFact({ sessionId, path: rel }, root)).error, null);
    const before = await loadSession(sessionId, root);
    assert.equal(before!.evidence.some((e) => e.kind === "accept" && e.acceptOk), true);
    await writeFile(path.join(root, "artifacts", sessionId, "out", "cli.cjs"), "", "utf8");
    const got = await getSession(sessionId, root);
    assert.equal(got.error, null);
    assert.equal(got.evidence.some((e) => e.kind === "accept" && e.acceptOk && !e.stale), false);
    assert.equal(got.deliveryStatus, "incomplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("22 wrong callerRole is denied; omit uses assigned maker for deposit_file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "probe-22-"));
  try {
    const sessionId = await seedIdeaKing(root);
    const rel = await writeCliProduct(root, sessionId);
    const asSpark = await depositFileFact({ sessionId, path: rel, callerRole: "spark" }, root);
    assert.equal(asSpark.error, "role_denied");
    const omitted = await depositFileFact({ sessionId, path: rel }, root);
    assert.equal(omitted.error, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
