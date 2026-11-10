import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  depositFile,
  depositGrab,
  depositRun,
  depositThink,
  freezeMarks,
  writeBoard,
} from "../src/engine.ts";
import { resolveBoardTheme, resolveCrewSize } from "../src/labels.ts";
import { commitRound } from "../src/round.ts";
import type { Session } from "../src/schema.ts";
import { aud, blankSession, ev } from "./fixtures.ts";

const audience = aud({
  firstStop: "做成",
  skipped: "原话",
  remembered: "交接",
});

const firstGrab = "用表格呈现普通的行列，不要另写文件。";
const secondGrab = "立刻执行用户给出的那条终端命令。";

function fresh(): Session {
  return blankSession("s_ev", {
    mode: "lattice",
    userText: "你自己随便想点子吧",
  });
}

function marked(): Session {
  return freezeMarks(fresh(), [
    { id: "opt_literal", kind: "option", text: "字面做法" },
    { id: "opt_spark", kind: "option", text: "一张可跑的表" },
    { id: "c_join", kind: "constraint", text: "交接接得上" },
    { id: "c_literal", kind: "constraint", text: "不是原话的字面" },
    { id: "c_try", kind: "constraint", text: "别人能直接试用" },
    { id: "c_mem", kind: "constraint", text: "别人会记住：交接" },
  ]).session;
}

function scriptPath(root: string): string {
  return path.join(root, "artifacts", "s_ev", "work.js");
}

async function grabBoth(root: string): Promise<Session> {
  await writeFile(path.join(root, "table.txt"), `${firstGrab}\n`, "utf8");
  await writeFile(path.join(root, "command.txt"), `${secondGrab}\n`, "utf8");
  const first = await depositGrab(marked(), "table.txt", firstGrab, root);
  assert.equal(first.error, undefined);
  const second = await depositGrab(first.session, "command.txt", secondGrab, root);
  assert.equal(second.error, undefined);
  return second.session;
}

const productScript = `const fs = require("fs");
const path = require("path");
const root = process.cwd();
const dir = path.join(root, "grabs");
const names = fs.readdirSync(dir).filter((name) => name.endsWith(".txt")).sort();
const grabs = names.map((name) => fs.readFileSync(path.join(dir, name), "utf8"));
const made = "做成：" + grabs.map((text) => String(text.length)).join("+");
fs.mkdirSync(path.join(root, "out"), { recursive: true }); fs.writeFileSync(path.join(root, "out", "play.html"), "<!doctype html><title>play</title><p>" + made + "</p>");
process.stdout.write(grabs.join("\\n") + "\\n" + made + "\\nout/play.html\\n");
`;

