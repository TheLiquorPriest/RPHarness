// The folder host's prompt port (§4.8): the raw layout of the prompt given for a turn, computed
// from it, and the prompt maps kept in the folder, one per preset. The folder host joins no
// messages, so each message of a layout is one part.

import { join } from "node:path";
import type { Clock, PromptMap, PromptMessage, PromptPort, RawLayout, RawMessage, RawPart, Scope } from "../../contract/index";
import { readJson, textHash, writeJson, writeWhole } from "./disk";
import type { GivenPrompt, KeptMap } from "./shape";
import { givenPrompt, keptMap } from "./shape";
import type { Site } from "./site";

/** Where the prompt given for a turn is kept. */
export function promptPath(site: Site, chat: string, turn: string): string {
  return join(site.turnRecords(chat, turn), "prompt.json");
}

/** The prompt given for a turn; undefined when none was. */
export async function readGiven(site: Site, chat: string, turn: string): Promise<GivenPrompt | undefined> {
  const path = promptPath(site, chat, turn);
  const value = await readJson(path);
  return value === undefined ? undefined : givenPrompt(path, value);
}

/** A message's text: its content when that is a string, else its text parts joined with nothing between them. */
export function textOf(message: PromptMessage): string {
  return typeof message.content === "string" ? message.content : message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** The raw layout of a given prompt: the same prompt always gives the same layout. */
export function layoutOf(given: GivenPrompt, preset: RawLayout["preset"]): RawLayout {
  const blocks = given.blocks ?? [];
  const messages = given.messages.map((m): RawMessage => {
    const text = textOf(m);
    const hash = textHash(text);
    const found: RawPart["blocks"] = [];
    for (const [block, b] of blocks.entries()) {
      if (b.text === "") continue;
      for (let at = text.indexOf(b.text); at !== -1; at = text.indexOf(b.text, at + b.text.length)) found.push({ block, start: at, end: at + b.text.length });
    }
    const part: RawPart = { start: 0, end: text.length, role: m.role, hash, kind: m.kind ?? "other", ...(m.source !== undefined ? { source: m.source } : {}), blocks: found };
    const images = typeof m.content === "string" ? 0 : m.content.filter((p) => p.type === "image").length;
    return { role: m.role, length: text.length, hash, parts: [part], ...(images > 0 ? { images } : {}) };
  });
  return { messages, complete: true, blocks, blocksFrom: blocks.length === 0 ? null : (given.blocksFrom ?? "breakdown"), preset };
}

export function folderPrompt(site: Site, clock: Clock): PromptPort {
  const maps = join(site.host, "maps");
  // A preset's id goes into a file name encoded, and with ".json" after it, so no id can name another folder.
  const mapPath = (preset: string): string => join(maps, `${encodeURIComponent(preset)}.json`);

  function turnOf(scope: Scope): string {
    if (scope.turn === undefined) throw new Error("The folder host keeps a prompt by its turn, and this scope names none.");
    return scope.turn;
  }

  return {
    async layout(scope) {
      const chat = await site.chat(scope);
      const turn = turnOf(scope);
      const given = await readGiven(site, scope.chat, turn);
      if (given === undefined) throw new Error(`The folder host was given no prompt for turn ${JSON.stringify(turn)}: ${promptPath(site, scope.chat, turn)} is not there.`);
      return layoutOf(given, chat.preset);
    },

    async map(scope) {
      const chat = await site.chat(scope);
      if (chat.preset === null) return undefined;
      const path = mapPath(chat.preset.id);
      const value = await readJson(path);
      return value === undefined ? undefined : keptMap(path, value).map;
    },

    async saveMap(scope, map: PromptMap, by) {
      site.check(scope);
      const kept: KeptMap = { map, learnedBy: by, at: clock.now() };
      await writeJson(mapPath(map.preset.id), kept);
      // The chat's readable view of the map it now runs under (§5 l.422), generated, never edited by an agent.
      const lines = [`# Prompt map of ${map.preset.name ?? map.preset.id}`, "", ...map.slices.map((slice) => `- ${slice.marker} (${slice.kind}): ${slice.line}`), ""];
      await writeWhole(join(await site.chatFolder(scope), "PROMPT-MAP.md"), lines.join("\n"));
    },

    async saveLocated(scope, located) {
      site.check(scope);
      await writeJson(join(site.turnRecords(scope.chat, turnOf(scope)), "located.json"), located);
    },
  };
}
