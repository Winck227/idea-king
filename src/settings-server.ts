import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  listBoardThemeCatalog,
  loadIdeaKingSettings,
  resolveBoardTheme,
  saveIdeaKingSettings,
  type BoardTheme,
} from "./labels.ts";

const port = Number(process.env.IDEA_KING_SETTINGS_PORT ?? 3927);
const root = process.cwd();
const maxBodyBytes = 64 * 1024;
const pageToken = randomUUID();
const cssSetting = z.string().max(600);
const settingsPayload = z.object({
  language: z.string().max(32).optional(),
  spawnAgents: z.boolean().optional(),
  crewSize: z.number().finite().optional(),
  theme: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/i).optional(),
  background: cssSetting.optional(),
  heroBackground: cssSetting.optional(),
  accent: cssSetting.optional(),
  themeVars: z.object({
    pageBg: cssSetting.optional(), heroBg: cssSetting.optional(), bg: cssSetting.optional(),
    panel: cssSetting.optional(), panel2: cssSetting.optional(), line: cssSetting.optional(),
    text: cssSetting.optional(), muted: cssSetting.optional(), accent: cssSetting.optional(),
    ok: cssSetting.optional(), warn: cssSetting.optional(), bad: cssSetting.optional(),
    shadow: cssSetting.optional(),
  }).strict().optional(),
}).strict();

// JSON is embedded in an HTML script raw-text element, not an HTML text node.
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk) => {
      if (oversized) return;
      const buf = Buffer.from(chunk);
      size += buf.byteLength;
      if (size > maxBodyBytes) {
        oversized = true;
        chunks.length = 0;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => { if (!oversized) resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}` ||
    (port === 80 && (normalized === "127.0.0.1" || normalized === "localhost"));
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.origin === `http://127.0.0.1:${port}` || url.origin === `http://localhost:${port}`;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string, nonce: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`,
  });
  res.end(html);
}

function clampCrew(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.min(12, Math.max(3, Math.floor(value)));
}

function normalizeSettings(input: Record<string, unknown>): Record<string, unknown> {
  const current = loadIdeaKingSettings(root);
  const next: Record<string, unknown> = { ...current };
  if (typeof input.language === "string") next.language = input.language.trim() || "auto";
  if (typeof input.spawnAgents === "boolean") next.spawnAgents = input.spawnAgents;
  if (input.crewSize !== undefined) next.crewSize = clampCrew(Number(input.crewSize));
  if (typeof input.theme === "string") next.theme = input.theme.trim().toLowerCase() || "atelier";
  if (typeof input.background === "string") next.background = input.background.trim();
  if (typeof input.heroBackground === "string") next.heroBackground = input.heroBackground.trim();
  if (typeof input.accent === "string") next.accent = input.accent.trim();
  if (typeof input.themeVars === "object" && input.themeVars !== null && !Array.isArray(input.themeVars)) {
    next.themeVars = input.themeVars;
  }
  return next;
}

