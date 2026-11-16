// The chat's history as the host keeps it (§6.8 `chat_read`, `chat_search`): any message or range
// of the active path, whether or not the history window kept it in the prompt (§4.2), and a search
// over the whole chat. Hidden and summarized messages are marked.

import type { Scope } from "./common";

/** Who a message is from, as the chat has it. */
export type ChatRole = "user" | "assistant" | "system";

/**
 * A stretch of the chat's active path, by position: from message `from` up to but not including
 * message `to`, both counted from 0 at the chat's first message.
 */
export interface HistoryRange {
  from: number;
  to: number;
  /**
   * For a stretch the window left out of the prompt (`TurnRequest.leftOut`): whether the host's
   * record of the story covers it (§4.2, §8.1). A host keeps each such stretch wholly covered or
   * wholly not. Absent where it keeps no such record.
   */
  covered?: boolean;
}

/** A message of the chat's active path, in the swipe it shows. */
export interface ChatMessage {
  /** The chat application's id for the message. */
  id: string;
  /** Its place on the active path, from 0. */
  index: number;
  role: ChatRole;
  /** Who speaks it: the character's, the persona's or the narrator's name. */
  name: string;
  /**
   * Its text. Absent for a hidden message while the chat's setting does not let agents read hidden
   * messages (§4.2 "Hidden messages"): the message is still listed, marked, so the gap is seen.
   */
  text?: string;
  /** The user hid it from the prompt (§4.2). */
  hidden?: true;
  /** The chat application's own memory stands in for it in prompts with a summary (§4.2: a summary is marked as a summary). */
  summarized?: true;
  /** When it was sent, in milliseconds since 1970, where the host knows. */
  at?: number;
  /**
   * The host's story choice (whose messages are the chat's story, R-176) leaves this message out of
   * the story; absent where it is the story's, or the host keeps no such choice.
   */
  story?: false;
}

/** The chat as a whole. */
export interface ChatInfo {
  /** How many messages the active path holds. */
  length: number;
  /** The chat's setting: agents may read hidden messages (§4.2, today's setting kept). */
  hiddenReadable: boolean;
  /**
   * Stretches the host names, so a definition or a brief can ask for one by name
   * (`chat:history[scene]`, §5.4): for RPE, `scene` is the stretch since the scene opened.
   */
  ranges: Record<string, HistoryRange>;
}

/** What to look for in the chat. */
export interface ChatQuery {
  /** The names and words to look for. */
  text: string;
  /** Only this stretch; the whole chat when absent. */
  within?: HistoryRange;
  /** At most this many hits; the host's own cap when absent. */
  limit?: number;
}

/** A message a chat search found. */
export interface ChatHit {
  id: string;
  index: number;
  role: ChatRole;
  name: string;
  /** The words around the match. */
  snippet: string;
  /** How it matched: by the words given, or by meaning where the host has that set up. */
  how: "words" | "meaning";
  /**
   * The host's story choice (whose messages are the chat's story, R-176) leaves this message out of
   * the story; absent where it is the story's, or the host keeps no such choice.
   */
  story?: false;
}

export interface ChatPort {
  /** The chat's length, its setting on hidden messages, and the stretches it names. */
  info(scope: Scope): Promise<ChatInfo>;
  /** The messages of a stretch, oldest first. A stretch past either end is cut to the chat. */
  read(scope: Scope, range: HistoryRange): Promise<ChatMessage[]>;
  /** A message's place on the active path, by its id, from 0; undefined when the active path has no message of that id. */
  position(scope: Scope, id: string): Promise<number | undefined>;
  /**
   * Searches the active path. Hidden messages are left out unless the chat's setting lets agents
   * read them (§4.2).
   */
  search(scope: Scope, query: ChatQuery): Promise<ChatHit[]>;
}
