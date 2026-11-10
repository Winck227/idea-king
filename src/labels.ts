import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const settingsRelativePath = ".cursor/idea-king.json";
export const labelsRelativePath = ".cursor/idea-king.labels.json";
export const themesRelativePath = ".cursor/idea-king.themes.json";
const defaultThemeId = "atelier";

export type LabelPack = {
  htmlLang: string;
  title: string;
  language: string;
  settings: string;
  original: string;
  budget: string;
  grabbedFiles: string;
  grabChars: string;
  productChars: string;
  expectedOutputChars: string;
  expectedTokens: string;
  who: string;
  file: string;
  sourceText: string;
  think: string;
  role: string;
  cells: string;
  option: string;
  constraint: string;
  status: string;
  quote: string;
  conclusion: string;
  statusSupported: string;
  statusMissing: string;
  statusContradicts: string;
  work: string;
  script: string;
  exitCode: string;
  elapsed: string;
  output: string;
  spend: string;
  exitCodeLine: string;
  elapsedLine: string;
  expectedTokensLine: string;
  actualTokensLine: string;
  spendLine: string;
  elapsedJoin: string;
  estimateNote: string;
  emptyWho: string;
  emptyThink: string;
  emptyWork: string;
  emptySpend: string;
  chartChars: string;
  chartTokens: string;
  chartShare: string;
  noConclusion: string;
  refuseTie: string;
  selected: string;
  missingOnly: string;
  incompleteDelivery: string;
};

const labelKeys: (keyof LabelPack)[] = [
  "htmlLang",
  "title",
  "language",
  "settings",
  "original",
  "budget",
  "grabbedFiles",
  "grabChars",
  "productChars",
  "expectedOutputChars",
  "expectedTokens",
  "who",
  "file",
  "sourceText",
  "think",
  "role",
  "cells",
  "option",
  "constraint",
  "status",
  "quote",
  "conclusion",
  "statusSupported",
  "statusMissing",
  "statusContradicts",
  "work",
  "script",
  "exitCode",
  "elapsed",
  "output",
  "spend",
  "exitCodeLine",
  "elapsedLine",
  "expectedTokensLine",
  "actualTokensLine",
  "spendLine",
  "elapsedJoin",
  "estimateNote",
  "emptyWho",
  "emptyThink",
  "emptyWork",
  "emptySpend",
  "chartChars",
  "chartTokens",
  "chartShare",
  "noConclusion",
  "refuseTie",
  "selected",
  "missingOnly",
  "incompleteDelivery",
];

export const chinesePack: LabelPack = {
  htmlLang: "zh",
  title: "点子王",
  language: "语言",
  settings: "设置",
  original: "原话",
  budget: "预算",
  grabbedFiles: "抓来的文件",
  grabChars: "抓取字数",
  productChars: "成品字数",
  expectedOutputChars: "预计输出字数",
  expectedTokens: "预计 token（估算）",
  who: "抓了谁",
  file: "文件",
  sourceText: "原文",
  think: "思考",
  role: "角色",
  cells: "格子",
  option: "选项",
  constraint: "硬条件",
  status: "状态",
  quote: "引用",
  conclusion: "结论",
  statusSupported: "已支持",
  statusMissing: "空缺",
  statusContradicts: "矛盾",
  work: "干活",
  script: "脚本",
  exitCode: "退出码",
  elapsed: "耗时",
  output: "输出",
  spend: "消耗",
  exitCodeLine: "退出码 {code}",
  elapsedLine: "{ms} 毫秒",
  expectedTokensLine: "预计 token（估算） {count}",
  actualTokensLine: "实际 token（估算） {count}",
  spendLine: "抓取字数 {grab}，成品字数 {product}，输出字数 {output}",
  elapsedJoin: "，耗时 {elapsed}",
  estimateNote: "估算 token = 向上取整(字数 / 2)。字数是抓取原文、成品源码、运行输出的字符数。",
  emptyWho: "还没有抓取。",
  emptyThink: "还没有思考记录。",
  emptyWork: "还没有跑通脚本。",
  emptySpend: "跑通之后才会出现消耗图。",
  chartChars: "字数构成",
  chartTokens: "Token 对比",
  chartShare: "字数占比",
  noConclusion: "这轮没有结论。",
  refuseTie: "还不能选。请再补一条硬条件。",
  selected: "选定「{option}」，因为「{condition}」。",
  missingOnly: "还不能选。只缺：{missing}。",
  incompleteDelivery: "还不能交付。选项被选中，但交付条件未齐。",
};
Object.freeze(chinesePack);

