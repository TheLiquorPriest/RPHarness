// The assembled prompt and the prompt map (§4.8). The host gives the raw facts of each prompt it
// received, without judging them (the raw layout), and keeps the prompt map of each preset. RPH
// finds the slices in each turn's prompt, inside `answer()`, and gives back where it found them and
// what changed.

import type { AgentRef, Scope } from "./common";

/**
 * A message's role in a prompt: the three every model's API places, and `tool`, a tool's answer the
 * chat application sent with the call it answers made earlier in its own conversation. No model's
 * API places that one without its call, so it goes to the model in its own place as a marked note
 * (`.prompts/role-note.md`), never given another role.
 */
export type PromptRole = "system" | "user" | "assistant" | "tool";

/** A piece of a message: text, or a picture the request carried, by its data (base64, with its type) or by its web address. */
export type PromptPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "image"; url: string };

/**
 * One message of the assembled prompt, as the chat application sent it (§10.2: every message, in
 * order, with its role). Its text is `content` when that is a string, else its text parts joined
 * with nothing between them.
 */
export interface PromptMessage {
  role: PromptRole;
  content: string | PromptPart[];
  /** The speaker's name, where the chat application gave one. */
  name?: string;
}

/**
 * A text's hash in the layout: the first 32 hex digits (lower case) of the SHA-256 of its UTF-8.
 * RPH computes the same over a slice's text to find it again.
 */
export type TextHash = string;

/** The preset a prompt was assembled from, and its revision (a new revision is noticed, §4.8). */
export interface PresetRef {
  id: string;
  name?: string;
  revision?: string;
}

/**
 * One message as the chat application's interceptor saw it, before neighbours were joined (§4.2):
 * a part of a message of the prompt. Offsets are UTF-16 code units into the message's text; a gap
 * between two parts is a separator the chat application added when it joined them.
 */
export interface RawPart {
  start: number;
  end: number;
  /** The part's own role, which a joined message may have lost. */
  role: PromptRole;
  hash: TextHash;
  /** Chat history, standalone lore (the interceptor's flags), anything else, or `unknown`: no message the interceptor saw accounts for it. */
  kind: "history" | "lore" | "other" | "unknown";
  /** For history: the chat message, by id and place on the path. Lore carries no entry id: the activated entries come through `LorePort.activated`. */
  source?: { id: string; index: number };
  /** For history: the chat application put a summary of messages here in their place (§4.2: a summary is marked as a summary). */
  summarized?: true;
  /** Where each block's text (`RawLayout.blocks[block]`) was found inside this part, as offsets into the message. */
  blocks: { block: number; start: number; end: number }[];
}

/** One message of the prompt the model receives, in order, after the history window's cut (§4.2). */
export interface RawMessage {
  role: PromptRole;
  /** Its text's length, in UTF-16 code units. */
  length: number;
  hash: TextHash;
  /** Its parts, in order; one for a message nothing was joined into. */
  parts: RawPart[];
  /** How many pictures it carries, where it carries any. `length` and `hash` are of the text alone. */
  images?: number;
  /** The thinking the chat application sent back with it (an earlier reply's, Lumiverse's `reasoning_content`), read apart: no part of `length`, `hash` or the parts; absent where none. */
  thinking?: { length: number; hash: TextHash };
}

/** A block of the preset as the chat application's own breakdown has it (§4.8): its name, type and resolved text, and the kind its own block says. */
export interface RawBlock {
  name: string;
  type: string;
  role?: PromptRole;
  text: string;
  id?: string;
  /**
   * The kind the chat application's own block says it is, where it says one: for Lumiverse, the
   * persona's slot is `persona`, the card's slots are `character`, and a block of the preset's own
   * text is `instructions`. Until a map is learned the block's slice takes this kind; absent, `other`.
   */
  kind?: SliceKind;
}

/**
 * The raw facts of one prompt (§4.8 step 1): every message with its role, length and hash; which
 * parts are chat history and which are lore; and, where the chat application has it, its own
 * breakdown into blocks, as a hint.
 */
