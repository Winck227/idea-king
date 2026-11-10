import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createSession, confirmMarks } from "../src/tools.ts";
import { listBoardThemes, resolveBoardTheme, resolveCrewSize } from "../src/labels.ts";

const repo = process.cwd();

async function fixture(work: (root: string) => Promise<void>): Promise<void> {
  const parent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(parent, "entry-test-"));
  try { await work(root); }
  finally {
    assert.ok(path.resolve(root).startsWith(parent + path.sep));
    assert.ok(path.basename(root).startsWith("entry-test-"));
    await rm(root, { recursive: true, force: true });
  }
}

async function cli(root: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.join(repo, "src", "cli.ts"), ...args],
      { cwd: root, windowsHide: true });
    let out = "";
    child.stdout.on("data", c => { out += String(c); });
    child.on("error", reject);
    child.on("close", code => resolve({ code, out }));
  });
}

test("entry: null and missing payload values return one structured CLI error", async () => {
  await fixture(async root => {
    for (const args of [
      ["confirm-marks", "--session", "s_missing", "--marks", "null"],
      ["deposit-manifest", "--session", "s_missing", "--manifest", "null"],
      ["create-session", "--text", "audit", "--mode"],
      ["confirm-marks", "--session", "s_missing", "--marks", "[]", "--marks-file", "unused.json"],
    ]) {
      const result = await cli(root, args);
      assert.equal(result.code, 1, JSON.stringify(args));
      const lines = result.out.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.ok(JSON.parse(lines[0]!).error);
    }
  });
});

test("entry: CLI and real MCP transport consume the same invalid-round attempts", async () => {
  await fixture(async root => {
    async function seed() {
      const created = await createSession({ userText: "entry audit", mode: "lattice" }, root);
      assert.equal(created.error, null);
      const id = created.sessionId!;
      const marked = await confirmMarks({ sessionId: id, marks: [
        { kind: "option", text: "A" }, { kind: "option", text: "B" },
        { kind: "constraint", text: "condition" },
      ] }, root);
      assert.equal(marked.error, null);
      return id;
    }
    const cliId = await seed();
    const mcpId = await seed();
    const client = new Client({ name: "entry-regression", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["--experimental-strip-types", path.join(repo, "src", "mcp.ts")], cwd: root, stderr: "pipe" });
    try {
      await client.connect(transport);
      const audience = JSON.stringify({ firstStop: "A", skipped: "B", remembered: "A" });
      for (const quotes of ["not-json", "null"]) {
        const command = await cli(root, ["commit-round", "--session", cliId, "--quotes", quotes, "--audience", audience]);
        const fromCli = JSON.parse(command.out.trim());
        const response = await client.callTool({ name: "commit_round", arguments: { sessionId: mcpId, quotes, audience } });
        const textBlock = (response.content as Array<{ type: string; text?: string }>).find(c => c.type === "text");
        assert.ok(textBlock?.text);
        const fromMcp = JSON.parse(textBlock.text);
        for (const key of ["error", "voidCount", "retry", "stopped", "sentence"]) {
          assert.equal(fromCli[key], fromMcp[key], key);
        }
      }
    } finally { await client.close(); }
  });
});

async function startSettings(root: string): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--experimental-strip-types", path.join(repo, "src", "settings-server.ts")],
    { cwd: root, windowsHide: true, env: { ...process.env, IDEA_KING_SETTINGS_PORT: String(port) } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("settings startup timeout")); }, 5000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`settings startup exited ${code}`)); });
    child.stdout.on("data", chunk => {
      if (String(chunk).includes("settings:")) { clearTimeout(timer); resolve(); }
    });
  });
  return { child, url: `http://127.0.0.1:${port}` };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

test("entry: malicious custom theme is excluded and settings script requires a nonce", async () => {
  await fixture(async root => {
    await mkdir(path.join(root, ".cursor"));
    const marker = "</script><script>globalThis.entry_marker=1</script>";
    const { id: _id, ...palette } = resolveBoardTheme();
    await writeFile(path.join(root, ".cursor", "idea-king.themes.json"), JSON.stringify({
      [marker]: palette,
      safe: { ...palette, id: marker },
    }));
    await writeFile(path.join(root, ".cursor", "idea-king.json"), JSON.stringify({ theme: "safe", background: marker }));
    assert.equal(listBoardThemes(root).includes(marker), false);
    assert.equal(resolveBoardTheme(root).id, "safe");
    const { child, url } = await startSettings(root);
    try {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.equal(html.includes(marker), false);
      const nonce = /<script nonce="([A-Za-z0-9+/=]+)">/.exec(html)?.[1];
      assert.ok(nonce);
      const csp = response.headers.get("content-security-policy")!;
      assert.ok(csp.includes(`script-src 'nonce-${nonce}'`));
      assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false);
    } finally { await stopChild(child); }
  });
});

test("entry: settings validates shape, bounds and exact local origin", async () => {
  await fixture(async root => {
    const { child, url } = await startSettings(root);
    try {
      const html = await (await fetch(url)).text();
      const token = /const pageToken = "([^"]+)"/.exec(html)?.[1];
      assert.ok(token);
      const post = (body: unknown, origin = url) => fetch(url + "/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "X-Idea-King-Token": token },
        body: JSON.stringify(body),
      });
      assert.equal((await post(null)).status, 400);
      assert.equal((await post({ background: "x".repeat(601) })).status, 400);
      assert.equal((await post({ background: "x".repeat(65536) })).status, 413);
      assert.equal((await post({ theme: "</script>" })).status, 400);
      assert.equal((await post({ accent: "#ffffff" }, "http://127.0.0.1:1")).status, 403);
      assert.equal((await post({ crewSize: 1000000 })).status, 200);
      assert.equal(resolveCrewSize(root), 12);
      const settings = JSON.parse(await readFile(path.join(root, ".cursor", "idea-king.json"), "utf8"));
      assert.equal(settings.crewSize, 12);
    } finally { await stopChild(child); }
  });
});