export const englishPack: LabelPack = {
  htmlLang: "en",
  title: "Idea King",
  language: "Language",
  settings: "Settings",
  original: "Original",
  budget: "Budget",
  grabbedFiles: "Files grabbed",
  grabChars: "Grabbed characters",
  productChars: "Product characters",
  expectedOutputChars: "Expected output characters",
  expectedTokens: "Expected tokens (estimate)",
  who: "Who was grabbed",
  file: "File",
  sourceText: "Original",
  think: "Thinking",
  role: "Role",
  cells: "Cells",
  option: "Option",
  constraint: "Constraint",
  status: "Status",
  quote: "Quote",
  conclusion: "Conclusion",
  statusSupported: "Supported",
  statusMissing: "Missing",
  statusContradicts: "Contradicts",
  work: "Work",
  script: "Script",
  exitCode: "Exit code",
  elapsed: "Elapsed",
  output: "Output",
  spend: "Spend",
  exitCodeLine: "Exit code {code}",
  elapsedLine: "{ms} ms",
  expectedTokensLine: "Expected tokens (estimate) {count}",
  actualTokensLine: "Actual tokens (estimate) {count}",
  spendLine: "Grabbed characters {grab}, product characters {product}, output characters {output}",
  elapsedJoin: ", elapsed {elapsed}",
  estimateNote:
    "Estimated tokens = ceil(characters / 2). Characters are the grabbed text, the product source, and the run output.",
  emptyWho: "Nothing grabbed yet.",
  emptyThink: "No thinking notes yet.",
  emptyWork: "No successful run yet.",
  emptySpend: "Spend charts appear after a run.",
  chartChars: "Character mix",
  chartTokens: "Token compare",
  chartShare: "Character share",
  noConclusion: "No conclusion this round.",
  refuseTie: "Cannot choose yet. Add one more hard condition.",
  selected: "Selected 「{option}」 because 「{condition}」.",
  missingOnly: "Cannot choose yet. Missing only: {missing}.",
  incompleteDelivery: "Not delivered yet. An option was selected, but delivery checks are incomplete.",
};
Object.freeze(englishPack);

export function fillLabel(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : String(value);
  });
}

function isPack(value: unknown): value is LabelPack {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return labelKeys.every((key) => typeof record[key] === "string");
}

function readJson(file: string): unknown {
  if (statSync(file).size > 1024 * 1024) throw new Error("settings_file_too_large");
  const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as unknown;
}

