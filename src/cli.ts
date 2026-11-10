import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import {
  addFact,
  commitSessionRound,
  confirmMarks,
  createSession,
  depositFileFact,
  depositGrabFact,
  depositManifestFact,
  depositRunFact,
  depositThinkFact,
  getSession,
  type ToolView,
} from "./tools.ts";
import {
  callerRoleSchema,
  draftMarkSchema,
  productManifestSchema,
  sessionModeSchema,
} from "./schema.ts";

type ArgMap = Map<string, string | true>;
const payloadLimit = 256 * 1024;

function parseStrictArgv(argv: string[]): { command: string | undefined; args: ArgMap; error?: string } {
  const command = argv[2];
  const args: ArgMap = new Map();
  const seen = new Set<string>();
  for (let i = 3; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      return { command, args, error: `unknown_positional:${token}` };
    }
    const name = token.slice(2);
    if (name.length === 0) return { command, args, error: "empty_flag" };
    if (seen.has(name)) return { command, args, error: `duplicate_flag:${name}` };
    seen.add(name);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args.set(name, true);
    } else {
      args.set(name, next);
      i += 1;
    }
  }
  return { command, args };
}

function requireArg(args: ArgMap, name: string): string {
  const value = args.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error("bad_request"), { detail: `missing_flag:${name}` });
  }
  return value;
}

function optionalArg(args: ArgMap, name: string): string | undefined {
  const value = args.get(name);
  return typeof value === "string" ? value : undefined;
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

async function readTextFile(filePath: string): Promise<string> {
  if ((await stat(filePath)).size > payloadLimit) {
    throw Object.assign(new Error("bad_request"), { detail: "payload_too_large" });
  }
  return stripBom(await readFile(filePath, "utf8"));
}

async function textArg(args: ArgMap, name: string, fileFlag: string): Promise<string> {
  const filePath = optionalArg(args, fileFlag);
  if (filePath) return readTextFile(filePath);
  return stripBom(requireArg(args, name));
}

function parseJson(raw: string, detail: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error("bad_request"), { detail });
  }
}

function emit(result: ToolView): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.error) process.exitCode = 1;
}

function emptyBad(detail: string): ToolView {
  return {
    error: detail.includes("duplicate") ? "duplicate_flag" : detail.includes("unknown") ? "unknown_flag" : "bad_request",
    errorDetail: detail,
    sessionId: null,
    sentence: null,
    boardPath: null,
    deliveryStatus: null,
    revision: null,
    verdict: null,
    marks: [],
    cells: [],
    lastRoundCells: [],
    audience: null,
    discardedText: null,
    evidence: [],
    budgetReady: false,
    voidCount: 0,
    stopped: false,
    retry: false,
    phase: null,
  };
}

const marksFileSchema = z.array(draftMarkSchema).max(64);
const modeSchema = sessionModeSchema.optional();
const roleSchema = callerRoleSchema.optional();

const allowedByCommand: Record<string, Set<string>> = {
  "create-session": new Set(["text", "material", "mode"]),
  "confirm-marks": new Set(["session", "marks", "marks-file", "caller-role"]),
  "add-fact": new Set(["session", "text", "caller-role"]),
  "deposit-grab": new Set(["session", "path", "text", "caller-role"]),
  "deposit-think": new Set(["session", "text", "role", "caller-role"]),
  "deposit-file": new Set(["session", "path", "caller-role"]),
  "deposit-manifest": new Set(["session", "manifest", "manifest-file", "caller-role"]),
  "deposit-run": new Set(["session", "path", "caller-role"]),
  "commit-round": new Set([
    "session",
    "quotes",
    "quotes-file",
    "audience",
    "audience-file",
    "caller-role",
  ]),
  "get-session": new Set(["session"]),
};

const parsed = parseStrictArgv(process.argv);
const command = parsed.command;

