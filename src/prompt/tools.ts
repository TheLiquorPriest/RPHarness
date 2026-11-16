// The prompt map's tools (§4.8 "Tools and names"): `prompt`, which gives the map or the text of any
// part of the prompt by name, and `prompt_map_write`, by which a mapper saves the map it learned.
// Each one's description and its arguments' are its file in `.tools/`, read by the harness with its
// other tools' files (`PROMPT_TOOLS`); every answer is a line of `.prompts/prompt-map.md`.
import type { AgentRef, Environment, JsonValue, SliceBehaviour, SliceKind, ToolCtx } from "../contract";
import type { Guidance } from "../files/api";
import { answer, argumentsOf, fieldsOf, type OwnTool, text, type ToolText } from "../tools/kit";
import { BEHAVIOURS, learn, type WrittenSlice } from "./learn";
import { findName, promptName, SLICE_KINDS } from "./names";
import { keepSceneMap, type SceneMap } from "./memory";
import type { TurnPrompt } from "./prompt";
import { laid, listing, noticeWords, promptWords } from "./words";

/** The names of these tools, whose files the harness reads with its other tools' (`.tools/<name>.md`). */
export const PROMPT_TOOLS = ["prompt", "prompt_map_write"] as const;

/** What the prompt map's tools are made with. */
export interface PromptToolsDeps {
  /** The prompt the calling agent's work serves: this turn's, or the turn's a job was started from. None: there is no prompt in view. */
  prompt(ctx: ToolCtx): Promise<TurnPrompt | undefined>;
  /** The guidance of the scope the tools serve: the lines of the prompt map's words. */
  guidance: Pick<Guidance, "part">;
  /** Each tool's file, by tool name. */
  texts: ReadonlyMap<string, ToolText>;
  env: Pick<Environment, "prompt">;
  /** The scene's copy of the map, which a saved map replaces from this turn on; absent: the host's map alone is kept. */
  sceneMap?: SceneMap;
}

export function promptTool(deps: PromptToolsDeps): OwnTool {
  const own = deps.texts.get("prompt");
  return {
    name: "prompt",
    family: "prompt",
    tier: "read",
    description: own?.description ?? "",
    parameters: argumentsOf({ names: { type: "array", items: { type: "string" } } }, [], own),
    async run(args, ctx) {
      const [prompt, words, notices] = await Promise.all([deps.prompt(ctx), promptWords(deps.guidance), noticeWords(deps.guidance)]);
      if (prompt === undefined) return answer(words("no_prompt"), true);
      const given = fieldsOf(args)["names"];
      const names = [...new Set(Array.isArray(given) ? given.filter((name): name is string => typeof name === "string" && name.trim() !== "") : [])];
      if (names.length === 0) return answer(listing(prompt, words, notices));
      const found = await Promise.all(names.map(async (name) => ({ name, items: await findName(prompt, name, ctx.agent) })));
      const texts = found.map(({ name, items }) => (items === undefined ? words("no_part", { name }) : laid(items, words)));
      const shown = texts.filter((text): text is string => text !== undefined && text !== "");
      return answer(shown.length === 0 ? undefined : shown.join("\n\n"), found.every(({ items }) => items === undefined));
    },
  };
}

/** The slices as the model sent them; what is not text is taken as none, for `learn` to say what is missing. */
function writtenOf(args: JsonValue): WrittenSlice[] {
  const given = fieldsOf(args)["slices"];
  return (Array.isArray(given) ? given : []).map((item) => {
    const fields = fieldsOf(item);
    const parts = fields["parts"];
    const starts = text(fields, "starts");
    return {
      marker: text(fields, "marker") ?? "",
      kind: (text(fields, "kind") ?? "") as SliceKind,
      line: text(fields, "line") ?? "",
      behaviour: (text(fields, "behaviour") ?? "") as SliceBehaviour,
      parts: Array.isArray(parts) ? parts.filter((part): part is string => typeof part === "string") : [],
      ...(starts !== undefined ? { starts } : {}),
    };
  });
}

/** `prompt_map_write`, made with how many characters of each slice's start its signature keeps (`prompt.signatureHead`). */
export function promptMapWrite(deps: PromptToolsDeps & { signatureHead: number }): OwnTool {
  const own = deps.texts.get("prompt_map_write");
  const slice = {
    type: "object",
    properties: {
      marker: { type: "string" },
      kind: { type: "string", enum: [...SLICE_KINDS] },
      line: { type: "string" },
      behaviour: { type: "string", enum: [...BEHAVIOURS] },
      parts: { type: "array", items: { type: "string" } },
      starts: { type: "string" },
    },
    required: ["marker", "kind", "line", "behaviour", "parts"],
  };
  return {
    name: "prompt_map_write",
    family: "prompt",
    tier: "write",
    description: own?.description ?? "",
    parameters: argumentsOf({ slices: { type: "array", items: slice } }, ["slices"], own),
    async run(args, ctx) {
      const [prompt, words, notices] = await Promise.all([deps.prompt(ctx), promptWords(deps.guidance), noticeWords(deps.guidance)]);
      if (prompt === undefined) return answer(words("no_prompt"), true);
      const learned = learn(prompt, writtenOf(args), deps.signatureHead);
      if ("problems" in learned) {
        const said = learned.problems.flatMap((problem) => words(problem.line, problem.fields) ?? []);
        return answer(said.length === 0 ? undefined : said.join("\n"), true);
      }
      if (ctx.scope.chat === undefined) return answer(notices("no_chat", { tool: "prompt_map_write" }), true);
      await deps.env.prompt.saveMap(ctx.scope, learned.map, ctx.agent);
      if (deps.sceneMap !== undefined) await keepSceneMap(deps.sceneMap, learned.map);
      prompt.remap(learned.map);
      const name = learned.map.preset.name ?? learned.map.preset.id;
      // What changed, then the map as it now stands, laid out as `prompt` lays it out (the player's kept slices and any text of no slice among it), so no read is needed after (§6.8).
      const said = [
        words("write_saved", { preset: name, count: learned.map.slices.length }),
        learned.kept.length > 0 ? words("write_kept", { markers: learned.kept }) : undefined,
        listing(prompt, words, notices),
      ].filter((line): line is string => line !== undefined && line !== "");
      return answer(said.length === 0 ? undefined : said.join("\n"));
    },
  };
}

/**
 * A part of the prompt by its name as `delegate` attaches it and a definition's `given:` names it
 * (`prompt:persona`, `prompt:kind(style)`): its text as `prompt` gives it, or undefined when the
 * prompt has nothing of that name, which the attachment then lists as not found. This is the
 * `slice` a team and its attachments are made with.
 */
export function promptSlice(prompt: () => Promise<TurnPrompt | undefined>, guidance: Pick<Guidance, "part">): (ref: string, reader: AgentRef) => Promise<string | undefined> {
  return async (ref, reader) => {
    const name = promptName(ref);
    if (name === undefined) return undefined;
    const [turn, words] = await Promise.all([prompt(), promptWords(guidance)]);
    const items = turn === undefined ? undefined : await findName(turn, name, reader);
    return items === undefined ? undefined : laid(items, words);
  };
}