export interface RawLayout {
  messages: RawMessage[];
  /** False: some text could not be told apart (a joining mode the host cannot undo); slices cannot be found in it. */
  complete: boolean;
  /** The chat application's breakdown, in its order; none when it has none. */
  blocks: RawBlock[];
  /** Where `blocks` came from: the breakdown stored after the chat's last generation, or a dry run; null with no blocks. */
  blocksFrom: "breakdown" | "dry-run" | null;
  /** The preset the prompt was assembled from; null where the host cannot tell. */
  preset: PresetRef | null;
}

/** A slice's kind, from the fixed list (§4.8 "Kinds"). A definition can ask for slices by kind (`prompt:kind(style)`). */
export type SliceKind = "instructions" | "style" | "character" | "persona" | "world" | "note" | "lore" | "history" | "other";

/** How a slice behaves from turn to turn (§4.8 step 2): its text is fixed, changes with the scene, or changes every turn. */
export type SliceBehaviour = "fixed" | "scene" | "turn";

/**
 * How a slice is found again in a new prompt (§4.8 "What makes a marker evergreen"): by a signature
 * of its text where the text is fixed, and by its place between its neighbours where it is not. The
 * host keeps these as RPH wrote them; their meaning is RPH's.
 */
export interface SliceFinder {
  /** A signature of the slice's fixed text, as RPH computes it. */
  signature?: string;
  /** The marker of the slice before it, and after it. */
  after?: string;
  before?: string;
  /** The chat application's block name, where its breakdown named the slice. */
  block?: string;
  role?: PromptRole;
}

/** One named part of the prompt (§4.8 "Words"). */
export interface PromptSlice {
  /** Its name, the same from turn to turn (`persona`, `preset.style`). */
  marker: string;
  kind: SliceKind;
  /** One line on what it is. */
  line: string;
  behaviour: SliceBehaviour;
  find: SliceFinder;
  /** The user changed this slice on the Prompt page; a new mapping keeps the change (§4.8 step 3). */
  edited?: true;
}

/** The prompt map of one preset: its slices, learned once by an agent and kept with the preset (§4.8 step 3). */
export interface PromptMap {
  /** The shape this map is written in; 1 today. */
  format: 1;
  preset: PresetRef;
  slices: PromptSlice[];
}

/** Where a slice was found in this turn's prompt: spans of message text, as offsets in UTF-16 code units. */
export interface LocatedSlice {
  marker: string;
  kind: SliceKind;
  at: { message: number; start: number; end: number }[];
  /** Its length in this prompt. */
  length: number;
  hash: TextHash;
  /**
   * How a slice of the learned map was found (§4.8 "What makes a marker evergreen"): by its
   * signature, by the chat application's block name, or by its place between the slices around it.
   * Absent for history, lore and the pieces of a prompt not mapped yet.
   */
  found?: "signature" | "block" | "place";
  /** What the chat application's breakdown says of the text found: the name of its block there; absent where it names none. */
  hint?: string;
  /** The map's finder named another block, or none, where the breakdown's block now is: it was corrected to `hint`, and the map saved. */
  corrected?: true;
}

/**
 * What changed in the prompt's shape since the turn before (§4.8 "What code does every turn"):
 * a fixed slice whose text changed; a slice that is gone; text that belongs to no slice; slices in
 * another order; a different preset or a new revision. And two more facts the briefing names: the
 * prompt has not been mapped yet, and its text could not be told apart (`RawLayout.complete`).
 * Facts only; RPH says them in the words of a file.
 */
export type PromptNotice =
  | { kind: "changed"; marker: string }
  | { kind: "gone"; marker: string }
  | { kind: "unclaimed"; message: number; start: number; end: number }
  | { kind: "order"; markers: string[] }
  | { kind: "preset"; was: PresetRef | null; now: PresetRef | null }
  | { kind: "unmapped" }
  | { kind: "incomplete" };

