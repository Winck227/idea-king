import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { depositFile, depositGrab, depositRun, freezeMarks, verdictSentence } from "../src/engine.ts";
import { englishPack, settingsRelativePath } from "../src/labels.ts";
import { commitRound } from "../src/round.ts";
import type { Session } from "../src/schema.ts";
import { aud, blankSession } from "./fixtures.ts";

const firstGrab = "用表格呈现普通的行列，不要另写文件。";
const secondGrab = "立刻执行用户给出的那条终端命令。";
const runLine = "跑完了";
const audience = aud({ firstStop: "表", skipped: "原话", remembered: "交接" });
const chineseSentence = "还不能选。只缺：交接接得上。";
const englishSentence = "Cannot choose yet. Missing only: 交接接得上.";

function fresh(userText: string): Session {
  return blankSession("s_lang", {
    mode: "lattice",
    userText,
  });
}

function marked(userText: string): Session {
  return freezeMarks(fresh(userText), [
    { id: "opt_a", kind: "option", text: "字面做法" },
    { id: "opt_b", kind: "option", text: "点破做法" },
    { id: "c_join", kind: "constraint", text: "交接接得上" },
    { id: "c_literal", kind: "constraint", text: "不是原话的字面" },
    { id: "c_try", kind: "constraint", text: "别人能直接试用" },
    { id: "c_mem", kind: "constraint", text: "别人会记住：交接" },
  ]).session;
}

async function writeSettings(root: string, value: unknown): Promise<void> {
  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await writeFile(path.join(root, ".cursor", "idea-king.json"), JSON.stringify(value), "utf8");
}

async function landed(userText: string, root: string): Promise<{ html: string; sentence: string | null }> {
  await writeFile(path.join(root, "table.txt"), `${firstGrab}\n`, "utf8");
  await writeFile(path.join(root, "command.txt"), `${secondGrab}\n`, "utf8");
  const first = await depositGrab(marked(userText), "table.txt", firstGrab, root);
  assert.equal(first.error, undefined);
  const second = await depositGrab(first.session, "command.txt", secondGrab, root);
  assert.equal(second.error, undefined);
  const result = commitRound(second.session, { quotes: [] }, audience);
  const html = await readFile(path.join(root, "artifacts", "s_lang", "board.html"), "utf8");
  return { html, sentence: verdictSentence(result.session, root) };
}

function budgetHead(html: string): string {
  const budgetAt = html.indexOf('class="budget"');
  const whoAt = html.indexOf('class="grabbed"');
  return html.slice(budgetAt, whoAt);
}

