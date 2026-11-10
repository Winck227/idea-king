import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureArtifacts, deliveryArtifactsValid, parseProductManifest, registerManifest, runAcceptor } from "../src/accept.ts";
import { evidenceSchema, sessionSchema, type ProductManifest, type Session } from "../src/schema.ts";

const pageCases = [
  { steps: [{ op: "fill", selector: "#n", value: "2" }, { op: "click", selector: "#go" }], assertion: { selector: "#result", text: "3" } },
  { steps: [{ op: "fill", selector: "#n", value: "10" }, { op: "click", selector: "#go" }], assertion: { selector: "#result", text: "11" } },
] as const;
const pageBody = '<!doctype html><input id="n"><button id="go">Compute</button><output id="result">waiting</output><script>document.getElementById("go").onclick=()=>{document.getElementById("result").textContent=String(Number(document.getElementById("n").value)+1)};</script>';
const pageManifest = () => ({ type: "page", entry: "play.html", inputs: [], expected: { pageCases: structuredClone(pageCases) } }) as unknown as ProductManifest;

async function fixture(manifest: ProductManifest, body: string, runPath = "maker.cjs") {
  const root = await mkdtemp(path.join(tmpdir(), "idea-accept-"));
  let session = sessionSchema.parse({ id: "s_accept", userText: "a usable product", material: "", draftMarks: [], marks: [], cells: [], lastRoundCells: [], audience: null, verdict: null, discardedText: null, voidCount: 0, stopped: false });
  const registered = await registerManifest(session, manifest, root);
  assert.equal(registered.error, undefined);
  session = registered.session;
  const out = path.join(root, "artifacts", session.id, "out");
  await mkdir(path.dirname(path.join(out, manifest.entry)), { recursive: true });
  await writeFile(path.join(out, manifest.entry), body, "utf8");
  const run = evidenceSchema.parse({ id: "producer-run", kind: "run", path: path.join("artifacts", session.id, runPath), text: "producer completed", exitCode: 0, stale: false });
  session.evidence.push(run);
  return { root, out, session, run };
}
async function cleanup(root: string) {
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  assert.ok(path.basename(root).startsWith("idea-accept-"));
  await rm(root, { recursive: true, force: true });
}

test("page acceptance performs real input and button actions in isolated contexts", async () => {
  const f = await fixture(pageManifest(), pageBody);
  try {
    const result = await runAcceptor(f.session, f.root, f.run);
    assert.equal(result.evidence.acceptOk, true, result.evidence.text);
    assert.match(result.evidence.text, /actions=2/);
    assert.equal(result.evidence.runId, f.run.id);
    assert.equal(result.evidence.contentHash, (await captureArtifacts(f.session, f.root)).digest);
    assert.equal(await deliveryArtifactsValid(result.session, f.root), true);
  } finally { await cleanup(f.root); }
});

test("nonempty x page and pre-filled slogan fail executable page acceptance", async () => {
  for (const body of ["x", pageBody.replace(">waiting</output>", ">3</output>")]) {
    const f = await fixture(pageManifest(), body);
    try { const result = await runAcceptor(f.session, f.root, f.run); assert.equal(result.evidence.acceptOk, false); }
    finally { await cleanup(f.root); }
  }
});

test("page cannot count filling the input itself as a computed result", async () => {
  const manifest = { type: "page", entry: "play.html", inputs: [], expected: { pageCases: [{ steps: [{ op: "fill", selector: "#n", value: "hello" }], assertion: { selector: "input", value: "hello" } }] } } as ProductManifest;
  const f = await fixture(manifest, '<input id="n">');
  try { const result = await runAcceptor(f.session, f.root, f.run); assert.equal(result.evidence.acceptOk, false); assert.match(result.evidence.text, /not_the_input_control/); }
  finally { await cleanup(f.root); }
});

