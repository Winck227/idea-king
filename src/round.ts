import { z } from "zod";
import {
  applyAudience,
  applyQuotes,
  artifactHashForDelivery,
  blankCells,
  eraseUnsupported,
  evaporate,
  filterQuotes,
  ideaKingTemplateMissing,
  judge,
  phaseAllowsCommit,
  resolveDeliveryStatus,
} from "./engine.ts";
import {
  audienceSchema,
  quotesPayloadSchema,
  type AudienceReport,
  type Session,
  type ToolError,
} from "./schema.ts";

const unclear: AudienceReport = {
  firstStop: "没有看清",
  skipped: "没有看清",
  remembered: "没有看清",
  provenance: "unknown",
  artifactHash: null,
  receipt: null,
};

export type RoundResult = { session: Session; error?: ToolError };

function parseLoose<T>(raw: unknown, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false } {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false };
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { ok: false };
  return { ok: true, data: parsed.data };
}

function asDiscarded(raw: unknown): string {
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

function trimAudience(report: {
  firstStop: string;
  skipped: string;
  remembered: string;
  provenance?: AudienceReport["provenance"];
  artifactHash?: string | null;
  receipt?: string | null;
}): AudienceReport {
  return {
    firstStop: report.firstStop.trim(),
    skipped: report.skipped.trim(),
    remembered: report.remembered.trim(),
    provenance: report.provenance ?? "unknown",
    artifactHash: report.artifactHash ?? null,
    receipt: report.receipt?.trim() ? report.receipt.trim() : null,
  };
}

export function commitRound(
  session: Session,
  quotesRaw: unknown,
  audienceRaw: unknown,
  root?: string,
): RoundResult {
  if (session.stopped) return { session, error: "stopped" };
  if (session.marks.length === 0) return { session, error: "marks_not_frozen" };
  const optionCount = session.marks.filter((mark) => mark.kind === "option").length;
  if (optionCount < 2) return { session, error: "need_two_options" };
  if (session.mode === "ideaKing") {
    if (optionCount !== 2) return { session, error: "need_two_options" };
    if (ideaKingTemplateMissing(session.marks, "ideaKing").length > 0) {
      return { session, error: "bad_request" };
    }
    if (!phaseAllowsCommit(session)) return { session, error: "bad_request" };
  } else if (ideaKingTemplateMissing(session.marks, session.mode ?? "lattice").length > 0) {
    return { session, error: "bad_request" };
  }

  const blank = blankCells(session.marks);
  const quotesParsed = parseLoose(quotesRaw, quotesPayloadSchema);
  const audienceParsed = parseLoose(audienceRaw, audienceSchema);

  if (!quotesParsed.ok || !audienceParsed.ok) {
    const planMax = session.crewPlan?.maxVoid ?? 2;
    const voidCount = session.voidCount + 1;
    const stopped = voidCount >= planMax;
    let audience = audienceParsed.ok ? trimAudience(audienceParsed.data) : session.audience;
    if (!audience && stopped) audience = unclear;
    return {
      session: {
        ...session,
        cells: blank,
        lastRoundCells: blank,
        verdict: null,
        deliveryStatus: "incomplete",
        discardedText: asDiscarded(quotesRaw),
        audience,
        voidCount,
        stopped,
      },
    };
  }

  const { kept, dropped } = filterQuotes(
    quotesParsed.data.quotes,
    session.material,
    session.marks,
    session.evidence,
    session,
    root,
  );
  const quoted = applyQuotes(session.marks, kept);
  const erased = eraseUnsupported(quoted, session.material);
  let audience = trimAudience(audienceParsed.data);
  // Bind artifact version when omitted.
  if (!audience.artifactHash) {
    audience = { ...audience, artifactHash: artifactHashForDelivery(session) };
  }
  const watched = applyAudience(erased, audience, session.marks);
  const verdict = judge(
    watched.filter((cell) => cell.scent === 1),
    session.marks,
  );
  const next: Session = {
    ...session,
    cells: evaporate(watched, verdict),
    lastRoundCells: watched,
    audience,
    verdict,
    discardedText: dropped.length > 0 ? dropped.join("\n") : null,
    voidCount: 0,
    stopped: false,
    deliveryStatus: "incomplete",
  };
  next.deliveryStatus = resolveDeliveryStatus(next);
  return { session: next };
}