function pageHtml(settings: Record<string, unknown>, themes: BoardTheme[], active: BoardTheme, nonce: string): string {
  const themeCards = themes
    .map((theme) => {
      const selected = theme.id === active.id ? " selected" : "";
      return `<button type="button" class="theme-card${selected}" data-theme="${escapeHtml(theme.id)}" style="--swatch-a:${escapeHtml(theme.bg)};--swatch-b:${escapeHtml(theme.panel)};--swatch-c:${escapeHtml(theme.accent)};--swatch-d:${escapeHtml(theme.line)};--swatch-e:${escapeHtml(theme.text)}">
  <span class="swatches" aria-hidden="true">
    <i style="background:var(--swatch-a)"></i>
    <i style="background:var(--swatch-b)"></i>
    <i style="background:var(--swatch-c)"></i>
    <i style="background:var(--swatch-d)"></i>
    <i style="background:var(--swatch-e)"></i>
  </span>
  <strong>${escapeHtml(theme.id)}</strong>
</button>`;
    })
    .join("\n");

  const language = typeof settings.language === "string" ? settings.language : "auto";
  const spawnAgents = settings.spawnAgents !== false;
  const crewSize = clampCrew(settings.crewSize);
  const background = typeof settings.background === "string" ? settings.background : "";
  const heroBackground = typeof settings.heroBackground === "string" ? settings.heroBackground : "";
  const accent = typeof settings.accent === "string" ? settings.accent : "";
  const themeVars =
    typeof settings.themeVars === "object" && settings.themeVars !== null && !Array.isArray(settings.themeVars)
      ? (settings.themeVars as Record<string, string>)
      : {};
  const safeAccent = escapeHtml(accent || active.accent);
  const safeBackground = escapeHtml(background);
  const safeHeroBackground = escapeHtml(heroBackground);
  const safePanel = escapeHtml(themeVars.panel ?? "");
  const safeText = escapeHtml(themeVars.text ?? "");
  const safeMuted = escapeHtml(themeVars.muted ?? "");
  const safeLine = escapeHtml(themeVars.line ?? "");

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>点子王设置</title>
<style>
  :root {
    --bg: ${escapeHtml(active.bg)};
    --panel: ${escapeHtml(active.panel)};
    --panel-2: ${escapeHtml(active.panel2)};
    --line: ${escapeHtml(active.line)};
    --text: ${escapeHtml(active.text)};
    --muted: ${escapeHtml(active.muted)};
    --accent: ${escapeHtml(active.accent)};
    --page-bg: ${escapeHtml(active.pageBg)};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font: 15px/1.55 "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
    color: var(--text);
    background: var(--page-bg);
    background-attachment: fixed;
  }
  .shell { max-width: 920px; margin: 0 auto; padding: 28px 18px 64px; }
  .hero {
    border: 1px solid color-mix(in srgb, var(--line) 70%, white);
    border-radius: 22px;
    padding: 24px;
    background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 18%, white), var(--panel));
    box-shadow: 0 18px 40px rgba(17,97,107,.1);
    margin-bottom: 18px;
  }
  .hero h1 { margin: 0 0 8px; font-size: 1.7rem; }
  .hero p { margin: 0; color: var(--muted); }
  section {
    background: var(--panel);
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
    border-radius: 18px;
    padding: 18px;
    margin: 0 0 14px;
    box-shadow: 0 12px 28px rgba(17,97,107,.08);
  }
  h2 { margin: 0 0 14px; font-size: 1.05rem; }
  .themes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 10px;
  }
  .theme-card {
    appearance: none;
    border: 2px solid transparent;
    border-radius: 16px;
    padding: 12px;
    background: var(--panel-2);
    cursor: pointer;
    text-align: left;
    color: inherit;
    transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
  }
  .theme-card:hover { transform: translateY(-2px); }
  .theme-card.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
  }
  .swatches { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin-bottom: 10px; }
  .swatches i { display: block; height: 28px; border-radius: 8px; }
  .theme-card strong { font-size: 13px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  label.field {
    display: grid;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
  }
  label.field span { font-weight: 650; color: var(--text); }
  input, select, textarea {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--line) 60%, white);
    border-radius: 12px;
    padding: 10px 12px;
    font: inherit;
    color: var(--text);
    background: #fff;
  }
  textarea { min-height: 72px; resize: vertical; }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-radius: 14px;
    background: var(--panel-2);
    border: 1px solid color-mix(in srgb, var(--line) 45%, white);
  }
  .toggle strong { display: block; margin-bottom: 2px; }
  .toggle small { color: var(--muted); }
  .switch {
    position: relative;
    width: 48px;
    height: 28px;
    flex: 0 0 auto;
  }
  .switch input { opacity: 0; width: 0; height: 0; }
  .switch em {
    position: absolute; inset: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--line) 50%, white);
    cursor: pointer;
    transition: .2s ease;
  }
  .switch em::after {
    content: "";
    position: absolute;
    width: 22px; height: 22px;
    left: 3px; top: 3px;
    border-radius: 50%;
    background: white;
    transition: .2s ease;
  }
  .switch input:checked + em { background: var(--accent); }
  .switch input:checked + em::after { transform: translateX(20px); }
  .preview {
    border-radius: 16px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--line) 50%, white);
    min-height: 120px;
    background: var(--page-bg);
    padding: 18px;
  }
  .preview .card {
    background: var(--panel);
    border-radius: 14px;
    padding: 14px 16px;
    border: 1px solid color-mix(in srgb, var(--line) 55%, white);
  }
  .preview .eyebrow { color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: .08em; }
  .preview .title { margin: 6px 0 0; font-size: 1.2rem; color: var(--text); }
  .actions {
    position: sticky;
    bottom: 14px;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    padding: 12px;
    border-radius: 16px;
    background: color-mix(in srgb, var(--panel) 88%, transparent);
    backdrop-filter: blur(10px);
    border: 1px solid color-mix(in srgb, var(--line) 45%, white);
  }
  button.primary, button.ghost {
    appearance: none;
    border: 0;
    border-radius: 999px;
    padding: 11px 18px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  button.primary { background: var(--accent); color: white; }
  button.ghost { background: var(--panel-2); color: var(--text); border: 1px solid color-mix(in srgb, var(--line) 55%, white); }
  .toast {
    position: fixed;
    right: 18px;
    bottom: 88px;
    background: var(--text);
    color: white;
    padding: 10px 14px;
    border-radius: 999px;
    opacity: 0;
    transform: translateY(8px);
    transition: .2s ease;
    pointer-events: none;
  }
  .toast.show { opacity: 1; transform: none; }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="shell">
  <header class="hero">
    <h1>点子王设置</h1>
    <p>点选主题、拖颜色、改人数。保存后直接写入配置，不用打开代码文件。</p>
  </header>

  <section>
    <h2>主题</h2>
    <div class="themes" id="themes">${themeCards}</div>
  </section>

  <section>
    <h2>预览</h2>
    <div class="preview" id="preview">
      <div class="card">
        <div class="eyebrow">IDEA KING</div>
        <div class="title">当前主题 · <span id="previewName">${active.id}</span></div>
      </div>
    </div>
  </section>

  <section>
    <h2>基本</h2>
    <div class="grid">
      <label class="field"><span>语言</span>
        <select id="language">
          <option value="auto"${language === "auto" ? " selected" : ""}>auto（跟随原话）</option>
          <option value="zh"${language === "zh" ? " selected" : ""}>zh 中文</option>
          <option value="en"${language === "en" ? " selected" : ""}>en English</option>
        </select>
      </label>
      <label class="field"><span>班组人数 crewSize（≥3）</span>
        <input id="crewSize" type="number" min="3" step="1" value="${crewSize}">
      </label>
    </div>
    <div style="height:12px"></div>
    <label class="toggle">
      <div>
        <strong>新开子代理</strong>
        <small>关掉后当前对话一人扮完班组</small>
      </div>
      <span class="switch">
        <input id="spawnAgents" type="checkbox"${spawnAgents ? " checked" : ""}>
        <em></em>
      </span>
    </label>
  </section>

  <section>
    <h2>自定义外观</h2>
    <div class="grid">
      <label class="field"><span>强调色 accent</span>
        <input id="accent" type="color" value="${/^#[0-9a-fA-F]{6}$/.test(accent) ? escapeHtml(accent) : escapeHtml(active.accent)}">
      </label>
      <label class="field"><span>强调色代码</span>
        <input id="accentText" type="text" value="${safeAccent}" placeholder="#DC8B70">
      </label>
      <label class="field" style="grid-column:1/-1"><span>整页背景 background</span>
        <textarea id="background" placeholder="留空用主题自带，或写渐变 / url(...)">${safeBackground}</textarea>
      </label>
      <label class="field" style="grid-column:1/-1"><span>英雄区背景 heroBackground</span>
        <textarea id="heroBackground" placeholder="留空用主题自带">${safeHeroBackground}</textarea>
      </label>
      <label class="field"><span>面板 panel</span>
        <input id="var-panel" type="text" value="${safePanel}" placeholder="可选覆盖">
      </label>
      <label class="field"><span>正文 text</span>
        <input id="var-text" type="text" value="${safeText}" placeholder="可选覆盖">
      </label>
      <label class="field"><span>次要 muted</span>
        <input id="var-muted" type="text" value="${safeMuted}" placeholder="可选覆盖">
      </label>
      <label class="field"><span>描边 line</span>
        <input id="var-line" type="text" value="${safeLine}" placeholder="可选覆盖">
      </label>
    </div>
  </section>

  <div class="actions">
    <button type="button" class="ghost" id="reload">重载</button>
    <button type="button" class="primary" id="save">保存设置</button>
  </div>
</div>
<div class="toast" id="toast">已保存</div>
<script nonce="${nonce}">
  const pageToken = ${scriptJson(pageToken)};
  const state = {
    theme: ${scriptJson(active.id)},
    themes: ${scriptJson(themes)},
  };

  const toast = document.getElementById("toast");
  function flash(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 1600);
  }

  function selectedTheme() {
    return state.themes.find((item) => item.id === state.theme) || state.themes[0];
  }

  function paintPreview() {
    const theme = selectedTheme();
    const accent = document.getElementById("accentText").value.trim() || theme.accent;
    const root = document.documentElement.style;
    root.setProperty("--bg", theme.bg);
    root.setProperty("--panel", document.getElementById("var-panel").value.trim() || theme.panel);
    root.setProperty("--panel-2", theme.panel2);
    root.setProperty("--line", document.getElementById("var-line").value.trim() || theme.line);
    root.setProperty("--text", document.getElementById("var-text").value.trim() || theme.text);
    root.setProperty("--muted", document.getElementById("var-muted").value.trim() || theme.muted);
    root.setProperty("--accent", accent);
    const customBg = document.getElementById("background").value.trim();
    root.setProperty("--page-bg", customBg || theme.pageBg);
    document.getElementById("previewName").textContent = theme.id;
    document.querySelectorAll(".theme-card").forEach((card) => {
      card.classList.toggle("selected", card.dataset.theme === state.theme);
    });
  }

  document.getElementById("themes").addEventListener("click", (event) => {
    const button = event.target.closest(".theme-card");
    if (!button) return;
    state.theme = button.dataset.theme;
    const theme = selectedTheme();
    document.getElementById("accent").value = theme.accent;
    document.getElementById("accentText").value = theme.accent;
    paintPreview();
  });

  document.getElementById("accent").addEventListener("input", (event) => {
    document.getElementById("accentText").value = event.target.value;
    paintPreview();
  });
  ["accentText", "background", "heroBackground", "var-panel", "var-text", "var-muted", "var-line"].forEach((id) => {
    document.getElementById(id).addEventListener("input", paintPreview);
  });

  async function load() {
    const res = await fetch("/api/settings");
    const data = await res.json();
    state.theme = data.settings.theme || state.theme;
    state.themes = data.themes;
    document.getElementById("language").value = data.settings.language || "auto";
    document.getElementById("crewSize").value = data.settings.crewSize || 5;
    document.getElementById("spawnAgents").checked = data.settings.spawnAgents !== false;
    document.getElementById("background").value = data.settings.background || "";
    document.getElementById("heroBackground").value = data.settings.heroBackground || "";
    document.getElementById("accentText").value = data.settings.accent || selectedTheme().accent;
    document.getElementById("accent").value = /^#[0-9a-fA-F]{6}$/.test(document.getElementById("accentText").value)
      ? document.getElementById("accentText").value
      : selectedTheme().accent;
    const vars = data.settings.themeVars || {};
    document.getElementById("var-panel").value = vars.panel || "";
    document.getElementById("var-text").value = vars.text || "";
    document.getElementById("var-muted").value = vars.muted || "";
    document.getElementById("var-line").value = vars.line || "";
    paintPreview();
  }

  document.getElementById("reload").addEventListener("click", () => load().then(() => flash("已重载")));
  document.getElementById("save").addEventListener("click", async () => {
    const payload = {
      language: document.getElementById("language").value,
      crewSize: Number(document.getElementById("crewSize").value),
      spawnAgents: document.getElementById("spawnAgents").checked,
      theme: state.theme,
      background: document.getElementById("background").value,
      heroBackground: document.getElementById("heroBackground").value,
      accent: document.getElementById("accentText").value,
      themeVars: {
        panel: document.getElementById("var-panel").value,
        text: document.getElementById("var-text").value,
        muted: document.getElementById("var-muted").value,
        line: document.getElementById("var-line").value,
      },
    };
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idea-King-Token": pageToken,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      flash("保存失败");
      return;
    }
    flash("已保存");
    await load();
  });

  paintPreview();