test("delivery digest detects same-size edits, resources, empty products and manifest changes", async () => {
  const f = await fixture(pageManifest(), pageBody);
  try {
    await writeFile(path.join(f.out, "style.css"), "a{}");
    const result = await runAcceptor(f.session, f.root, f.run);
    assert.equal(result.evidence.acceptOk, true, result.evidence.text);
    assert.equal(await deliveryArtifactsValid(result.session, f.root), true);
    await writeFile(path.join(f.out, "play.html"), pageBody.replace("+1)", "+2)"));
    assert.equal(Buffer.byteLength(pageBody), Buffer.byteLength(await readFile(path.join(f.out, "play.html"))));
    assert.equal(await deliveryArtifactsValid(result.session, f.root), false);
    await writeFile(path.join(f.out, "play.html"), pageBody);
    await writeFile(path.join(f.out, "style.css"), "b{}");
    assert.equal(await deliveryArtifactsValid(result.session, f.root), false);
    await writeFile(path.join(f.out, "style.css"), "a{}");
    await writeFile(path.join(f.out, "play.html"), "");
    assert.equal(await deliveryArtifactsValid(result.session, f.root), false);
    await writeFile(path.join(f.out, "play.html"), pageBody);
    const delivered: Session = { ...result.session, deliveryStatus: "delivered", verdict: { type: "select", optionId: "spark", decidingMarkId: "join" } };
    const changed = await registerManifest(delivered, { ...pageManifest(), entry: "missing.html" }, f.root);
    assert.equal(changed.error, undefined);
    assert.equal(changed.session.deliveryStatus, "incomplete");
    assert.equal(changed.session.verdict, null);
    assert.ok(changed.session.evidence.filter(row => row.kind === "run" || row.kind === "accept").every(row => row.stale));
    assert.equal(await deliveryArtifactsValid(changed.session, f.root), false);
  } finally { await cleanup(f.root); }
});

test("CLI acceptance executes actual manifest entry with concrete cases and repeat", async () => {
  const manifest = { type: "cli", entry: "app.cjs", inputs: [], expected: { schema: "json", cases: [{ input: "alpha", output: { upper: "ALPHA" } }, { input: "beta", output: { upper: "BETA" } }] } } as ProductManifest;
  const f = await fixture(manifest, 'console.log(JSON.stringify({upper:process.argv[2].toUpperCase()}));');
  try {
    await writeFile(path.join(f.root, "artifacts", f.session.id, "maker.cjs"), 'throw Error("producer script is not the product");');
    const result = await runAcceptor(f.session, f.root, f.run);
    assert.equal(result.evidence.acceptOk, true, result.evidence.text);
    assert.match(result.evidence.text, /repeat=1/);
    assert.equal(await deliveryArtifactsValid(result.session, f.root), true);
  } finally { await cleanup(f.root); }
});

test("constant CLI output, disabled checks and regular-expression schemas cannot pass", async () => {
  const manifest = { type: "cli", entry: "app.cjs", inputs: [], expected: { schema: "text", cases: [{ input: "alpha", output: "ALPHA" }, { input: "beta", output: "BETA" }] } } as ProductManifest;
  const f = await fixture(manifest, 'console.log("ALPHA");');
  try { const result = await runAcceptor(f.session, f.root, f.run); assert.equal(result.evidence.acceptOk, false); assert.match(result.evidence.text, /case 2 output mismatch/); }
  finally { await cleanup(f.root); }
  assert.equal(parseProductManifest({ ...manifest, expected: { schema: "/(a+)+$/", differsOnInputChange: false } }), null);
});

test("browser acceptance blocks external fetch and websocket while local actions still work", async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end("unexpected"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const manifest = { type: "page", entry: "play.html", inputs: [], expected: { pageCases: [{ steps: [{ op: "click", selector: "#go" }], assertion: { selector: "#result", text: "blocked" } }] } } as ProductManifest;
  const body = `<button id="go">Try</button><output id="result">waiting</output><script>document.querySelector('#go').onclick=()=>fetch('http://127.0.0.1:${address.port}/').then(()=>document.querySelector('#result').textContent='bad').catch(()=>document.querySelector('#result').textContent='blocked');try{new WebSocket('ws://127.0.0.1:${address.port}/')}catch{}</script>`;
  const f = await fixture(manifest, body);
  try { const result = await runAcceptor(f.session, f.root, f.run); assert.equal(result.evidence.acceptOk, true, result.evidence.text); assert.equal(requests, 0); }
  finally { await cleanup(f.root); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
