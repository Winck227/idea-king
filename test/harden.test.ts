import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  depositFile,
  depositGrab,
  grabsReady,
  ideaKingTemplateMissing,
  writeBoard,
} from "../src/engine.ts";
import { addFact, confirmMarks, createSession, depositGrabFact } from "../src/tools.ts";
import { loadSession, mergeEvidence, saveSession } from "../src/session-store.ts";
import type { Evidence, Session } from "../src/schema.ts";
import { blankSession as baseSession, ev } from "./fixtures.ts";

function blankSession(id: string): Session {
  return baseSession(id, { mode: "lattice", userText: "做成一件能试用的东西" });
}

test("same-path grabs do not make budget or grabsReady", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-same-"));
  try {
    await writeFile(path.join(root, "one.txt"), "第一段抓取内容够十二字。\n第二段也在同一文件。\n", "utf8");
    let session = blankSession("s_same");
    const first = await depositGrab(session, "one.txt", "第一段抓取内容够十二字。", root);
    assert.equal(first.error, undefined);
    session = first.session;
    const second = await depositGrab(session, "one.txt", "第二段也在同一文件。", root);
    assert.equal(second.error, undefined);
    session = second.session;
    assert.equal(session.evidence.filter((item) => item.kind === "grab").length, 2);
    assert.equal(grabsReady(session.evidence), false);
    await writeBoard(session, root);
    const html = await readFile(path.join(root, "artifacts", "s_same", "board.html"), "utf8");
    assert.equal(html.includes('<div class="budget-stats">'), false);
    assert.equal(html.includes("<td></td><td></td><td></td><td></td><td></td>"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deposit_file is refused until grabsReady", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-gate-"));
  try {
    const dir = path.join(root, "artifacts", "s_gate");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "work.js"), "console.log(1)\n", "utf8");
    const session = blankSession("s_gate");
    const blocked = await depositFile(session, path.join("artifacts", "s_gate", "work.js"), root);
    assert.equal(blocked.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confirm_marks rejects incomplete idea-king hard constraints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-marks-"));
  try {
    const created = await createSession({ userText: "做个新点子" }, root);
    assert.equal(created.error, null);
    const sessionId = created.sessionId!;
    const bad = await confirmMarks(
      {
        sessionId,
        marks: [
          { kind: "option", text: "字面做法" },
          { kind: "option", text: "点破做法" },
          { kind: "constraint", text: "交接接得上" },
          { kind: "constraint", text: "别人能直接试用" },
        ],
      },
      root,
    );
    assert.equal(bad.error, "bad_request");
    for (const text of [
      "字面做法照做原话「做个新点子」本身，没有交接。",
      "和原话不同：原话是「做个新点子」，做成的是「点破做法」。",
      "制作手的产出交给收尾手做输入。",
      "字面做法",
      "点破做法",
    ]) {
      const added = await addFact({ sessionId, text }, root);
      assert.equal(added.error, null);
    }
    const good = await confirmMarks(
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
    assert.equal(good.error, null);
    assert.equal(ideaKingTemplateMissing(good.marks, "ideaKing").length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveSession keeps disk evidence when a stale write omits it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-merge-"));
  try {
    await writeFile(path.join(root, "a.txt"), "路径甲的连续原文足够长。\n", "utf8");
    await writeFile(path.join(root, "b.txt"), "路径乙的连续原文足够长。\n", "utf8");
    const created = await createSession({ userText: "合并证据", mode: "lattice" }, root);
    const sessionId = created.sessionId!;
    const g1 = await depositGrabFact(
      { sessionId, path: "a.txt", text: "路径甲的连续原文足够长。" },
      root,
    );
    assert.equal(g1.error, null);
    const g2 = await depositGrabFact(
      { sessionId, path: "b.txt", text: "路径乙的连续原文足够长。" },
      root,
    );
    assert.equal(g2.error, null);
    const onDisk = await loadSession(sessionId, root);
    assert.equal(onDisk?.evidence.length, 2);

    const stale: Session = {
      ...onDisk!,
      evidence: [],
      material: onDisk!.material,
      marks: [
        {
          id: "f1",
          kind: "fact",
          text: "一条会覆盖的事实",
          scent: 1,
          role: null,
          code: null,
          replacedId: null,
        },
      ],
    };
    await saveSession(stale, root);
    const merged = await loadSession(sessionId, root);
    assert.equal(merged?.evidence.length, 2);
    assert.equal(grabsReady(merged!.evidence), true);
    assert.equal(merged?.marks.some((mark) => mark.text === "一条会覆盖的事实"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mergeEvidence dedupes by id when present", () => {
  const a: Evidence = ev({
    id: "e1",
    kind: "grab",
    path: "a.txt",
    text: "x",
    exitCode: null,
    elapsedMs: null,
    role: null,
    contentHash: null,
    byteLength: null,
    realPath: null,
  });
  const b: Evidence = { ...a, id: "e2", path: "b.txt" };
  assert.equal(mergeEvidence([a], [a, b]).length, 2);
});

test("cli commit-round accepts --quotes-file and --audience-file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-cli-"));
  const repo = process.cwd();
  try {
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({ language: "zh", crewSize: 3 }),
      "utf8",
    );
    await writeFile(path.join(root, "a.txt"), "路径甲的连续原文足够长。\n", "utf8");
    await writeFile(path.join(root, "b.txt"), "路径乙的连续原文足够长。\n", "utf8");
    const runCli = (args: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", path.join(repo, "src", "cli.ts"), ...args],
          { cwd: root, windowsHide: true },
        );
        let out = "";
        child.stdout?.on("data", (chunk) => {
          out += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          out += String(chunk);
        });
        child.on("close", (code) => resolve({ code, out }));
      });

    const created = await runCli(["create-session", "--text", "做个新点子"]);
    const createdView = JSON.parse(created.out.trim().split("\n").at(-1)!);
    assert.equal(createdView.error, null);
    const sessionId = createdView.sessionId as string;

    const grab1 = await runCli([
      "deposit-grab",
      "--session",
      sessionId,
      "--path",
      "a.txt",
      "--text",
      "路径甲的连续原文足够长。",
    ]);
    assert.equal(JSON.parse(grab1.out.trim().split("\n").at(-1)!).error, null);
    const grab2 = await runCli([
      "deposit-grab",
      "--session",
      sessionId,
      "--path",
      "b.txt",
      "--text",
      "路径乙的连续原文足够长。",
    ]);
    const grab2View = JSON.parse(grab2.out.trim().split("\n").at(-1)!);
    assert.equal(grab2View.error, null);
    assert.equal(grab2View.budgetReady, true);

    const facts = [
      "和原话不同：原话是「做个新点子」，做成的是「抓取试跑件」。",
      "字面做法照做原话「做个新点子」本身，没有交接。",
      "制作手写的脚本在运行时读取 grabs/ 与 think/。不要把抓来的原文贴进源码。",
      "收尾手 deposit_run。脚本成功时印出用这些抓取与思考做成的结果。做不到就让脚本以非 0 退出，不要写成已经能试用。",
      "制作手的产出交给收尾手做输入。",
      "新点子",
      "抓取试跑件",
    ];
    for (const text of facts) {
      const added = await runCli(["add-fact", "--session", sessionId, "--text", text]);
      assert.equal(JSON.parse(added.out.trim().split("\n").at(-1)!).error, null);
    }
    const marks = [
      { kind: "option", text: "新点子", role: "literal" },
      { kind: "option", text: "抓取试跑件", role: "spark" },
      { kind: "constraint", text: "交接接得上", code: "join" },
      { kind: "constraint", text: "不是原话的字面", code: "not_literal" },
      { kind: "constraint", text: "别人能直接试用", code: "try" },
      { kind: "constraint", text: "别人会记住：制作手的产出交给收尾手做输入。", code: "memory" },
    ];
    const marksFile = path.join(root, "marks.json");
    await writeFile(marksFile, JSON.stringify(marks), "utf8");
    const confirmed = await runCli([
      "confirm-marks",
      "--session",
      sessionId,
      "--marks-file",
      marksFile,
    ]);
    const confirmedView = JSON.parse(confirmed.out.trim().split("\n").at(-1)!);
    assert.equal(confirmedView.error, null, confirmed.out);

    const art = path.join(root, "artifacts", sessionId);
    await mkdir(art, { recursive: true });
    const work = path.join(art, "work.js");
    await writeFile(
      work,
      `const fs = require("fs");
const path = require("path");
const rootDir = process.cwd();
const grabDir = path.join(rootDir, "grabs");
const grabs = fs.readdirSync(grabDir).filter((n) => n.endsWith(".txt")).sort()
  .map((n) => fs.readFileSync(path.join(grabDir, n), "utf8"));
const made = "做成：" + grabs.map((t) => String(t.length)).join("+");
fs.mkdirSync(path.join(rootDir, "out"), { recursive: true });
fs.writeFileSync(path.join(rootDir, "out", "cli.cjs"), 'const input=process.argv[2]||"";process.stdout.write(JSON.stringify({echo:input,len:String(input).length}));');
process.stdout.write(grabs.join("\\n") + "\\n" + made + "\\nout/cli.cjs\\n");
`,
      "utf8",
    );
    const manifestFile = path.join(root, "manifest.json");
    await writeFile(
      manifestFile,
      JSON.stringify({
        type: "cli",
        entry: "cli.cjs",
        expected: {
          schema: "json",
          cases: [
            { input: "aa", output: { echo: "aa", len: 2 } },
            { input: "bbb", output: { echo: "bbb", len: 3 } },
          ],
        },
      }),
      "utf8",
    );
    const manifested = await runCli([
      "deposit-manifest",
      "--session",
      sessionId,
      "--manifest-file",
      manifestFile,
    ]);
    assert.equal(JSON.parse(manifested.out.trim().split("\n").at(-1)!).error, null, manifested.out);
    const filed = await runCli([
      "deposit-file",
      "--session",
      sessionId,
      "--path",
      path.join("artifacts", sessionId, "work.js"),
    ]);
    assert.equal(JSON.parse(filed.out.trim().split("\n").at(-1)!).error, null, filed.out);
    const ran = await runCli([
      "deposit-run",
      "--session",
      sessionId,
      "--path",
      path.join("artifacts", sessionId, "work.js"),
    ]);
    const ranView = JSON.parse(ran.out.trim().split("\n").at(-1)!);
    assert.equal(ranView.error, null, ran.out);
    const runText = ranView.evidence.find((item: Evidence) => item.kind === "run")?.text as string;
    assert.equal(typeof runText, "string");
    const made = runText
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .find((line: string) => line.startsWith("做成："));
    assert.ok(made);

    const loaded = await loadSession(sessionId, root);
    const optLiteral = loaded!.marks.find(
      (mark) => mark.kind === "option" && mark.text === "新点子",
    )!;
    const optSpark = loaded!.marks.find(
      (mark) => mark.kind === "option" && mark.text === "抓取试跑件",
    )!;
    const cJoin = loaded!.marks.find(
      (mark) => mark.kind === "constraint" && mark.text === "交接接得上",
    )!;
    const cLit = loaded!.marks.find(
      (mark) => mark.kind === "constraint" && mark.text === "不是原话的字面",
    )!;
    const cTry = loaded!.marks.find(
      (mark) => mark.kind === "constraint" && mark.text === "别人能直接试用",
    )!;
    const cMem = loaded!.marks.find(
      (mark) => mark.kind === "constraint" && mark.text.startsWith("别人会记住："),
    )!;
    const grabA = "路径甲的连续原文足够长。";

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
        { markId: cJoin.id, optionId: optSpark.id, quote: grabA, relation: "supports" },
        {
          markId: cLit.id,
          optionId: optSpark.id,
          quote: "和原话不同：原话是「做个新点子」，做成的是「抓取试跑件」。",
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
    const acceptHash = loaded!.evidence.find((item) => item.kind === "accept" && item.acceptOk)?.contentHash;
    assert.ok(acceptHash);
    const audience = {
      firstStop: "做成",
      skipped: "做个新点子",
      remembered: "制作手的产出交给收尾手做输入。",
      provenance: "real",
      receipt: acceptHash,
      artifactHash: acceptHash,
    };
    const quotesFile = path.join(root, "quotes.json");
    const audienceFile = path.join(root, "audience.json");
    await writeFile(quotesFile, JSON.stringify(quotes), "utf8");
    await writeFile(audienceFile, JSON.stringify(audience), "utf8");
    const committed = await runCli([
      "commit-round",
      "--session",
      sessionId,
      "--quotes-file",
      quotesFile,
      "--audience-file",
      audienceFile,
    ]);
    const committedView = JSON.parse(committed.out.trim().split("\n").at(-1)!);
    assert.equal(committedView.error, null, committed.out);
    assert.equal(
      committedView.deliveryStatus,
      "delivered",
      JSON.stringify({
        sentence: committedView.sentence,
        discarded: committedView.discardedText,
        verdict: committedView.verdict,
        cells: committedView.lastRoundCells,
        deliveryStatus: committedView.deliveryStatus,
        made,
      }),
    );
    assert.equal(
      committedView.sentence,
      "选定「抓取试跑件」，因为「交接接得上」。",
      JSON.stringify({
        sentence: committedView.sentence,
        discarded: committedView.discardedText,
        verdict: committedView.verdict,
        cells: committedView.lastRoundCells,
        deliveryStatus: committedView.deliveryStatus,
      }),
    );
    assert.equal(typeof committedView.boardPath, "string");
    const board = await readFile(path.join(art, "board.html"), "utf8");
    assert.equal(board.includes("预算"), true);
    assert.equal(board.includes("抓取试跑件"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
