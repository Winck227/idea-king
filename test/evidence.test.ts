import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { depositFact, depositFile, depositRun, freezeMarks } from "../src/engine.ts";
import { commitRound } from "../src/round.ts";
import { sessionSchema, type Session } from "../src/schema.ts";
import { aud, blankSession, ev } from "./fixtures.ts";

const audience = aud({
  firstStop: "文件",
  skipped: "原话",
  remembered: "交接",
});

const grabA = "aaaaaaaaaaaa grab-a";
const grabB = "bbbbbbbbbbbb grab-b";

function fresh(): Session {
  return blankSession("s_ev", {
    mode: "lattice",
    userText: "做成一件能试用的东西",
  });
}

function artifact(name: string): string {
  return path.join("artifacts", "s_ev", name);
}

async function writeArtifact(root: string, name: string, body: string): Promise<string> {
  const rel = artifact(name);
  await mkdir(path.join(root, "artifacts", "s_ev"), { recursive: true });
  await writeFile(path.join(root, rel), body, "utf8");
  return rel;
}

function marked(): Session {
  return freezeMarks(fresh(), [
    { id: "opt_literal", kind: "option", text: "字面做法" },
    { id: "opt_spark", kind: "option", text: "试用页" },
    { id: "c_join", kind: "constraint", text: "交接接得上" },
    { id: "c_literal", kind: "constraint", text: "不是原话的字面" },
    { id: "c_try", kind: "constraint", text: "别人能直接试用" },
    { id: "c_mem", kind: "constraint", text: "别人会记住：交接" },
  ]).session;
}

function withGrabsReady(session: Session): Session {
  return {
    ...session,
    evidence: [
      ...session.evidence,
      ev({
        id: "g1",
        kind: "grab",
        path: "g_a.txt",
        text: grabA,
        exitCode: null,
        elapsedMs: null,
        role: null,
        contentHash: null,
        byteLength: null,
        realPath: path.resolve("g_a.txt"),
      }),
      ev({
        id: "g2",
        kind: "grab",
        path: "g_b.txt",
        text: grabB,
        exitCode: null,
        elapsedMs: null,
        role: null,
        contentHash: null,
        byteLength: null,
        realPath: path.resolve("g_b.txt"),
      }),
    ],
  };
}

test("old session without evidence still loads", () => {
  const parsed = sessionSchema.parse({
    id: "s_old",
    userText: "原话",
    material: "已有",
    draftMarks: [],
    marks: [],
    cells: [],
    lastRoundCells: [],
    audience: null,
    verdict: null,
    discardedText: null,
    voidCount: 0,
    stopped: false,
  });
  assert.deepEqual(parsed.evidence, []);
  assert.equal(parsed.mode, "lattice");
  const withRun = sessionSchema.parse({
    id: "s_old",
    userText: "原话",
    material: "已有",
    evidence: [{ kind: "run", path: "artifacts/s_old/work.js", text: "out", exitCode: 0 }],
    draftMarks: [],
    marks: [],
    cells: [],
    lastRoundCells: [],
    audience: null,
    verdict: null,
    discardedText: null,
    voidCount: 0,
    stopped: false,
  });
  assert.equal(withRun.evidence[0]?.elapsedMs, null);
  assert.equal(withRun.evidence[0]?.role, null);
});

test("add_fact cannot support the join or the try", () => {
  const session = depositFact(marked(), "交接：抄录的产出交给页面做输入。").session;
  const withTry = depositFact(session, "可以试用：打开页面").session;
  const result = commitRound(
    withTry,
    {
      quotes: [
        {
          markId: "c_join",
          optionId: "opt_spark",
          quote: "交接：抄录的产出交给页面做输入。",
          relation: "supports",
        },
        {
          markId: "c_try",
          optionId: "opt_spark",
          quote: "可以试用：打开页面",
          relation: "supports",
        },
      ],
    },
    audience,
  );
  assert.equal(result.session.discardedText?.includes("交接：抄录的产出交给页面做输入。"), true);
  assert.equal(result.session.discardedText?.includes("可以试用：打开页面"), true);
  for (const cell of result.session.lastRoundCells) {
    assert.equal(cell.status, "missing");
  }
});

