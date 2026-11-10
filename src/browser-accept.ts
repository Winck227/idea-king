import { access } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export type PageAcceptanceCase = {
  steps: Array<{ op: "fill" | "click" | "select"; selector: string; value?: string }>;
  assertion: { selector: string; text?: string; value?: string };
};

const origin = "http://idea-king.invalid";
const caseTimeoutMs = 5_000;
const policy = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

async function browserExecutable(): Promise<string> {
  const candidates = process.platform === "win32"
    ? ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try next installed browser */ }
  }
  throw new Error("browser_not_installed");
}

function contentType(file: string): string {
  const extension = file.toLowerCase().split(".").at(-1);
  return ({ html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", js: "application/javascript; charset=utf-8", mjs: "application/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", woff: "font/woff", woff2: "font/woff2" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

async function readAssertion(page: Page, assertion: PageAcceptanceCase["assertion"]): Promise<{ text?: string; value?: string } | null> {
  const target = page.locator(assertion.selector);
  const count = await target.count();
  if (count === 0) return null;
  if (count !== 1) throw new Error("assertion_selector_must_match_one_element");
  const result: { text?: string; value?: string } = {};
  if (assertion.text !== undefined) result.text = await target.innerText();
  if (assertion.value !== undefined) result.value = await target.inputValue();
  return result;
}

function matches(actual: Awaited<ReturnType<typeof readAssertion>>, expected: PageAcceptanceCase["assertion"]): boolean {
  return actual !== null && (expected.text === undefined || actual.text === expected.text) && (expected.value === undefined || actual.value === expected.value);
}

/** Runs real UI actions against immutable, in-memory local resources. No external URL is served. */
export async function verifyPageActions(entry: string, files: ReadonlyMap<string, Buffer>, cases: PageAcceptanceCase[]): Promise<{ ok: boolean; text: string }> {
  if (cases.length === 0 || cases.length > 8 || cases.some(test => test.steps.length === 0 || test.steps.length > 12 || (test.assertion.text === undefined && test.assertion.value === undefined))) return { ok: false, text: "accept:page requires bounded executable actions and result assertions" };
  let browser: Browser | undefined;
  let active: BrowserContext | undefined;
  try {
    browser = await chromium.launch({
      executablePath: await browserExecutable(), headless: true, chromiumSandbox: true, timeout: 15_000,
      args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    for (let index = 0; index < cases.length; index++) {
      const test = cases[index]!;
      active = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, permissions: [] });
      active.setDefaultTimeout(caseTimeoutMs);
      await active.routeWebSocket("**/*", socket => socket.close());
      await active.route("**/*", async route => {
        try {
          const url = new URL(route.request().url());
          if (url.origin !== origin || route.request().method() !== "GET") { await route.abort(); return; }
          const name = decodeURIComponent(url.pathname).replace(/^\//, "");
          const body = files.get(name);
          if (!body || name.includes("\\") || name.includes(":")) { await route.abort(); return; }
          await route.fulfill({ status: 200, body, contentType: contentType(name), headers: { "Content-Security-Policy": policy, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
        } catch { await route.abort().catch(() => undefined); }
      });
      const page = await active.newPage();
      await page.goto(`${origin}/${entry.split("/").map(encodeURIComponent).join("/")}`, { waitUntil: "load", timeout: caseTimeoutMs });
      const before = await readAssertion(page, test.assertion);
      if (matches(before, test.assertion)) return { ok: false, text: `accept:page case ${index + 1} result already present before actions` };
      for (const step of test.steps) {
        const target = page.locator(step.selector);
        if (await target.count() !== 1) throw new Error("action_selector_must_match_one_element");
        if (step.op !== "click" && await target.and(page.locator(test.assertion.selector)).count() > 0) throw new Error("assertion_must_observe_a_result_not_the_input_control");
        if (step.op === "click") await target.click();
        else if (step.op === "fill") {
          if (step.value === undefined) throw new Error("fill_requires_value");
          await target.fill(step.value);
        } else {
          if (step.value === undefined) throw new Error("select_requires_value");
          await target.selectOption(step.value);
        }
      }
      const deadline = Date.now() + 1_500;
      let after = await readAssertion(page, test.assertion);
      while (!matches(after, test.assertion) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 40));
        after = await readAssertion(page, test.assertion);
      }
      if (!matches(after, test.assertion) || JSON.stringify(before) === JSON.stringify(after)) return { ok: false, text: `accept:page case ${index + 1} action result mismatch` };
      await active.close();
      active = undefined;
    }
    return { ok: true, text: `accept:page ok actions=${cases.length}` };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "browser_failure";
    return { ok: false, text: `accept:page ${reason.slice(0, 180)}` };
  } finally {
    await active?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