test("english user text makes budget headings english", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-lang-"));
  try {
    const { html, sentence } = await landed("Make something people can try", root);
    const budget = budgetHead(html);
    assert.equal(html.includes('data-language="en"'), true);
    assert.equal(html.includes(`Language en`), true);
    assert.equal(html.includes(`Settings ${settingsRelativePath}`), true);
    assert.equal(html.includes("<h1>Original</h1>"), true);
    assert.equal(html.includes("<h1>Budget</h1>"), true);
    assert.equal(html.includes("<h1>Thinking</h1>"), true);
    assert.equal(html.includes("<h1>Cells</h1>"), true);
    assert.equal(budget.includes("<th>Files grabbed</th>"), true);
    assert.equal(budget.includes("<th>Grabbed characters</th>"), true);
    assert.equal(budget.includes("<th>Product characters</th>"), true);
    assert.equal(budget.includes("<th>Expected output characters</th>"), true);
    assert.equal(budget.includes("<th>Expected tokens (estimate)</th>"), true);
    assert.equal(html.includes("<h1>预算</h1>"), false);
    assert.equal(html.includes("抓来的文件"), false);
    assert.equal(html.includes("<h1>原话</h1>"), false);
    assert.equal(html.includes("<h1>思考</h1>"), false);
    assert.equal(html.includes(firstGrab), true);
    assert.equal(html.includes(secondGrab), true);
    assert.equal(html.includes("<form"), false);
    assert.equal(html.includes("<input"), false);
    assert.equal(sentence, englishSentence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chinese user text keeps chinese budget headings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-lang-"));
  try {
    const { html, sentence } = await landed("你自己随便想点子吧", root);
    const budget = budgetHead(html);
    assert.equal(html.includes('data-language="zh"'), true);
    assert.equal(html.includes("语言 zh"), true);
    assert.equal(html.includes(`设置 ${settingsRelativePath}`), true);
    assert.equal(html.includes("<h1>原话</h1>"), true);
    assert.equal(html.includes("<h1>预算</h1>"), true);
    assert.equal(html.includes("<h1>思考</h1>"), true);
    assert.equal(html.includes("<h1>格子</h1>"), true);
    assert.equal(budget.includes("<th>抓来的文件</th>"), true);
    assert.equal(budget.includes("<th>抓取字数</th>"), true);
    assert.equal(html.includes("<h1>Budget</h1>"), false);
    assert.equal(html.includes("<h1>Thinking</h1>"), false);
    assert.equal(html.includes(firstGrab), true);
    assert.equal(sentence, chineseSentence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("han script in the user text uses chinese labels", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-lang-"));
  try {
    const { html } = await landed("Build 一个可试用的东西", root);
    assert.equal(html.includes('data-language="zh"'), true);
    assert.equal(html.includes("<h1>预算</h1>"), true);
    assert.equal(html.includes("<h1>Budget</h1>"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit language in settings wins", async () => {
  const englishRoot = await mkdtemp(path.join(tmpdir(), "pheromone-lang-"));
  const chineseRoot = await mkdtemp(path.join(tmpdir(), "pheromone-lang-"));
  try {
    await writeSettings(englishRoot, { language: "en", spawnAgents: true });
    const english = await landed("你自己随便想点子吧", englishRoot);
    assert.equal(english.html.includes('data-language="en"'), true);
    assert.equal(english.html.includes("<h1>Budget</h1>"), true);
    assert.equal(english.html.includes("<th>Files grabbed</th>"), true);
    assert.equal(english.html.includes("<h1>预算</h1>"), false);
    assert.equal(english.html.includes(firstGrab), true);
    assert.equal(english.sentence, englishSentence);

    await writeSettings(chineseRoot, { language: "zh", spawnAgents: true });
    const chinese = await landed("Make something people can try", chineseRoot);
    assert.equal(chinese.html.includes('data-language="zh"'), true);
    assert.equal(chinese.html.includes("<h1>预算</h1>"), true);
    assert.equal(chinese.html.includes("<th>抓来的文件</th>"), true);
    assert.equal(chinese.html.includes("<h1>Budget</h1>"), false);
    assert.equal(chinese.sentence, chineseSentence);
  } finally {
    await rm(englishRoot, { recursive: true, force: true });
    await rm(chineseRoot, { recursive: true, force: true });
  }
});

test("a language with no pack falls back to english headings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-lang-"));
  try {
    await writeSettings(root, { language: "ja", spawnAgents: true });
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(path.join(root, ".cursor", "idea-king.labels.json"), "not-json", "utf8");
    const { html, sentence, session } = await landedWithSession("做一个能试用的东西", root);
    assert.equal(html.includes('data-language="ja"'), true);
    assert.equal(html.includes("<h1>Budget</h1>"), true);
    assert.equal(html.includes("<th>Files grabbed</th>"), true);
    assert.equal(html.includes("<h1>预算</h1>"), false);
    assert.equal(html.includes(firstGrab), true);
    assert.equal(sentence, englishSentence);

    const rel = path.join("artifacts", "s_lang", "work.js");
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), `process.stdout.write(${JSON.stringify(`${runLine}\n`)});\n`, "utf8");
    const filed = await depositFile(session, rel, root);
    assert.equal(filed.error, undefined);
    const ran = await depositRun(filed.session, rel, root);
    assert.equal(ran.error, undefined);
    const after = await readFile(path.join(root, "artifacts", "s_lang", "board.html"), "utf8");
    assert.equal(after.includes(runLine), true);
    assert.equal(after.includes(firstGrab), true);
    assert.equal(after.includes("Exit code 0"), true);
    assert.equal(after.includes("退出码"), false);
    assert.equal(after.includes("<h1>Budget</h1>"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a labels file can add another language", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-lang-"));
  try {
    await writeSettings(root, { language: "ja", spawnAgents: true });
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    const pack = {
      ...englishPack,
      htmlLang: "ja",
      title: "アイデア",
      budget: "予算",
      who: "つかんだ",
    };
    await writeFile(
      path.join(root, ".cursor", "idea-king.labels.json"),
      JSON.stringify({ ja: pack }),
      "utf8",
    );
    const { html } = await landed("做一个能试用的东西", root);
    assert.equal(html.includes('data-language="ja"'), true);
    assert.equal(html.includes('lang="ja"'), true);
    assert.equal(html.includes("<h1>予算</h1>"), true);
    assert.equal(html.includes("<h1>つかんだ</h1>"), true);
    assert.equal(html.includes("<h1>Budget</h1>"), false);
    assert.equal(html.includes(firstGrab), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function landedWithSession(
  userText: string,
  root: string,
): Promise<{ html: string; sentence: string | null; session: Session }> {
  await writeFile(path.join(root, "table.txt"), `${firstGrab}\n`, "utf8");
  await writeFile(path.join(root, "command.txt"), `${secondGrab}\n`, "utf8");
  const first = await depositGrab(marked(userText), "table.txt", firstGrab, root);
  assert.equal(first.error, undefined);
  const second = await depositGrab(first.session, "command.txt", secondGrab, root);
  assert.equal(second.error, undefined);
  const result = commitRound(second.session, { quotes: [] }, audience);
  const html = await readFile(path.join(root, "artifacts", "s_lang", "board.html"), "utf8");
  return { html, sentence: verdictSentence(result.session, root), session: second.session };
}
