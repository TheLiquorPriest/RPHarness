// The file tools (§5.1, §6.8): `file_read`, `file_find` and `file_write`, over the host's file port.
// The port holds the one rule on writes (agents write only in the notes and this turn's own
// folders); these tools put its answers into the words of the tool answers' file, and say where the
// agent may write when a write is refused.
import type { FileHit, FileOp, FileQuery, FilesPort, Refused, Scope, Written } from "../contract";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, type ToolText, whole, type Words } from "./kit";

/** What the file tools are made with. */
export interface FileToolsDeps {
  files: FilesPort;
  words: Words;
  /** Each tool's file, by tool name. */
  texts: ReadonlyMap<string, ToolText>;
  /** The most hits one `file_find` asks for (the user's `tools.perCall`): a limit the agent names is held to it before the host is asked; with none, the host's own cap holds. Absent, as in a spike, nothing holds the agent's. */
  most?: number;
  /** A write went through: for the intent record of the two-step form, which the lead writes itself (§10.7). */
  written?(scope: Scope, by: { id: string; definition: string }, done: Written): Promise<void>;
}

function refusal(words: Words, refused: Refused) {
  return answer(words(`refused_${refused.reason}`, { path: refused.path, writable: refused.writable }), true);
}

export function fileRead(deps: FileToolsDeps): OwnTool {
  const own = deps.texts.get("file_read");
  return {
    name: "file_read",
    family: "files",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ path: { type: "string" }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } }, ["path"], own),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const path = text(given, "path") ?? "";
      const start = whole(given, "start");
      const end = whole(given, "end");
      const range = start === undefined && end === undefined ? undefined : { start: start ?? 1, ...(end !== undefined ? { end } : {}) };
      const read = await deps.files.read(ctx.scope, path, range);
      if (read.status === "refused") return refusal(deps.words, read);
      if (read.status === "missing") return answer(deps.words(read.folder === true ? "folder" : "missing", { path: read.path }), true);
      if (read.text !== "") return { content: [{ type: "text", text: read.text }] };
      // Nothing came back: the file is empty, or the lines asked for are past its end.
      return answer(read.lines === 0 ? deps.words("empty", { path: read.path }) : deps.words("past_end", { path: read.path, lines: read.lines }));
    },
  };
}

export function fileFind(deps: FileToolsDeps): OwnTool {
  const own = deps.texts.get("file_find");
  return {
    name: "file_find",
    family: "files",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf(
      {
        by: { type: "string", enum: ["list", "glob", "grep"] },
        path: { type: "string" },
        pattern: { type: "string" },
        literal: { type: "boolean" },
        ignore_case: { type: "boolean" },
        glob: { type: "string" },
        depth: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1 },
      },
      ["by"],
      own,
    ),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const by = text(given, "by");
      const path = text(given, "path");
      const pattern = text(given, "pattern");
      // A limit the agent names is held to the user's; however deep a listing goes, it stops there.
      const asked = whole(given, "limit");
      const limit = asked === undefined ? undefined : Math.min(asked, deps.most ?? asked);
      const where = { ...(path !== undefined ? { path } : {}), ...(limit !== undefined ? { limit } : {}) };
      if (by !== "list" && pattern === undefined) return answer(deps.words("needs", { op: by ?? "", fields: ["pattern"] }), true);
      const depth = whole(given, "depth");
      const glob = text(given, "glob");
      const query: FileQuery =
        by === "list"
          ? { by: "list", ...where, ...(depth !== undefined ? { depth } : {}) }
          : by === "glob"
            ? { by: "glob", pattern: pattern ?? "", ...where }
            : { by: "grep", pattern: pattern ?? "", ...where, ...(given["literal"] === true ? { literal: true } : {}), ...(given["ignore_case"] === true ? { ignoreCase: true } : {}), ...(glob !== undefined ? { glob } : {}) };
      let found: FileHit[] | Refused;
      try {
        found = await deps.files.find(ctx.scope, query);
      } catch (error) {
        // The port rejects a pattern that is not one; the model is told so in the file's words.
        if (error instanceof SyntaxError) return answer(deps.words("bad_pattern", { pattern: pattern ?? "" }), true);
        throw error;
      }
      if (!Array.isArray(found)) return refusal(deps.words, found);
      if (found.length === 0) return answer(deps.words("none_found"));
      const lines = found.flatMap((hit) => {
        const line = hit.line !== undefined ? deps.words("hit_line", { path: hit.path, line: hit.line, text: hit.text ?? "" }) : deps.words(hit.type === "folder" ? "hit_folder" : "hit_file", { path: hit.path });
        return line === undefined ? [] : [line];
      });
      return { content: lines.length === 0 ? [] : [{ type: "text", text: lines.join("\n") }] };
    },
  };
}

/** What each change is answered with when it went through. */
const DONE: Record<FileOp["op"], string> = { write: "wrote", append: "appended", edit: "edited", delete: "deleted" };
/** What each reason a change could not apply is answered with. */
const UNAPPLIED = { missing: "no_file", folder: "not_file", "no-match": "no_match", several: "several" } as const;

export function fileWrite(deps: FileToolsDeps): OwnTool {
  const own = deps.texts.get("file_write");
  return {
    name: "file_write",
    family: "files",
    tier: "write",
    description: own?.description ?? "",
    parameters: argumentsOf(
      {
        path: { type: "string" },
        op: { type: "string", enum: ["write", "append", "edit", "delete"] },
        text: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
        all: { type: "boolean" },
      },
      ["path", "op"],
      own,
    ),
    async run(args, ctx) {
      const given = fieldsOf(args);
      const path = text(given, "path") ?? "";
      const op = text(given, "op");
      const body = text(given, "text");
      const old = text(given, "old");
      const replacement = text(given, "new");
      let change: FileOp;
      if (op === "write" || op === "append") {
        if (body === undefined) return answer(deps.words("needs", { op, fields: ["text"] }), true);
        change = { op, text: body };
      } else if (op === "edit") {
        if (old === undefined || replacement === undefined) return answer(deps.words("needs", { op, fields: [...(old === undefined ? ["old"] : []), ...(replacement === undefined ? ["new"] : [])] }), true);
        change = { op, old, new: replacement, ...(given["all"] === true ? { all: true } : {}) };
      } else change = { op: "delete" };
      const done = await deps.files.write(ctx.scope, path, change, ctx.agent);
      if (done.status === "refused") return refusal(deps.words, done);
      if (done.status === "unapplied") return answer(deps.words(UNAPPLIED[done.reason], { path: done.path, ...(done.matches !== undefined ? { matches: done.matches } : {}) }), true);
      await deps.written?.(ctx.scope, ctx.agent, done);
      return answer(deps.words(DONE[done.op], { path: done.path, bytes: done.bytes }));
    },
  };
}