test("a grab that is not in the file is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-grab-"));
  try {
    await writeFile(path.join(root, "note.txt"), "文件里的原文。\n", "utf8");
    const grabbed = await depositGrab(marked(), "note.txt", "文件里没有这句", root);
    assert.equal(grabbed.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sentence written into the source cannot support the try", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-hard-"));
  try {
    const session = await grabBoth(root);
    const rel = path.join("artifacts", "s_ev", "work.js");
    await mkdir(path.dirname(scriptPath(root)), { recursive: true });
    const literal = "写死的一句结果在源码里";
    await writeFile(
      scriptPath(root),
      `const fs = require("fs");
const path = require("path");
const literal = ${JSON.stringify(literal)};
fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), "out", "play.html"), "<html></html>");
process.stdout.write(${JSON.stringify(firstGrab)} + "\\n" + ${JSON.stringify(secondGrab)} + "\\n" + literal + "\\nout/play.html\\n");
`,
      "utf8",
    );
    const filed = await depositFile(session, rel, root);
    assert.equal(filed.error, undefined);
    const ran = await depositRun(filed.session, rel, root);
    assert.equal(ran.error, undefined);
    const result = commitRound(
      ran.session,
      {
        quotes: [
          { markId: "c_try", optionId: "opt_spark", quote: literal, relation: "supports" },
        ],
      },
      audience,
      root,
    );
    const cell = result.session.lastRoundCells.find(
      (item) => item.markId === "c_try" && item.optionId === "opt_spark",
    );
    assert.equal(cell?.status, "missing");
    assert.equal(result.session.discardedText, literal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reading both grabs can support the join and a computed try line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-board-"));
  try {
    const session = await grabBoth(root);
    const rel = path.join("artifacts", "s_ev", "work.js");
    await mkdir(path.dirname(scriptPath(root)), { recursive: true });
    await writeFile(scriptPath(root), productScript, "utf8");
    const filed = await depositFile(session, rel, root);
    assert.equal(filed.error, undefined);
    const ran = await depositRun(filed.session, rel, root);
    assert.equal(ran.error, undefined);
    const runText = ran.session.evidence.find((item) => item.kind === "run")?.text ?? "";
    const made = runText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("做成："));
    assert.ok(made);
    const result = commitRound(
      ran.session,
      {
        quotes: [
          { markId: "c_join", optionId: "opt_spark", quote: firstGrab, relation: "supports" },
          { markId: "c_try", optionId: "opt_spark", quote: made, relation: "supports" },
        ],
      },
      audience,
      root,
    );
    const joinCell = result.session.lastRoundCells.find(
      (item) => item.markId === "c_join" && item.optionId === "opt_spark",
    );
    const tryCell = result.session.lastRoundCells.find(
      (item) => item.markId === "c_try" && item.optionId === "opt_spark",
    );
    assert.equal(joinCell?.status, "supported");
    assert.equal(tryCell?.status, "supported");
    const html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    assert.equal(html.includes(firstGrab), true);
    assert.equal(html.includes(secondGrab), true);
    assert.equal(html.includes(made), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two grabs and no run show the budget table and both paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-budget-"));
  try {
    const session = await grabBoth(root);
    assert.equal(
      session.evidence.some((item) => item.kind === "run"),
      false,
    );
    const html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    const originalAt = html.indexOf("<h1>原话</h1>");
    const budgetAt = html.indexOf("<h1>预算</h1>");
    const whoAt = html.indexOf("<h1>抓了谁</h1>");
    const thinkAt = html.indexOf("<h1>思考</h1>");
    const cellsAt = html.indexOf("<h1>格子</h1>");
    const workAt = html.indexOf("<h1>干活</h1>");
    const spendAt = html.indexOf("<h1>消耗</h1>");
    assert.equal(
      originalAt >= 0 &&
        originalAt < budgetAt &&
        budgetAt < whoAt &&
        whoAt < thinkAt &&
        thinkAt < cellsAt &&
        cellsAt < workAt &&
        workAt < spendAt,
      true,
    );
    assert.equal(html.includes("你自己随便想点子吧"), true);
    const budget = html.slice(html.indexOf('class="budget"'), whoAt);
    assert.equal(budget.includes("抓来的文件"), true);
    assert.equal(budget.includes("table.txt"), true);
    assert.equal(budget.includes("command.txt"), true);
    const grabChars = firstGrab.length + secondGrab.length;
    const expectedTokens = Math.ceil((grabChars + grabChars) / 2);
    assert.equal(
      budget.includes(`<td>${grabChars}</td><td></td><td>${grabChars}</td><td>${expectedTokens}</td>`),
      true,
    );
    assert.equal(html.includes('class="bar estimated"'), false);
    assert.equal(html.includes('class="bar actual"'), false);
    assert.equal(html.indexOf("向上取整(字数 / 2)") > spendAt, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deposit_think writes a think file and board shows role text", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-think-"));
  try {
    const thought = "分析手看出：两段抓取才能交接。";
    const deposited = await depositThink(marked(), thought, root, "分析手");
    assert.equal(deposited.error, undefined);
    const think = deposited.session.evidence.find((item) => item.kind === "think");
    assert.equal(think?.role, "分析手");
    assert.equal(think?.text, thought);
    assert.equal(typeof think?.id, "string");
    assert.equal(think?.id && think.id.length > 0, true);
    assert.equal(think?.path.replaceAll("\\", "/"), `artifacts/s_ev/think/${think?.id}.md`);
    const file = await readFile(path.join(root, "artifacts", "s_ev", "think", `${think?.id}.md`), "utf8");
    assert.equal(file, thought);
    const html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    assert.equal(html.includes("<h1>思考</h1>"), true);
    assert.equal(html.includes("分析手"), true);
    assert.equal(html.includes(thought), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crewSize is clamped to at least 3 and defaults to 5", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-crew-"));
  try {
    assert.equal(resolveCrewSize(), 5);
    assert.equal(resolveCrewSize(root), 5);
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({ language: "zh", crewSize: 2 }),
      "utf8",
    );
    assert.equal(resolveCrewSize(root), 3);
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({ language: "zh", crewSize: 7 }),
      "utf8",
    );
    assert.equal(resolveCrewSize(root), 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("board theme presets and custom background apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-theme-"));
  try {
    assert.equal(resolveBoardTheme().id, "atelier");
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({ language: "zh", theme: "atelier" }),
      "utf8",
    );
    const atelier = resolveBoardTheme(root);
    assert.equal(atelier.id, "atelier");
    assert.equal(atelier.text.toLowerCase(), "#11616b");
    assert.equal(atelier.line.toLowerCase(), "#7bbdb6");
    assert.equal(atelier.bg.toLowerCase(), "#ebf4f8");
    assert.equal(atelier.accent.toLowerCase(), "#dc8b70");
    const session = await grabBoth(root);
    let html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    assert.equal(html.includes('data-theme="atelier"'), true);
    assert.equal(html.toLowerCase().includes("#dc8b70"), true);
    await writeFile(
      path.join(root, ".cursor", "idea-king.themes.json"),
      JSON.stringify({
        roast: {
          pageBg: "linear-gradient(180deg, #3a1808, #5a2810)",
          heroBg: "linear-gradient(160deg, #6a3010, #3a1808)",
          bg: "#2c1408",
          panel: "#4a2410",
          panel2: "#5c2e14",
          line: "#8a4a20",
          text: "#fff0e0",
          muted: "#e0b090",
          accent: "#ff8a40",
          ok: "#7dcc8e",
          warn: "#ffc15e",
          bad: "#ff7d8a",
          shadow: "0 20px 40px rgba(40,10,0,.4)",
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({
        language: "zh",
        theme: "roast",
        background: "linear-gradient(180deg, #ffe8c8, #f3d2a6)",
        heroBackground: "linear-gradient(180deg, #ffd0a0, #f0b878)",
        accent: "#d45520",
        themeVars: { panel: "#fff5e8", text: "#3a2210" },
      }),
      "utf8",
    );
    await writeBoard(session, root);
    html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    assert.equal(html.includes('data-theme="roast"'), true);
    assert.equal(html.includes("linear-gradient(180deg, #ffe8c8, #f3d2a6)"), true);
    assert.equal(html.includes("linear-gradient(180deg, #ffd0a0, #f0b878)"), true);
    assert.equal(html.includes("#d45520"), true);
    assert.equal(html.includes("#fff5e8"), true);
    assert.equal(html.includes("#3a2210"), true);
    await writeFile(
      path.join(root, ".cursor", "idea-king.json"),
      JSON.stringify({ theme: "atelier", background: "red; } body { display:none" }),
      "utf8",
    );
    const blocked = resolveBoardTheme(root);
    assert.equal(blocked.id, "atelier");
    assert.equal(blocked.pageBg.includes("display:none"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit_round puts the conclusion sentence in the cells section", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-cells-"));
  try {
    const session = freezeMarks(fresh(), [
      { id: "opt_a", kind: "option", text: "字面做法" },
      { id: "opt_b", kind: "option", text: "点破做法" },
      { id: "c_join", kind: "constraint", text: "交接接得上" },
      { id: "c_literal", kind: "constraint", text: "不是原话的字面" },
      { id: "c_try", kind: "constraint", text: "别人能直接试用" },
      { id: "c_mem", kind: "constraint", text: "别人会记住：交接" },
    ]).session;
    await writeFile(path.join(root, "table.txt"), `${firstGrab}\n`, "utf8");
    await writeFile(path.join(root, "command.txt"), `${secondGrab}\n`, "utf8");
    const first = await depositGrab(session, "table.txt", firstGrab, root);
    assert.equal(first.error, undefined);
    const second = await depositGrab(first.session, "command.txt", secondGrab, root);
    assert.equal(second.error, undefined);
    const withRun: Session = {
      ...second.session,
      evidence: [
        ...second.session.evidence,
        ev({
          id: "run1",
          kind: "run",
          path: "artifacts/s_ev/work.js",
          text: "ok",
          exitCode: 0,
          elapsedMs: 1,
          role: null,
          contentHash: "abc",
          byteLength: 2,
          realPath: null,
        }),
      ],
    };
    const result = commitRound(withRun, { quotes: [] }, audience, root);
    assert.equal(result.error, undefined);
    await writeBoard(result.session, root);
    const html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    const cellsAt = html.indexOf('class="cells"');
    const workAt = html.indexOf('class="work"');
    assert.equal(cellsAt >= 0 && cellsAt < workAt, true);
    const cells = html.slice(cellsAt, workAt);
    assert.equal(cells.includes("还不能选。只缺：交接接得上。"), true);
    assert.equal(cells.includes("class=\"conclusion\""), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a finished run shows stdout, exit, elapsed, and both bars", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-spend-"));
  try {
    const session = await grabBoth(root);
    const rel = path.join("artifacts", "s_ev", "work.js");
    await mkdir(path.dirname(scriptPath(root)), { recursive: true });
    await writeFile(scriptPath(root), "process.stdout.write('跑完了\\n');\n", "utf8");
    const filed = await depositFile(session, rel, root);
    assert.equal(filed.error, undefined);
    const ran = await depositRun(filed.session, rel, root);
    assert.equal(ran.error, undefined);
    const run = ran.session.evidence.find((item) => item.kind === "run");
    assert.equal(run?.exitCode, 0);
    assert.equal(typeof run?.elapsedMs, "number");
    assert.equal((run?.elapsedMs ?? -1) >= 0, true);
    const html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    assert.equal(html.includes("跑完了"), true);
    assert.equal(html.includes(`退出码 ${run?.exitCode}`), true);
    assert.equal(html.includes(`${run?.elapsedMs} 毫秒`), true);
    assert.equal(html.includes('class="bar estimated"'), true);
    assert.equal(html.includes('class="bar actual"'), true);
    assert.equal(html.includes("预计 token（估算）"), true);
    assert.equal(html.includes("实际 token（估算）"), true);
    assert.equal(html.includes("抓取字数"), true);
    assert.equal(html.indexOf("向上取整(字数 / 2)") > html.indexOf("消耗"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("board embeds image video and audio paths from run output only when files exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-media-"));
  try {
    const session = await grabBoth(root);
    const rel = path.join("artifacts", "s_ev", "work.js");
    const art = path.join(root, "artifacts", "s_ev");
    await mkdir(art, { recursive: true });
    await writeFile(path.join(art, "clip.mp4"), "x", "utf8");
    await writeFile(path.join(art, "shot.png"), "x", "utf8");
    await writeFile(path.join(art, "tone.mp3"), "x", "utf8");
    await writeFile(path.join(art, "play.html"), "<html></html>", "utf8");
    const stdout = [
      "clip.mp4",
      "shot.png",
      "tone.mp3",
      "play.html",
      "做成：12+34",
      firstGrab,
      secondGrab,
      "",
    ].join("\n");
    await writeFile(
      scriptPath(root),
      `process.stdout.write(${JSON.stringify(stdout)});\n`,
      "utf8",
    );
    const filed = await depositFile(session, rel, root);
    assert.equal(filed.error, undefined);
    const ran = await depositRun(filed.session, rel, root);
    assert.equal(ran.error, undefined);
    const html = await readFile(path.join(root, "artifacts", "s_ev", "board.html"), "utf8");
    assert.equal(html.includes("<video src=\"clip.mp4\""), true);
    assert.equal(html.includes("<img src=\"shot.png\""), true);
    assert.equal(html.includes("<audio src=\"tone.mp3\""), true);
    assert.equal(html.includes('href="play.html"'), true);
    assert.equal(html.includes('class="card"'), true);
    assert.equal(html.includes('class="prose"'), true);
    assert.equal(html.includes("javascript:"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