function readSettings(root: string): Record<string, unknown> | undefined {
  try {
    const parsed = readJson(path.join(root, ".cursor", "idea-king.json"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function loadIdeaKingSettings(root = process.cwd()): Record<string, unknown> {
  return { ...(readSettings(root) ?? {}) };
}

export function saveIdeaKingSettings(
  settings: Record<string, unknown>,
  root = process.cwd(),
): void {
  const dir = path.join(root, ".cursor");
  const target = path.join(dir, "idea-king.json");
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim().length === 0 && key !== "language") {
      continue;
    }
    if (key === "themeVars" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const vars: Record<string, string> = {};
      for (const [varKey, varValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof varValue !== "string") continue;
        const trimmed = varValue.trim();
        if (trimmed.length === 0) continue;
        vars[varKey] = trimmed;
      }
      if (Object.keys(vars).length > 0) cleaned.themeVars = vars;
      continue;
    }
    cleaned[key] = value;
  }
  if (!cleaned.language) cleaned.language = "auto";
  if (cleaned.spawnAgents === undefined) cleaned.spawnAgents = true;
  if (cleaned.crewSize === undefined) cleaned.crewSize = 5;
  cleaned.crewSize = typeof cleaned.crewSize === "number" && Number.isFinite(cleaned.crewSize)
    ? Math.min(12, Math.max(3, Math.floor(cleaned.crewSize))) : 5;
  if (!cleaned.theme) cleaned.theme = defaultThemeId;
  mkdirSync(dir, { recursive: true });
  writeFileSync(target, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
}

function readLanguage(root: string): string {
  const settings = readSettings(root);
  if (!settings) return "auto";
  const language = settings.language;
  if (typeof language !== "string") return "auto";
  const trimmed = language.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : "auto";
}

export function resolveCrewSize(root?: string): number {
  const fallback = 5;
  if (!root) return fallback;
  const settings = readSettings(root);
  if (!settings) return fallback;
  const raw = settings.crewSize;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.min(12, Math.max(3, Math.floor(raw)));
}

export type BoardTheme = {
  id: string;
  pageBg: string;
  heroBg: string;
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  ok: string;
  warn: string;
  bad: string;
  shadow: string;
};

const themeFieldKeys: (keyof BoardTheme)[] = [
  "pageBg",
  "heroBg",
  "bg",
  "panel",
  "panel2",
  "line",
  "text",
  "muted",
  "accent",
  "ok",
  "warn",
  "bad",
  "shadow",
];

const themePresets: Record<string, BoardTheme> = {
  atelier: {
    id: "atelier",
    pageBg:
      "radial-gradient(1000px 520px at 8% -6%, #fed9cd 0%, transparent 52%), radial-gradient(900px 480px at 100% 0%, #7bbdb6 0%, transparent 48%), linear-gradient(180deg, #ebf4f8 0%, #f7fbfc 48%, #fed9cd 100%)",
    heroBg:
      "linear-gradient(135deg, rgba(123,189,182,.35), transparent 46%), linear-gradient(160deg, #ebf4f8, #fed9cd)",
    bg: "#ebf4f8",
    panel: "#ffffff",
    panel2: "#ebf4f8",
    line: "#7bbdb6",
    text: "#11616b",
    muted: "#4f8f94",
    accent: "#dc8b70",
    ok: "#7bbdb6",
    warn: "#dc8b70",
    bad: "#c45c5c",
    shadow: "0 18px 42px rgba(17,97,107,.12)",
  },
  azure: {
    id: "azure",
    pageBg:
      "radial-gradient(1100px 520px at 10% -8%, #3498db 0%, transparent 52%), radial-gradient(900px 460px at 100% 0%, #196090 0%, transparent 50%), linear-gradient(165deg, #0a2639 0%, #123a54 45%, #0a2639 100%)",
    heroBg:
      "linear-gradient(135deg, rgba(52,152,219,.42), transparent 48%), linear-gradient(160deg, #196090, #0a2639)",
    bg: "#0a2639",
    panel: "#196090",
    panel2: "#1f6fa3",
    line: "#8bc4ea",
    text: "#d4e9f7",
    muted: "#8bc4ea",
    accent: "#3498db",
    ok: "#5dcea0",
    warn: "#e0c36a",
    bad: "#e88a8a",
    shadow: "0 22px 50px rgba(10,38,57,.5)",
  },
  ember: {
    id: "ember",
    pageBg:
      "radial-gradient(1100px 520px at 12% -8%, #ff8a4c 0%, transparent 52%), radial-gradient(900px 460px at 100% 0%, #d4522a 0%, transparent 48%), linear-gradient(165deg, #2a120c 0%, #4a2418 42%, #3a1a12 100%)",
    heroBg:
      "linear-gradient(135deg, rgba(255,140,70,.45), transparent 48%), linear-gradient(160deg, #6a2e18, #3e1810)",
    bg: "#2c160f",
    panel: "#4a281c",
    panel2: "#5c3224",
    line: "#8a5238",
    text: "#fff3ea",
    muted: "#e0b8a0",
    accent: "#ff9a5c",
    ok: "#7dcc8e",
    warn: "#ffc15e",
    bad: "#ff7d8a",
    shadow: "0 22px 50px rgba(40,12,6,.45)",
  },
  honey: {
    id: "honey",
    pageBg:
      "radial-gradient(1000px 480px at 8% 0%, #ffc857 0%, transparent 55%), linear-gradient(180deg, #3a280e 0%, #5a3e16 48%, #4a3012 100%)",
    heroBg: "linear-gradient(135deg, rgba(255,200,80,.4), transparent 50%), linear-gradient(160deg, #6a4a18, #4a3410)",
    bg: "#3a2a12",
    panel: "#5a421c",
    panel2: "#6c5024",
    line: "#9a7840",
    text: "#fff8e8",
    muted: "#e0c890",
    accent: "#ffc857",
    ok: "#7dcc8e",
    warn: "#ffb020",
    bad: "#e88a70",
    shadow: "0 22px 50px rgba(40,25,5,.42)",
  },
  clay: {
    id: "clay",
    pageBg:
      "radial-gradient(1000px 480px at 10% -5%, #d4a574 0%, transparent 52%), linear-gradient(165deg, #2a1c16 0%, #4a3228 45%, #3a281e 100%)",
    heroBg: "linear-gradient(135deg, rgba(212,165,116,.35), transparent 48%), linear-gradient(160deg, #5a3e32, #3a2820)",
    bg: "#2e201a",
    panel: "#4a362c",
    panel2: "#5c4438",
    line: "#8a6a58",
    text: "#f8efe6",
    muted: "#cbb09a",
    accent: "#e0a878",
    ok: "#7dcc8e",
    warn: "#e0b060",
    bad: "#d88880",
    shadow: "0 22px 50px rgba(30,18,12,.42)",
  },
  peach: {
    id: "peach",
    pageBg:
      "radial-gradient(1000px 500px at 0% 0%, #ffb4a2 0%, transparent 52%), radial-gradient(800px 420px at 100% 8%, #ff8fab 0%, transparent 48%), linear-gradient(180deg, #fff0ea 0%, #ffd8cc 55%, #f5c4b4 100%)",
    heroBg: "linear-gradient(135deg, rgba(255,160,140,.45), transparent 50%), linear-gradient(160deg, #ffe2d8, #ffc8b8)",
    bg: "#fff2ec",
    panel: "#ffffff",
    panel2: "#ffe8de",
    line: "#e8b8a8",
    text: "#4a2c28",
    muted: "#9a6a60",
    accent: "#e87860",
    ok: "#3d9a6a",
    warn: "#d4a020",
    bad: "#c45656",
    shadow: "0 18px 40px rgba(120,60,40,.16)",
  },
  wine: {
    id: "wine",
    pageBg:
      "radial-gradient(1000px 480px at 12% -5%, #c45c6a 0%, transparent 50%), radial-gradient(800px 420px at 100% 0%, #8a2f4a 0%, transparent 48%), linear-gradient(165deg, #220f16 0%, #3e1a28 42%, #2e1420 100%)",
    heroBg: "linear-gradient(135deg, rgba(196,92,106,.4), transparent 48%), linear-gradient(160deg, #5a2438, #30141f)",
    bg: "#261018",
    panel: "#42202c",
    panel2: "#542838",
    line: "#7a4050",
    text: "#ffeef2",
    muted: "#d8a8b4",
    accent: "#e87890",
    ok: "#7dcc8e",
    warn: "#e0b060",
    bad: "#ff7d8a",
    shadow: "0 22px 50px rgba(30,8,16,.45)",
  },
  sand: {
    id: "sand",
    pageBg:
      "radial-gradient(900px 420px at 10% 0%, #f0d9a8 0%, transparent 55%), linear-gradient(180deg, #faf0de 0%, #ead9b8 55%, #dcc8a0 100%)",
    heroBg: "linear-gradient(135deg, rgba(240,200,120,.4), transparent 50%), linear-gradient(160deg, #f5e6c8, #e6d2a8)",
    bg: "#f4e8d0",
    panel: "#fffaf0",
    panel2: "#f3e4c4",
    line: "#d2b88a",
    text: "#3a2c18",
    muted: "#8a7350",
    accent: "#c47828",
    ok: "#2f8f5b",
    warn: "#b8872a",
    bad: "#b84a4a",
    shadow: "0 18px 40px rgba(90,60,30,.16)",
  },
  sunset: {
    id: "sunset",
    pageBg:
      "radial-gradient(1000px 480px at 10% -5%, #ff7a59 0%, transparent 50%), radial-gradient(800px 420px at 100% 10%, #c44b8a 0%, transparent 48%), linear-gradient(165deg, #2a1220 0%, #4a1e2e 40%, #3a1830 100%)",
    heroBg: "linear-gradient(135deg, rgba(255,140,90,.4), transparent 48%), linear-gradient(160deg, #5a2438, #3a1828)",
    bg: "#2e1524",
    panel: "#4a2238",
    panel2: "#5c2c44",
    line: "#8a4a62",
    text: "#fff4f0",
    muted: "#e0b0bc",
    accent: "#ff9a6c",
    ok: "#7dcc8e",
    warn: "#ffc15e",
    bad: "#ff7d8a",
    shadow: "0 22px 50px rgba(40,10,20,.45)",
  },
  paper: {
    id: "paper",
    pageBg:
      "radial-gradient(900px 420px at 10% 0%, #ffe7c2 0%, transparent 55%), linear-gradient(180deg, #fff7ea 0%, #f3e6d2 55%, #ead9c0 100%)",
    heroBg: "linear-gradient(135deg, rgba(255,180,100,.35), transparent 50%), linear-gradient(160deg, #fff1dc, #f0d8b4)",
    bg: "#f7ebda",
    panel: "#fffaf2",
    panel2: "#f6e8d2",
    line: "#d4b992",
    text: "#2c2118",
    muted: "#7a6550",
    accent: "#c45c26",
    ok: "#2f8f5b",
    warn: "#b8872a",
    bad: "#b84a4a",
    shadow: "0 18px 40px rgba(90,60,30,.18)",
  },
  aurora: {
    id: "aurora",
    pageBg:
      "radial-gradient(1100px 520px at 8% -10%, #2a6b8a 0%, transparent 55%), radial-gradient(900px 480px at 100% 0%, #6b3fa0 0%, transparent 50%), linear-gradient(165deg, #0b1c2e 0%, #14253a 45%, #1a1430 100%)",
    heroBg:
      "linear-gradient(135deg, rgba(64,196,180,.35), transparent 45%), linear-gradient(160deg, #1a3a55, #24183f 75%)",
    bg: "#122033",
    panel: "#173047",
    panel2: "#1e3b55",
    line: "#3a5f7a",
    text: "#f2f8ff",
    muted: "#9ec0d8",
    accent: "#5ee0c8",
    ok: "#4ecf8c",
    warn: "#f0b45a",
    bad: "#ef7a7a",
    shadow: "0 22px 50px rgba(8,20,40,.4)",
  },
  ocean: {
    id: "ocean",
    pageBg:
      "radial-gradient(1000px 500px at 0% 0%, #1a7fbf 0%, transparent 55%), linear-gradient(180deg, #06243a 0%, #0a3a58 50%, #0d4f6a 100%)",
    heroBg: "linear-gradient(135deg, rgba(40,180,230,.35), transparent 50%), linear-gradient(160deg, #0d3d5c, #0a2c44)",
    bg: "#0a3048",
    panel: "#0f4060",
    panel2: "#155278",
    line: "#2f7aa3",
    text: "#f0f9ff",
    muted: "#9fd0ea",
    accent: "#4ec6f0",
    ok: "#3dcea0",
    warn: "#e8c36a",
    bad: "#e88a8a",
    shadow: "0 22px 50px rgba(0,30,50,.45)",
  },
  forest: {
    id: "forest",
    pageBg:
      "radial-gradient(1000px 500px at 12% -8%, #3d9a6a 0%, transparent 52%), radial-gradient(700px 400px at 100% 0%, #2f6b4e 0%, transparent 48%), linear-gradient(180deg, #0e1f18 0%, #163428 45%, #1a3a2c 100%)",
    heroBg: "linear-gradient(135deg, rgba(80,180,120,.35), transparent 48%), linear-gradient(160deg, #1a3d2e, #123024)",
    bg: "#142820",
    panel: "#1c3a2e",
    panel2: "#244a3a",
    line: "#3d6b55",
    text: "#eef8f2",
    muted: "#9fc4b0",
    accent: "#6fd9a0",
    ok: "#4ecf8c",
    warn: "#d4b35a",
    bad: "#d98a8a",
    shadow: "0 22px 50px rgba(10,30,20,.42)",
  },
  mist: {
    id: "mist",
    pageBg:
      "radial-gradient(1000px 480px at 0% 0%, #c9b6ff 0%, transparent 50%), radial-gradient(800px 420px at 100% 0%, #a8e0ff 0%, transparent 48%), linear-gradient(180deg, #f4f0ff 0%, #e8f4ff 55%, #ddefff 100%)",
    heroBg: "linear-gradient(135deg, rgba(170,140,255,.35), transparent 50%), linear-gradient(160deg, #efeaff, #dcefff)",
    bg: "#eef2ff",
    panel: "#ffffff",
    panel2: "#f3f0ff",
    line: "#c5c0e0",
    text: "#1f2440",
    muted: "#6b7190",
    accent: "#6a5cff",
    ok: "#2f9e6c",
    warn: "#c9922e",
    bad: "#c45656",
    shadow: "0 18px 40px rgba(60,50,120,.14)",
  },
};
Object.freeze(themePresets);

function sanitizeCssValue(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 600) return null;
  if (/[;{}<>]|@import|expression|javascript:|url\s*\(\s*['"]?\s*data:/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function isThemeShape(value: unknown): value is Omit<BoardTheme, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return themeFieldKeys.every((key) => typeof record[key] === "string");
}

function readCustomThemes(root: string): Record<string, BoardTheme> {
  try {
    const parsed = readJson(path.join(root, ".cursor", "idea-king.themes.json"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const packs: Record<string, BoardTheme> = Object.create(null);
    for (const [key, value] of Object.entries(parsed).slice(0, 128)) {
      const code = key.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(code) || !isThemeShape(value)) continue;
      const clean = {} as BoardTheme;
      let valid = true;
      for (const field of themeFieldKeys) {
        const safe = sanitizeCssValue(value[field as keyof typeof value]);
        if (safe === null) { valid = false; break; }
        clean[field] = safe;
      }
      if (valid) packs[code] = { ...clean, id: code };
    }
    return packs;
  } catch {
    return {};
  }
}

function applyThemeVars(target: BoardTheme, vars: Record<string, unknown>): void {
  for (const key of themeFieldKeys) {
    const raw = vars[key];
    if (typeof raw !== "string") continue;
    const safe = sanitizeCssValue(raw);
    if (safe) target[key] = safe;
  }
}

export function resolveBoardTheme(root?: string): BoardTheme {
  const fallback = themePresets[defaultThemeId] ?? themePresets.ember;
  if (!root) return fallback;
  const settings = readSettings(root);
  const custom = readCustomThemes(root);
  const catalog: Record<string, BoardTheme> = { ...themePresets, ...custom };
  if (!settings) return fallback;
  const rawTheme = settings.theme;
  const themeId =
    typeof rawTheme === "string" && rawTheme.trim().length > 0
      ? rawTheme.trim().toLowerCase()
      : defaultThemeId;
  const base = catalog[themeId] ?? fallback;
  const next: BoardTheme = { ...base, id: catalog[themeId] ? themeId : base.id };
  const background = settings.background;
  if (typeof background === "string") {
    const safe = sanitizeCssValue(background);
    if (safe) next.pageBg = safe;
  }
  const heroBackground = settings.heroBackground;
  if (typeof heroBackground === "string") {
    const safe = sanitizeCssValue(heroBackground);
    if (safe) next.heroBg = safe;
  }
  const accent = settings.accent;
  if (typeof accent === "string") {
    const safe = sanitizeCssValue(accent);
    if (safe) next.accent = safe;
  }
  const themeVars = settings.themeVars;
  if (typeof themeVars === "object" && themeVars !== null && !Array.isArray(themeVars)) {
    applyThemeVars(next, themeVars as Record<string, unknown>);
  }
  return next;
}

export function listBoardThemes(root?: string): string[] {
  const custom = root ? readCustomThemes(root) : {};
  return [...new Set([...Object.keys(themePresets), ...Object.keys(custom)])];
}

export function listBoardThemeCatalog(root?: string): BoardTheme[] {
  const custom = root ? readCustomThemes(root) : {};
  const catalog: Record<string, BoardTheme> = { ...themePresets, ...custom };
  return listBoardThemes(root).map((id) => catalog[id] ?? { ...themePresets[defaultThemeId], id });
}

function readExtra(root: string): Record<string, LabelPack> {
  try {
    const parsed = readJson(path.join(root, ".cursor", "idea-king.labels.json"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const packs: Record<string, LabelPack> = Object.create(null);
    for (const [key, value] of Object.entries(parsed)) {
      const code = key.trim().toLowerCase();
      if (code.length === 0 || !isPack(value)) continue;
      packs[code] = value;
    }
    return packs;
  } catch {
    return {};
  }
}

function detectLanguage(userText: string): string {
  if (/\p{Script=Han}/u.test(userText)) return "zh";
  if (/\p{Script=Latin}/u.test(userText)) return "en";
  return "en";
}

function lookup(code: string, packs: Record<string, LabelPack>): LabelPack {
  const direct = packs[code];
  if (direct) return direct;
  const primary = code.split("-")[0] ?? "";
  if (primary.length > 0 && packs[primary]) return packs[primary];
  return packs.en ?? englishPack;
}

export function resolveLabels(
  userText: string,
  root?: string,
): { code: string; labels: LabelPack } {
  const setting = root ? readLanguage(root) : "auto";
  const code = setting === "auto" ? detectLanguage(userText) : setting;
  const packs: Record<string, LabelPack> = Object.create(null);
  packs.zh = chinesePack;
  packs.en = englishPack;
  if (root) {
    for (const [key, value] of Object.entries(readExtra(root))) packs[key] = value;
  }
  return { code, labels: lookup(code, packs) };
}
