// The folder host's chat (§6.8 `chat_read`, `chat_search`) over a file of messages:
// `host/chats/<chat>/messages.jsonl`, the active path, one message per line, oldest first. Hidden
// messages are marked, and their text is withheld unless the chat lets agents read them (§4.2).

import { join } from "node:path";
import type { ChatHit, ChatMessage, ChatPort, HistoryRange, Scope } from "../../contract/index";
import { readLines } from "./disk";
import type { ChatRecord, StoredMessage } from "./shape";
import { storedMessage } from "./shape";
import type { Site } from "./site";
import { match, SEARCH_LIMIT, snippetOf, termsOf } from "./words";

export function folderChat(site: Site): ChatPort {
  async function load(scope: Scope): Promise<{ chat: ChatRecord; messages: StoredMessage[] }> {
    const chat = await site.chat(scope);
    const path = join(site.chatRecords(scope.chat), "messages.jsonl");
    const messages = (await readLines(path)).map((line, i) => storedMessage(`${path} line ${i + 1}`, line));
    return { chat, messages };
  }

  /** A stretch cut to the chat. */
  function bounds(range: HistoryRange, length: number): [number, number] {
    const from = Math.min(Math.max(0, Math.floor(range.from)), length);
    return [from, Math.min(Math.max(from, Math.floor(range.to)), length)];
  }

  return {
    async info(scope) {
      const { chat, messages } = await load(scope);
      return { length: messages.length, hiddenReadable: chat.hiddenReadable, ranges: chat.ranges };
    },

    async read(scope, range) {
      const { chat, messages } = await load(scope);
      const [from, to] = bounds(range, messages.length);
      return messages.slice(from, to).map((m, i): ChatMessage => {
        const withheld = m.hidden && !chat.hiddenReadable;
        return {
          id: m.id,
          index: from + i,
          role: m.role,
          name: m.name,
          ...(withheld ? {} : { text: m.text }),
          ...(m.hidden ? { hidden: true as const } : {}),
          ...(m.summarized ? { summarized: true as const } : {}),
          ...(m.at !== undefined ? { at: m.at } : {}),
        };
      });
    },

    async search(scope, query) {
      const { chat, messages } = await load(scope);
      const terms = termsOf(query.text);
      if (terms.length === 0) return [];
      const [from, to] = query.within === undefined ? [0, messages.length] : bounds(query.within, messages.length);
      const found: { hit: ChatHit; score: number }[] = [];
      for (let index = from; index < to; index++) {
        const m = messages[index];
        if (m === undefined || (m.hidden && !chat.hiddenReadable)) continue;
        const { score, at, length } = match(m.text, terms);
        if (score === 0) continue;
        found.push({ score, hit: { id: m.id, index, role: m.role, name: m.name, snippet: snippetOf(m.text, at, length), how: "words" } });
      }
      return found
        .sort((a, b) => b.score - a.score || a.hit.index - b.hit.index)
        .slice(0, query.limit ?? SEARCH_LIMIT)
        .map((f) => f.hit);
    },
  };
}
