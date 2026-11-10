import type { AudienceReport, Evidence, Session } from "../src/schema.ts";
import { audienceDefaults, evidenceDefaults, sessionDefaults } from "../src/session-defaults.ts";

export { audienceDefaults, evidenceDefaults, sessionDefaults };

export function blankSession(id: string, overrides: Partial<Session> = {}): Session {
  return sessionDefaults({
    id,
    userText: "做成一件能试用的东西",
    material: "",
    draftMarks: [],
    marks: [],
    cells: [],
    lastRoundCells: [],
    audience: null,
    verdict: null,
    discardedText: null,
    voidCount: 0,
    stopped: false,
    deliveryStatus: "incomplete",
    ...overrides,
  });
}

export function ev(
  partial: Omit<Evidence, "inode" | "materialHash" | "dependencyHashes" | "acceptOk" | "stale" | "runId" | "manifestHash"> &
    Partial<Evidence>,
): Evidence {
  return evidenceDefaults(partial);
}

export function aud(
  partial: Pick<AudienceReport, "firstStop" | "skipped" | "remembered"> &
    Partial<AudienceReport>,
): AudienceReport {
  return audienceDefaults(partial);
}

/** Script body: write product under out/ and print grab slices + made + out path. */
export function outProductScript(opts: {
  grabA: string;
  grabB: string;
  made: string;
  entry?: string;
  embedMadeInSource?: boolean;
}): string {
  const entry = opts.entry ?? "play.html";
  const madeLine = opts.embedMadeInSource
    ? `const made = ${JSON.stringify(opts.made)};`
    : `const made = ${JSON.stringify(opts.made)};`;
  return `const fs = require("fs");
const path = require("path");
${madeLine}
const outDir = path.join(process.cwd(), "out");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, ${JSON.stringify(entry)}), "<html>" + made + "</html>");
process.stdout.write(${JSON.stringify(opts.grabA)} + "\\n" + ${JSON.stringify(opts.grabB)} + "\\n" + made + "\\nout/${entry}\\n");
`;
}
