// What the kit asks a host to hold before it runs: a small invented chat with its files at every
// level, its messages (one hidden, one summarized), its lore, and the prompts it received for three
// turns (two the same, one with a changed message). A host's kit factory lays this in its own
// storage. Every name and text is invented.

import type { ActivatedLore, ChatRole, HistoryRange, LayerLevel, LoreEntry, PresetRef, PromptMessage, RawBlock, Scope } from "../../contract/index";

/** A file to lay at a level, by its path below the level's own folder. */
export interface KitFile {
  level: LayerLevel;
  path: string;
  text: string;
}

/** A message of the chat's active path. */
export interface KitMessage {
  id: string;
  role: ChatRole;
  name: string;
  text: string;
  hidden?: true;
  summarized?: true;
}

/** A message of a prompt the host received, flagged as the chat application's interceptor flagged it. */
export interface KitPromptMessage extends PromptMessage {
  kind: "history" | "lore" | "other";
  /** For history: the chat message, by id and place on the path. */
  source?: { id: string; index: number };
}

/** A prompt the host received for a turn: its messages, the chat application's breakdown into blocks, and the lore that activated. */
export interface KitPrompt {
  turn: string;
  messages: KitPromptMessage[];
  blocks: RawBlock[];
  activated: ActivatedLore[];
}

export interface KitSeed {
  /** The scope the host holds: its user, chat and session, and the turn the kit reads and writes in. */
  scope: Scope & { turn: string };
  /** The folder of the chat's character, where the host names its chats' levels by folder. */
  character: string;
  files: KitFile[];
  messages: KitMessage[];
  /** The chat's setting on hidden messages: agents may not read them. */
  hiddenReadable: false;
  /** The stretches the chat names. */
  ranges: Record<string, HistoryRange>;
  /** Every entry is part of the chat's lore. */
  lore: LoreEntry[];
  /** The preset the chat is on. */
  preset: PresetRef;
  /** The prompts received: for `scope.turn`, for a second turn with the same prompt, and for a third with one message changed. */
  prompts: [KitPrompt, KitPrompt, KitPrompt];
}

const MAIN_PROMPT = "You are the narrator of a quiet coastal story. Keep to what the characters can see.";
const CARD = "Wren Alder keeps the Saltglass Lighthouse above the harbor of Vell.";
const CARD_CHANGED = "Wren Alder keeps the Saltglass Lighthouse above the harbor of Vell, and keeps its secrets too.";
const LORE_IN_PROMPT = "[The Saltglass Lighthouse] A tower of green glass on the cliffs above Vell. Its lamp burns whale oil.";

function prompt(turn: string, card: string): KitPrompt {
  return {
    turn,
    messages: [
      { role: "system", content: MAIN_PROMPT, kind: "other" },
      { role: "system", content: card, kind: "other" },
      { role: "system", content: LORE_IN_PROMPT, kind: "lore" },
      { role: "user", content: "I climb the spiral stairs of the Saltglass Lighthouse.", name: "Tamsin", kind: "history", source: { id: "kit-m0", index: 0 } },
      { role: "assistant", content: "Wren lifts the lantern. The lamp room smells of brine and old oil.", name: "Wren", kind: "history", source: { id: "kit-m1", index: 1 } },
      { role: "user", content: "Then we row out at dawn.", name: "Tamsin", kind: "history", source: { id: "kit-m4", index: 4 } },
    ],
    blocks: [{ name: "Main Prompt", type: "instruction", role: "system", text: MAIN_PROMPT }],
    activated: [{ id: "kit-e-101", source: "Kit Coast Book", title: "The Saltglass Lighthouse", how: "keyword" }],
  };
}

/** The seed every host is checked against. */
export const KIT_SEED: KitSeed = {
  scope: { user: "kit-user", chat: "kit-chat", session: "kit-session", turn: "kit-turn-1" },
  character: "kit-wren",
  files: [
    { level: "shipped", path: "TURN.md", text: "The shipped turn guidance.\n" },
    { level: "shipped", path: ".agents/narrator.md", text: "---\nname: narrator\ndescription: Writes the prose.\n---\nThe shipped narrator.\n" },
    { level: "global", path: "ALL-AGENTS.md", text: "Every agent reads this first.\n" },
    { level: "global", path: "TURN.md", text: "The user's own turn guidance.\n" },
    { level: "global", path: ".rules/kit-quiet.md", text: "---\ndescription: Keeps the kit quiet.\nagents: all\n---\nSpeak softly.\n" },
    { level: "character", path: "AGENTS.md", text: "Wren speaks little and notices the weather.\n" },
    { level: "chat", path: "AGENTS.md", text: "This chat is played slowly.\n" },
    {
      level: "chat",
      path: "WORLD.md",
      text: "The coast of Vell, late autumn.\nThe harbor freezes at its edges.\nThe lighthouse burns whale oil.\nThe drowned bell lies under the harbor.\nNobody rows out after dark.\n",
    },
    { level: "chat", path: "persistent-workspace/story/threads.md", text: "The bell has not rung in forty years.\n" },
  ],
  messages: [
    { id: "kit-m0", role: "user", name: "Tamsin", text: "I climb the spiral stairs of the Saltglass Lighthouse." },
    { id: "kit-m1", role: "assistant", name: "Wren", text: "Wren lifts the lantern. The lamp room smells of brine and old oil." },
    { id: "kit-m2", role: "user", name: "Tamsin", text: "Is the quillfeather still nesting under the gallery?", hidden: true },
    { id: "kit-m3", role: "assistant", name: "Wren", text: "Forty years the bell has lain under the harbor.", summarized: true },
    { id: "kit-m4", role: "user", name: "Tamsin", text: "Then we row out at dawn." },
    { id: "kit-m5", role: "assistant", name: "Wren", text: "Wren laughs. The tide decides that, not you." },
  ],
  hiddenReadable: false,
  ranges: { scene: { from: 2, to: 6 } },
  lore: [
    { id: "kit-e-101", source: "Kit Coast Book", title: "The Saltglass Lighthouse", keys: ["lighthouse", "saltglass"], text: "A tower of green glass on the cliffs above Vell. Its lamp burns whale oil." },
    { id: "kit-e-102", source: "Kit Coast Book", title: "Harbor of Vell", keys: ["vell", "harbor"], text: "A fishing harbor whose oldest families still talk of the drowned bell." },
    {
      id: "kit-w-7",
      source: "Kit World",
      title: "The Drowned Bell",
      keys: ["bell"],
      text: "A bronze bell that sank with its ship forty years ago.",
      knowing: { by: "characters", names: ["Wren Alder"] },
    },
  ],
  preset: { id: "kit-preset", name: "Kit Coast Preset" },
  prompts: [prompt("kit-turn-1", CARD), prompt("kit-turn-2", CARD), prompt("kit-turn-3", CARD_CHANGED)],
};
