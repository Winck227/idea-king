import assert from "node:assert/strict";
import test from "node:test";
import { depositFact, freezeMarks } from "../src/engine.ts";
import { commitRound } from "../src/round.ts";
import type { Quote, Session } from "../src/schema.ts";
import { verdictSentence } from "../src/engine.ts";
import { aud, blankSession } from "./fixtures.ts";

const audienceA1 = aud({
  firstStop: "每天要多久",
  skipped: "没有时间",
  remembered: "没有结论",
});

const quotesA2: Quote[] = [
  { markId: "m_time", optionId: "m_a", quote: "住处甲单程 30 分钟", relation: "supports" },
  { markId: "m_time", optionId: "m_b", quote: "住处乙单程 50 分钟", relation: "supports" },
  { markId: "m_limit", optionId: "m_a", quote: "住处甲单程 30 分钟", relation: "supports" },
  { markId: "m_limit", optionId: "m_b", quote: "住处乙单程 50 分钟", relation: "contradicts" },
];

function fresh(): Session {
  return blankSession("s_1", {
    mode: "lattice",
    userText: "住处甲和住处乙，我在意每天要多久",
  });
}

function withHomes(): Session {
  return freezeMarks(fresh(), [
    { id: "m_a", kind: "option", text: "住处甲" },
    { id: "m_b", kind: "option", text: "住处乙" },
    { id: "m_time", kind: "constraint", text: "每天要多久" },
  ]).session;
}

function withCommuteFacts(): Session {
  const marked = freezeMarks(withHomes(), [
    { id: "m_limit", kind: "constraint", text: "每天通勤不超过四十分钟" },
  ]).session;
  return depositFact(marked, "住处甲单程 30 分钟。住处乙单程 50 分钟。").session;
}

test("A1 refuses when commute time is missing", () => {
  const result = commitRound(withHomes(), { quotes: [] }, audienceA1);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.session.verdict, { type: "refuse", missingMarkId: "m_time" });
  assert.equal(verdictSentence(result.session), "还不能选。只缺：每天要多久。");
  assert.equal(result.session.discardedText, null);
  assert.equal(result.session.lastRoundCells.length, 2);
  for (const cell of result.session.lastRoundCells) {
    assert.equal(cell.status, "missing");
    assert.equal(cell.scent, 1);
  }
});

test("A2 selects the home within forty minutes", () => {
  assert.equal(JSON.stringify(quotesA2).includes("装修更现代"), false);
  assert.equal(JSON.stringify(quotesA2).includes("我们再讨论一下装修"), false);
  const result = commitRound(withCommuteFacts(), { quotes: quotesA2 }, audienceA1);
  assert.deepEqual(result.session.verdict, {
    type: "select",
    optionId: "m_a",
    decidingMarkId: "m_limit",
  });
  assert.equal(
    verdictSentence(result.session),
    "选定「住处甲」，因为「每天通勤不超过四十分钟」。",
  );
  assert.ok(result.session.cells.every((cell) => cell.markId === "m_limit" && cell.scent === 1));
  assert.equal(result.session.cells.some((cell) => cell.markId === "m_time"), false);
  const timeCells = result.session.lastRoundCells.filter((cell) => cell.markId === "m_time");
  assert.equal(timeCells.length, 2);
  assert.ok(timeCells.every((cell) => cell.status === "supported"));
});

test("A3 drops decoration talk and keeps the selection", () => {
  const result = commitRound(
    withCommuteFacts(),
    {
      quotes: [
        ...quotesA2,
        { markId: "m_limit", optionId: "m_a", quote: "装修更现代", relation: "supports" },
      ],
    },
    audienceA1,
  );
  assert.deepEqual(result.session.verdict, {
    type: "select",
    optionId: "m_a",
    decidingMarkId: "m_limit",
  });
  assert.equal(result.session.discardedText, "装修更现代");
  assert.equal(result.session.voidCount, 0);
  assert.equal(result.session.stopped, false);
  for (const cell of [...result.session.cells, ...result.session.lastRoundCells]) {
    assert.notEqual(cell.evidenceQuote, "装修更现代");
  }
});

test("A4 zeroes a memory claim the audience did not keep", () => {
  const session = freezeMarks(fresh(), [
    { id: "m_p", kind: "option", text: "方案甲" },
    { id: "m_q", kind: "option", text: "方案乙" },
    { id: "m_memory", kind: "constraint", text: "别人会记住：离公司近" },
  ]).session;
  session.material = "方案强调离公司近";
  const result = commitRound(
    session,
    {
      quotes: [
        { markId: "m_memory", optionId: "m_p", quote: "离公司近", relation: "supports" },
        { markId: "m_memory", optionId: "m_q", quote: "离公司近", relation: "supports" },
      ],
    },
    aud({ firstStop: "离公司近", skipped: "其余句子", remembered: "四十分钟" }),
  );
  const memoryCells = result.session.lastRoundCells.filter((cell) => cell.markId === "m_memory");
  assert.equal(memoryCells.length, 2);
  assert.ok(memoryCells.every((cell) => cell.scent === 0));
  assert.deepEqual(
    result.session.lastRoundCells.filter((cell) => cell.scent === 1),
    [],
  );
  assert.deepEqual(result.session.verdict, { type: "refuse_tie" });
  const memory = result.session.marks.find((mark) => mark.id === "m_memory");
  assert.equal(memory?.scent, 1);
});

test("A5 stops after two unreadable quote payloads", () => {
  const audience = aud({
    firstStop: "我们再讨论一下装修",
    skipped: "没有格子",
    remembered: "没有结论",
  });
  const first = commitRound(withHomes(), "我们再讨论一下装修", audience);
  assert.equal(first.session.stopped, false);
  assert.equal(first.session.voidCount, 1);
  const second = commitRound(first.session, "我们再讨论一下装修", audience);
  assert.equal(second.session.verdict, null);
  assert.equal(second.session.stopped, true);
  assert.equal(second.session.voidCount, 2);
  assert.equal(second.session.discardedText, "我们再讨论一下装修");
  assert.equal(second.session.audience?.remembered, "没有结论");
  assert.equal(verdictSentence(second.session), "这轮没有结论。");
  const third = commitRound(second.session, { quotes: [] }, audience);
  assert.equal(third.error, "stopped");
  assert.deepEqual(third.session, second.session);
});

test("create_session does not invent marks", async () => {
  const { createSession } = await import("../src/tools.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "pheromone-"));
  try {
    const created = await createSession({ userText: "住处甲和住处乙，我在意每天要多久" }, root);
    assert.equal(created.error, null);
    assert.deepEqual(created.marks, []);
    assert.equal(created.verdict, null);
    assert.equal(created.deliveryStatus, "incomplete");
    assert.ok(created.revision !== null && created.revision! >= 1);
    assert.ok(created.phase);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