/** Where RPH found each slice in this turn's prompt, and the notices (§4.8). */
export interface LocatedSlices {
  preset: PresetRef | null;
  slices: LocatedSlice[];
  /** Text that belongs to no slice. */
  unclaimed: { message: number; start: number; end: number }[];
  notices: PromptNotice[];
  /**
   * How much of the prompt's front was the same as the turn before, and the marker of the slice that
   * broke it (§4.8 "The foundation for caching"); `brokenBy` absent when the whole prompt held.
   */
  front: { length: number; brokenBy?: string };
}

export interface PromptPort {
  /** The raw layout of the prompt the host received for `scope.turn`. The same prompt gives the same layout. */
  layout(scope: Scope): Promise<RawLayout>;
  /** The prompt map learned for the preset this chat is on; undefined until one has been learned. */
  map(scope: Scope): Promise<PromptMap | undefined>;
  /** Keeps the map for its preset, for every chat on that preset (§4.8 step 3). `by`: the agent that learned it. */
  saveMap(scope: Scope, map: PromptMap, by: AgentRef): Promise<void>;
  /** Keeps where RPH found each slice in this turn's prompt, and the notices, for the Turn and Prompt pages. */
  saveLocated(scope: Scope, located: LocatedSlices): Promise<void>;
}

// ---------------------------------------------------------------- the prompt map, as the Prompt page shows and edits it

/** One of the owner's edits to the prompt map on the Prompt page (§4.8 L369; C-9). `split`: `at` is the words the second part begins with. */
export type PromptMapEdit =
  | { edit: "rename"; marker: string; to: string }
  | { edit: "merge"; markers: string[]; as: string }
  | { edit: "split"; marker: string; at: string; second: string }
  | { edit: "line"; marker: string; line: string }
  | { edit: "kind"; marker: string; to: SliceKind };

/**
 * A slice as the Prompt page shows it: as the map has it, its text in the turn's prompt, where it is,
 * and, for a slice of the learned map, how it was found and what the breakdown said there
 * (`breakdown`: its block there agrees with the map's finder, or the finder was corrected to it).
 */
export interface ShownSlice {
  marker: string;
  kind: SliceKind;
  line?: string;
  behaviour?: SliceBehaviour;
  /** The owner changed it on the Prompt page; a new mapping keeps it. */
  edited?: true;
  text: string;
  length: number;
  at: { message: number; start: number; end: number }[];
  found?: "signature" | "block" | "place";
  breakdown?: "confirmed" | "corrected";
  hint?: string;
}

/** The prompt map as found in a turn's prompt (`PromptMapApi.show`): its slices, the text of no slice, and the turn's notices and front as its located record has them. */
export interface PromptMapShown {
  turn: string;
  preset: PresetRef | null;
  /** The slices are the learned map's: there is one, and the layout told the prompt's text apart. */
  mapped: boolean;
  slices: ShownSlice[];
  unclaimed: { message: number; start: number; end: number; text: string }[];
  notices: PromptNotice[];
  front: LocatedSlices["front"];
}

/** An edit made and the map saved for every chat on the preset; or why it was not made, in the words of `.prompts/prompt-map.md`. */
export type PromptMapEdited = { status: "saved"; map: PromptMap } | { status: "refused"; words: string };

/**
 * The prompt map as the Prompt page shows and edits it (C-9). RPH makes each edit and keeps it with
 * the preset, every slice it changes marked `edited`, so a later learn keeps it (§4.8 step 3).
 */
export interface PromptMapApi {
  /** The map as found in the prompt of `scope.turn` (absent: the chat's newest turn RPH keeps), while the host keeps that turn's folder; undefined where none is kept. */
  show(scope: Scope): Promise<PromptMapShown | undefined>;
  /** Makes one edit on the map as found in that turn's prompt, writes each changed slice's finder from its text, and saves the map through `PromptPort.saveMap` under `by`. */
  edit(scope: Scope, edit: PromptMapEdit, by: AgentRef): Promise<PromptMapEdited>;
}