try {
  if (parsed.error) {
    emit(emptyBad(parsed.error));
  } else if (!command || !Object.hasOwn(allowedByCommand, command)) {
    emit(emptyBad("unknown_command"));
  } else {
    const allowed = allowedByCommand[command]!;
    for (const key of parsed.args.keys()) {
      if (!allowed.has(key)) {
        emit(emptyBad(`unknown_flag:${key}`));
        throw new Error("stop");
      }
    }
    const args = parsed.args;
    for (const [key, value] of args) {
      if (value === true) throw Object.assign(new Error("bad_request"), { detail: `missing_flag_value:${key}` });
      if (Buffer.byteLength(value, "utf8") > payloadLimit) {
        throw Object.assign(new Error("bad_request"), { detail: `payload_too_large:${key}` });
      }
    }
    for (const name of ["marks", "manifest", "quotes", "audience"]) {
      if (args.has(name) && args.has(`${name}-file`)) {
        throw Object.assign(new Error("bad_request"), { detail: `duplicate_payload:${name}` });
      }
    }
    const callerRoleRaw = optionalArg(args, "caller-role");
    const callerRoleParsed = roleSchema.safeParse(callerRoleRaw);
    if (callerRoleRaw !== undefined && !callerRoleParsed.success) {
      emit(emptyBad("bad_caller_role"));
    } else if (command === "create-session") {
      const modeRaw = optionalArg(args, "mode");
      const modeParsed = modeSchema.safeParse(modeRaw);
      if (modeRaw !== undefined && !modeParsed.success) {
        emit(emptyBad("bad_mode"));
      } else {
        emit(
          await createSession({
            userText: requireArg(args, "text"),
            material: optionalArg(args, "material"),
            mode: modeParsed.success ? modeParsed.data : undefined,
          }),
        );
      }
    } else if (command === "confirm-marks") {
      const marksRaw = await textArg(args, "marks", "marks-file");
      const parsedJson = parseJson(marksRaw, "marks_json_invalid");
      {
        const marks = marksFileSchema.safeParse(parsedJson);
        if (!marks.success) {
          emit(emptyBad("marks_schema_invalid"));
        } else {
          emit(
            await confirmMarks({
              sessionId: requireArg(args, "session"),
              marks: marks.data,
              callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
            }),
          );
        }
      }
    } else if (command === "add-fact") {
      emit(
        await addFact({
          sessionId: requireArg(args, "session"),
          text: requireArg(args, "text"),
          callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
        }),
      );
    } else if (command === "deposit-grab") {
      emit(
        await depositGrabFact({
          sessionId: requireArg(args, "session"),
          path: requireArg(args, "path"),
          text: requireArg(args, "text"),
          callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
        }),
      );
    } else if (command === "deposit-think") {
      emit(
        await depositThinkFact({
          sessionId: requireArg(args, "session"),
          text: requireArg(args, "text"),
          role: optionalArg(args, "role"),
          callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
        }),
      );
    } else if (command === "deposit-file") {
      emit(
        await depositFileFact({
          sessionId: requireArg(args, "session"),
          path: requireArg(args, "path"),
          callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
        }),
      );
    } else if (command === "deposit-manifest") {
      const raw = await textArg(args, "manifest", "manifest-file");
      const json = parseJson(raw, "manifest_json_invalid");
      {
        const manifest = productManifestSchema.safeParse(json);
        if (!manifest.success) {
          emit(emptyBad("manifest_schema_invalid"));
        } else {
          emit(
            await depositManifestFact({
              sessionId: requireArg(args, "session"),
              manifest: manifest.data,
              callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
            }),
          );
        }
      }
    } else if (command === "deposit-run") {
      emit(
        await depositRunFact({
          sessionId: requireArg(args, "session"),
          path: requireArg(args, "path"),
          callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
        }),
      );
    } else if (command === "commit-round") {
      const quotes = await textArg(args, "quotes", "quotes-file");
      const audience = await textArg(args, "audience", "audience-file");
      // Keep raw JSON, including null and parse errors: the common round parser
      // owns voidCount/retry for both transports.
      emit(await commitSessionRound({
        sessionId: requireArg(args, "session"),
        quotes,
        audience,
        callerRole: callerRoleParsed.success ? callerRoleParsed.data : undefined,
      }));
    } else if (command === "get-session") {
      emit(await getSession(requireArg(args, "session")));
    }
  }
} catch (error) {
  if (error instanceof Error && error.message === "stop") {
    // already emitted
  } else if (error instanceof Error && "detail" in error) {
    emit(emptyBad(String((error as { detail?: string }).detail ?? "bad_request")));
  } else {
    emit(emptyBad("bad_request"));
  }
}
