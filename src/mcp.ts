import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { callerRoleSchema, draftMarkSchema, productManifestSchema, sessionModeSchema } from "./schema.ts";
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
} from "./tools.ts";

const server = new McpServer({ name: "pheromone-review", version: "0.1.0" });

function text(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

const callerRole = callerRoleSchema.optional();
const boundedText = z.string().max(256 * 1024);
const sessionId = z.string().min(1).max(128);

server.registerTool(
  "create_session",
  {
    description:
      "保存原话和已有材料。默认 mode=ideaKing（强制两选项四硬条件与阶段门）；A1–A5/自由评议传 mode=lattice。创建时冻结 crewPlan。不抽取标记，不下结论。",
    inputSchema: {
      userText: boundedText,
      material: boundedText.optional(),
      mode: sessionModeSchema.optional(),
    },
  },
  async ({ userText, material, mode }) =>
    text(await createSession({ userText, material, mode })),
);

server.registerTool(
  "confirm_marks",
  {
    description:
      "冻结选项和硬条件。ideaKing 要求材料非空且含选项/交接相关事实，恰好两选项（literal/spark）与四条件 code。缩小点破时同 role 替换旧选项，不累积第三选项。可选 callerRole。",
    inputSchema: {
      sessionId,
      marks: z.array(draftMarkSchema).max(64),
      callerRole,
    },
  },
  async ({ sessionId, marks, callerRole: role }) =>
    text(await confirmMarks({ sessionId, marks, callerRole: role })),
);

server.registerTool(
  "add_fact",
  {
    description:
      "追加一条已经发生的事实，清空旧结论；不重置 stopped/voidCount（除非后续有效缩小修订）。一次一条。",
    inputSchema: {
      sessionId,
      text: boundedText,
      callerRole,
    },
  },
  async ({ sessionId, text: fact, callerRole: role }) =>
    text(await addFact({ sessionId, text: fact, callerRole: role })),
);

server.registerTool(
  "deposit_grab",
  {
    description:
      "从成品目录以外的仓库文件里照抄一段连续原文。按 realpath/inode 去重；变更会使旧 run/accept 作废。",
    inputSchema: {
      sessionId,
      path: z.string().min(1).max(4096),
      text: boundedText,
      callerRole,
    },
  },
  async ({ sessionId, path, text: excerpt, callerRole: role }) =>
    text(await depositGrabFact({ sessionId, path, text: excerpt, callerRole: role })),
);

server.registerTool(
  "deposit_think",
  {
    description:
      "把一段思考写入 artifacts/<sessionId>/think/<id>.md（只读落盘）。ideaKing 制作前通常需要 thinkCount >= max(0, crewSize-3)。",
    inputSchema: {
      sessionId,
      text: boundedText,
      role: z.string().max(128).optional(),
      callerRole,
    },
  },
  async ({ sessionId, text: think, role, callerRole: caller }) =>
    text(await depositThinkFact({ sessionId, text: think, role, callerRole: caller })),
);

server.registerTool(
  "deposit_file",
  {
    description:
      "登记会话 artifacts 下成品：全量快照+contentHash+materialHash/依赖哈希。前置 grabsReady；ideaKing 还要模板与思考人数。",
    inputSchema: {
      sessionId,
      path: z.string().min(1).max(4096),
      callerRole,
    },
  },
  async ({ sessionId, path, callerRole: role }) =>
    text(await depositFileFact({ sessionId, path, callerRole: role })),
);

server.registerTool(
  "deposit_manifest",
  {
    description:
      "登记成品验收清单（type=page|cli，entry 须在 out/ 下）。deposit_run 后自动跑 acceptor；试用格只认 accept 或 acceptOk 的 run。",
    inputSchema: {
      sessionId,
      manifest: productManifestSchema,
      callerRole,
    },
  },
  async ({ sessionId, manifest, callerRole: role }) =>
    text(
      await depositManifestFact({
        sessionId,
        manifest,
        callerRole: role,
      }),
    ),
);

server.registerTool(
  "deposit_run",
  {
    description:
      "对已登记快照跑 node：最小 env、--max-old-space-size=64、只读会话树、只写 out/、无 --allow-net。随后跑 accept。OS 级禁网无法保证时见文档边界。",
    inputSchema: {
      sessionId,
      path: z.string().min(1).max(4096),
      callerRole,
    },
  },
  async ({ sessionId, path, callerRole: role }) =>
    text(await depositRunFact({ sessionId, path, callerRole: role })),
);

server.registerTool(
  "commit_round",
  {
    description:
      "提交 quotes+audience（含 provenance=real|sim|unknown 与 artifactHash）。返回 sentence、boardPath、deliveryStatus、revision。记忆失败或 unknown 观众不得 delivered。",
    inputSchema: {
      sessionId,
      quotes: boundedText,
      audience: boundedText,
      callerRole,
    },
  },
  async ({ sessionId, quotes, audience, callerRole: role }) =>
    text(await commitSessionRound({ sessionId, quotes, audience, callerRole: role })),
);

server.registerTool(
  "get_session",
  {
    description: "读回格子、丢弃区、sentence、boardPath、deliveryStatus、revision。不重新下结论。",
    inputSchema: { sessionId },
  },
  async ({ sessionId }) => text(await getSession(sessionId)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