test("a printed line that already sits in the source does not count", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-ev-"));
  try {
    const script = await writeArtifact(
      root,
      "try.js",
      `const fs = require("fs");
const path = require("path");
const made = "可以试用：打开页面";
fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), "out", "play.html"), "<html></html>");
process.stdout.write(${JSON.stringify(grabA)} + "\\n" + ${JSON.stringify(grabB)} + "\\n" + made + "\\nout/play.html\\n");
`,
    );
    const early = await depositRun(withGrabsReady(marked()), script, root);
    assert.equal(early.error, "bad_request");
    // Only break the "quote not in source" rule: quote is embedded in source comments/strings.
    const withQuoteInSource = await writeArtifact(
      root,
      "try2.js",
      `const fs = require("fs");
const path = require("path");
const made = "可以试用：打开页面";
fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), "out", "play.html"), "<html></html>");
process.stdout.write(${JSON.stringify(grabA)} + "\\n" + ${JSON.stringify(grabB)} + "\\n" + made + "\\nout/play.html\\n");
`,
    );
    const filed = await depositFile(withGrabsReady(marked()), withQuoteInSource, root);
    assert.equal(filed.error, undefined);
    const ran = await depositRun(filed.session, withQuoteInSource, root);
    assert.equal(ran.error, undefined);
    const result = commitRound(
      ran.session,
      {
        quotes: [
          {
            markId: "c_try",
            optionId: "opt_spark",
            quote: "可以试用：打开页面",
            relation: "supports",
          },
        ],
      },
      audience,
      root,
    );
    const tryCell = result.session.lastRoundCells.find(
      (cell) => cell.markId === "c_try" && cell.optionId === "opt_spark",
    );
    assert.equal(tryCell?.status, "missing");
    assert.equal(result.session.discardedText?.includes("可以试用：打开页面"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a try quote that only appears via another registered file still needs the run source clean", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-split-"));
  try {
    const joinFile = await writeArtifact(
      root,
      "join.js",
      "// 交接：抄录的产出交给页面做输入。\nconsole.log('只有交接')\n",
    );
    // Only break source-contains-quote on the run file; still exit 0, slices, product path.
    const tryFile = await writeArtifact(
      root,
      "try.js",
      `const fs = require("fs");
const path = require("path");
const made = "可以试用：打开页面";
fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), "out", "play.html"), "<html></html>");
process.stdout.write(${JSON.stringify(grabA)} + "\\n" + ${JSON.stringify(grabB)} + "\\n" + made + "\\nout/play.html\\n");
`,
    );
    const joined = await depositFile(withGrabsReady(marked()), joinFile, root);
    assert.equal(joined.error, undefined);
    const both = await depositFile(joined.session, tryFile, root);
    assert.equal(both.error, undefined);
    const ran = await depositRun(both.session, tryFile, root);
    assert.equal(ran.error, undefined);
    const result = commitRound(
      ran.session,
      {
        quotes: [
          {
            markId: "c_try",
            optionId: "opt_spark",
            quote: "可以试用：打开页面",
            relation: "supports",
          },
        ],
      },
      audience,
      root,
    );
    const tryCell = result.session.lastRoundCells.find(
      (cell) => cell.markId === "c_try" && cell.optionId === "opt_spark",
    );
    assert.equal(tryCell?.status, "missing");
    assert.equal(result.session.discardedText?.includes("可以试用：打开页面"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("files outside the artifact directory are rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-src-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "engine.ts"), "export function judge() {}\n", "utf8");
    await writeFile(path.join(root, "notes.txt"), "交接：抄录的产出交给页面做输入。\n", "utf8");
    const source = await depositFile(withGrabsReady(marked()), path.join("src", "engine.ts"), root);
    assert.equal(source.error, "bad_request");
    const beside = await depositFile(withGrabsReady(marked()), "notes.txt", root);
    assert.equal(beside.error, "bad_request");
    const repoSource = await depositFile(
      withGrabsReady(marked()),
      path.join("src", "engine.ts"),
      process.cwd(),
    );
    assert.equal(repoSource.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paths outside the repo and node -e are rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pheromone-out-"));
  try {
    await writeFile(path.join(outside, "secret.js"), "console.log('外面')\n", "utf8");
    const escaped = await depositFile(
      withGrabsReady(marked()),
      path.join(outside, "secret.js"),
      root,
    );
    assert.equal(escaped.error, "bad_request");
    const relative = await depositFile(
      withGrabsReady(marked()),
      path.relative(root, path.join(outside, "secret.js")),
      root,
    );
    assert.equal(relative.error, "bad_request");
    const flag = await depositRun(withGrabsReady(marked()), "-e", root);
    assert.equal(flag.error, "bad_request");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a failed run cannot support the try", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pheromone-fail-"));
  try {
    // Only break exitCode: still prints grab slices, product path, and a derived quote not in source.
    const script = await writeArtifact(
      root,
      "fail.js",
      `const fs = require("fs");
const path = require("path");
const made = "没跑通但有产物";
fs.mkdirSync(path.join(process.cwd(), "out"), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), "out", "play.html"), "<html></html>");
process.stdout.write(${JSON.stringify(grabA)} + "\\n" + ${JSON.stringify(grabB)} + "\\n" + made + "\\nout/play.html\\n");
process.exit(1);
`,
    );
    const filed = await depositFile(withGrabsReady(marked()), script, root);
    assert.equal(filed.error, undefined);
    const ran = await depositRun(filed.session, script, root);
    assert.equal(ran.error, undefined);
    assert.equal(
      ran.session.evidence.some((item) => item.kind === "run" && item.exitCode !== 0),
      true,
    );
    const result = commitRound(
      ran.session,
      {
        quotes: [
          { markId: "c_try", optionId: "opt_spark", quote: "没跑通但有产物", relation: "supports" },
        ],
      },
      audience,
      root,
    );
    const cell = result.session.lastRoundCells.find(
      (cell) => cell.markId === "c_try" && cell.optionId === "opt_spark",
    );
    assert.equal(cell?.status, "missing");
    assert.equal(result.session.discardedText, "没跑通但有产物");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
