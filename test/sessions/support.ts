// What the session tests that play whole turns share: the session they play in, a turn of the
// continuing mode, answers that write an intent record and a reply, and readers of what a request
// carried and of what the session file holds. Every text is invented.
import { expect } from "bun:test";
import type { Scope, TurnRequest } from "../../src/contract";
import { CHAT, PROMPT, type RecordedRequest, request, type Stage, textOf, USER } from "../harness/support";

export const S1: Scope = { user: USER, chat: CHAT, session: "s1" };
export const FILE = "sessions/s1/s1.jsonl";
const LAST_PROMPT = String(PROMPT.at(-1)!.content);
/** A rule at the moment before compaction (§11 `save-before-compaction`): the lead's call with its text. */
export const SAVE_RULE = ".rules/fixture-save.md";
export const SAVE_TEXT = "Fixture save rule: record what should last, then say you are done.";
export const SAVE = `---\ndescription: Fixture - the lead's call before a compaction.\nagents: [lead]\nat: before-compaction\nrepeat: always\n---\n${SAVE_TEXT}\n`;
/** A file a lead can read or release, in the chat's folder: `persistent-workspace/tide.md` as the agents name it. */
export const TIDE = "chats/wren-hale/lighthouse/persistent-workspace/tide.md";

export const said = (text: string) => ({ pieces: [{ text }] });
/** The lead's answer for turn `n`, in tags: an intent record and a reply. */
export const played = (n: number) => said(`<intent>Intent ${n}.</intent><reply>Reply ${n}.</reply>`);

export function turn(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return request(id, { lead: "lead", carry: "continuing", ...extra });
}

/** Plays the turns in order, each after the one before (the first after `first`), each released. */
export async function play(s: Stage, ids: readonly string[], first?: string): Promise<void> {
  let parent = first;
  for (const id of ids) {
    expect((await s.turn(turn(id, parent !== undefined ? { parent } : {}))).outcome.status).toBe("released");
    parent = id;
  }
}

/** What a turn's first request carried: the one message between the assembled prompt and the briefing (`end` messages from its end). */
export function carried(req: RecordedRequest, end = 1): string {
  const texts = req.messages.map((message) => textOf(message));
  const between = texts.slice(texts.lastIndexOf(LAST_PROMPT) + 1, -end);
  expect(between.length).toBe(1);
  return between[0]!;
}

/** What a summary call was sent: every message after its instructions. */
export function material(req: RecordedRequest): string {
  return req.messages
    .slice(1)
    .map((message) => textOf(message))
    .join("\n");
}

/** Whether every part is in the text, in the order given. */
export function inOrder(text: string, parts: readonly string[]): boolean {
  const at = parts.map((part) => text.indexOf(part));
  return at.every((place) => place >= 0) && at.every((place, i) => i === 0 || place > at[i - 1]!);
}

export interface Line {
  type: string;
  id: string;
  parent: string | null;
  turn?: string;
  summary?: string;
  kept?: string;
}

/** The session file's entries as they are on disk, in the order written: every line after the first. */
export async function entries(s: Stage): Promise<Line[]> {
  const read = await s.env.files.read(S1, FILE);
  if (read.status !== "read") throw new Error(`The session file is not there: ${read.status}`);
  return read.text
    .split("\n")
    .filter((line) => line !== "")
    .slice(1)
    .map((line) => JSON.parse(line) as Line);
}