</script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: "bad_host" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && url.pathname === "/") {
      const settings = loadIdeaKingSettings(root);
      const themes = listBoardThemeCatalog(root);
      const active = resolveBoardTheme(root);
      const nonce = randomBytes(18).toString("base64");
      sendHtml(res, pageHtml(settings, themes, active, nonce), nonce);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      sendJson(res, 200, {
        settings: loadIdeaKingSettings(root),
        themes: listBoardThemeCatalog(root),
        active: resolveBoardTheme(root),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (!hostAllowed(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: "bad_host" });
        return;
      }
      if (!originAllowed(req.headers.origin)) {
        sendJson(res, 403, { ok: false, error: "bad_origin" });
        return;
      }
      const contentType = String(req.headers["content-type"] ?? "");
      if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        sendJson(res, 415, { ok: false, error: "bad_content_type" });
        return;
      }
      const token = req.headers["x-idea-king-token"];
      if (token !== pageToken) {
        sendJson(res, 403, { ok: false, error: "bad_token" });
        return;
      }
      const declaredLength = Number(req.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        req.resume();
        sendJson(res, 413, { ok: false, error: "body_too_large" });
        return;
      }
      const raw = await readBody(req);
      const parsed = settingsPayload.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        sendJson(res, 400, { ok: false, error: "settings_schema_invalid" });
        return;
      }
      const next = normalizeSettings(parsed.data);
      saveIdeaKingSettings(next, root);
      sendJson(res, 200, {
        ok: true,
        settings: loadIdeaKingSettings(root),
        active: resolveBoardTheme(root),
      });
      return;
    }
    res.writeHead(404).end("not found");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "error";
    sendJson(res, error instanceof SyntaxError ? 400 : detail === "body_too_large" ? 413 : 500,
      { ok: false, error: error instanceof SyntaxError ? "settings_json_invalid" : detail });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.listen(port, "127.0.0.1", () => {
  const href = `http://127.0.0.1:${port}/`;
  process.stdout.write(`idea-king settings: ${href}\n`);
});
