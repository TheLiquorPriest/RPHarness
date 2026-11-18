// What a sub-agent is given by name (§10.5 `delegate`, §5.4 `given:`), found and handed over in
// full. RPH finds its own kinds itself:
//   file:<path>                 a file, from the chat's folder, or failing that from this turn's;
//                               a folder by what is in it, each file by its path and size
//   chat:history[scene]         a stretch of the chat the host names
//   chat:history[-30:]          the last thirty messages
//   chat:history[#120..#179]    messages 120 to 179, both included, counted from 0
//   lore:<id>                   a lore entry, as the agent may read it, marked with who may know it
//   prompt:<name>               a slice of the prompt, through the prompt map
// Every other name is a view the host offers: the host gives its text. A `lore:` name the lore does
// not give the agent stays RPH's own, with no text: the lore leaves out what a character may not
// know as if there were no such entry (§9.4), so no other place is asked for it. The whole list goes
// to the host, which keeps it with the turn (§10.5: "the list is saved with the turn"). A name nobody
// could give is handed back, for the delegate call's result.
// A stretch of the chat is given whole, however long: read page by page of the user's
// `tools.perCall` messages, in order, nothing cut (§10.5: "each in full").
// Messages and entries are laid out by lines of a file; nothing here adds a word.
import type { AgentRef, AttachMoment, AttachmentRef, ChatMessage, ContextBlock, Environment, FilesPort, HistoryRange, RunScope, Scope } from "../contract";
import type { LinesPart } from "../files/api";

/** A name an agent is given, and where it was named: its definition's `given:`, or the call that started it. */
export interface Wanted {
  ref: string;
  from: AttachmentRef["from"];
}

/** What was found, in the order it was named, each under its name as written; and the names nobody could give. */
export interface Given {
  blocks: ContextBlock[];
  missing: string[];
}

export interface AttachDeps {
  env: Pick<Environment, "files" | "chat" | "lore" | "events" | "log">;
  /** Where the agent works: a chat's scope, or a job's of no chat (C-23), where a stretch of the chat or a lore entry is not found. */
  scope: RunScope;
  /** The lines a chat message (`chat_message`) and a lore entry's head (`lore_entry`) are laid out by. */
  lines: LinesPart | undefined;
  /** A slice of the prompt by its name as written (`prompt:persona`), from the prompt map; none: such a name is not found. */
  slice?(ref: string, reader: AgentRef): Promise<string | undefined>;
  /** How many messages one read of the chat asks for (the user's `tools.perCall`): a stretch is read in pages of so many, all of them. */
  most: number;
  /** The moment the items are for (C-T13, R-144): the task the brief gave the agent, and on a continuation the message that continues it; told to the host with the list. */
  moment: AttachMoment;
}

/** A stretch of the chat as a name gives it. */
type Stretch = { named: string } | { last: number } | { from: number; to: number };

/** What RPH makes of a name. */
type Kind = { kind: "file"; path: string } | { kind: "chat"; stretch: Stretch } | { kind: "lore"; id: string } | { kind: "prompt" } | { kind: "host" };

/** RPH's own answer for a name: its text, or none (not found); or the host is asked. */
type Own = { own: true; text: string | undefined } | { own: false };

const HISTORY = /^chat:history\[(.+)\]$/;
const LAST = /^-(\d+):$/;
const BETWEEN = /^#(\d+)\.\.#(\d+)$/;
const NAMED = /^[\w-]+$/;

function kindOf(ref: string): Kind {
  if (ref.startsWith("file:") && ref.length > "file:".length) return { kind: "file", path: ref.slice("file:".length) };
  if (ref.startsWith("lore:") && ref.length > "lore:".length) return { kind: "lore", id: ref.slice("lore:".length) };
  if (ref.startsWith("prompt:")) return { kind: "prompt" };
  const inner = HISTORY.exec(ref)?.[1]?.trim();
  if (inner !== undefined) {
    const last = LAST.exec(inner);
    if (last?.[1] !== undefined) return { kind: "chat", stretch: { last: Number(last[1]) } };
    const between = BETWEEN.exec(inner);
    if (between?.[1] !== undefined && between[2] !== undefined) return { kind: "chat", stretch: { from: Number(between[1]), to: Number(between[2]) } };
    if (NAMED.test(inner)) return { kind: "chat", stretch: { named: inner } };
  }
  return { kind: "host" };
}

/** Texts one after another: each without the line break it ends on, the empty ones left out, a blank line between. */
export function joined(texts: readonly string[]): string {
  return texts
    .map((text) => text.trimEnd())
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/**
 * A name as a job an agent starts keeps it (`job_start`): a `file:` found only in the folder of the
 * turn the agent works in (`file:scratch/scene.md`), by its whole path from the chat's folder, which
 * reads the same from the job's own session, where "this turn's folder" is the job's; every other
 * name as it was written.
 */
export async function startedRef(files: Pick<FilesPort, "read" | "places">, scope: RunScope, ref: string): Promise<string> {
  const kind = kindOf(ref);
  if (kind.kind !== "file") return ref;
  const turn = (await files.places(scope)).turn;
  for (const path of [kind.path, ...(turn === undefined || kind.path.startsWith(turn) ? [] : [`${turn}${kind.path}`])]) {
    const read = await files.read(scope, path, { start: 1, end: 1 }).catch(() => undefined);
    if (read?.status === "read" || (read?.status === "missing" && read.folder === true)) return `file:${path}`;
  }
  return ref;
}

/** Finds and lays out what the agent `reader` is given, and gives the host the whole list to keep. */
export async function attach(deps: AttachDeps, reader: AgentRef, wanted: readonly Wanted[]): Promise<Given> {
  const { env, scope, lines } = deps;
  const seen = new Set<string>();
  const list = wanted.filter((item) => {
    if (seen.has(item.ref)) return false;
    seen.add(item.ref);
    return true;
  });
  let turnFolder: Promise<string | undefined> | undefined;

  /** A folder named as a file: what is in it, every file at any depth by its path and size, as many as the user's `tools.perCall`. */
  const folderText = async (path: string): Promise<string | undefined> => {
    const found = await env.files.find(scope, { by: "glob", pattern: "**", path, limit: deps.most });
    if (found.status !== "found") return undefined;
    const head = lines?.line("folder", { path, ...(found.hits.length === 0 ? { empty: true } : {}) });
    const files = found.hits.map((hit) => lines?.line("folder_file", { path: hit.path, ...(hit.bytes !== undefined ? { bytes: hit.bytes } : {}) }));
    const more = found.stopped?.limit === undefined ? undefined : lines?.line("folder_more", { max: found.stopped.limit.max });
    return [head, ...files, more].filter((line): line is string => line !== undefined && line !== "").join("\n");
  };

  /** A file's text, a folder's listing, or `null` where nothing is at `path`. */
  const at = async (path: string): Promise<string | undefined | null> => {
    const read = await env.files.read(scope, path);
    if (read.status === "read") return read.text;
    if (read.status !== "missing") return undefined;
    return read.folder === true ? await folderText(read.path) : null;
  };

  const fileText = async (path: string): Promise<string | undefined> => {
    const found = await at(path);
    if (found !== null) return found;
    // A definition cannot know the turn's folder, so it names a file of the turn from there (`file:scratch/scene.md`).
    turnFolder ??= env.files.places(scope).then((places) => places.turn);
    const turn = await turnFolder;
    if (turn === undefined || path.startsWith(turn)) return undefined;
    return (await at(`${turn}${path}`)) ?? undefined;
  };

  const chatText = async (scope: Scope, stretch: Stretch): Promise<string | undefined> => {
    let range: HistoryRange | undefined;
    if ("named" in stretch) {
      const { ranges } = await env.chat.info(scope);
      range = Object.hasOwn(ranges, stretch.named) ? ranges[stretch.named] : undefined;
    } else if ("last" in stretch) {
      const { length } = await env.chat.info(scope);
      range = { from: Math.max(0, length - stretch.last), to: length };
    } else range = { from: stretch.from, to: stretch.to + 1 };
    if (range === undefined || range.to <= range.from) return undefined;
    const messages: ChatMessage[] = [];
    for (let from = range.from; from < range.to; ) {
      const to = Math.min(range.to, from + Math.max(1, deps.most));
      const page = await env.chat.read(scope, { from, to });
      messages.push(...page);
      // A page short of what was asked is the chat's end.
      if (page.length < to - from) break;
      from = to;
    }
    if (messages.length === 0) return undefined;
    // Each message as the `chat_message` line lays it out; nothing when the file has no such line.
    const laid = messages.map(
      (message) =>
        lines?.line("chat_message", {
          index: message.index,
          id: message.id,
          role: message.role,
          name: message.name,
          ...(message.text !== undefined ? { text: message.text } : {}),
          ...(message.hidden === true ? { hidden: true } : {}),
          ...(message.summarized === true ? { summarized: true } : {}),
          ...(message.story === false ? { outside_story: true } : {}),
        }) ?? "",
    );
    return joined(laid);
  };

  const loreText = async (scope: Scope, id: string): Promise<string | undefined> => {
    const [entry] = await env.lore.read(scope, [id], reader);
    if (entry === undefined) return undefined;
    const head = lines?.line("lore_entry", { id: entry.id, title: entry.title, source: entry.source, keys: entry.keys }) ?? "";
    // Who may know it, as `lore_read` marks it (§9.4: every entry "marked with who may know it").
    const { knowing } = entry;
    const known = knowing?.by === "characters" ? lines?.line("lore_known_by", { names: knowing.names }) : knowing?.by === "gate" ? lines?.line("lore_gate", { gate: knowing.gate, ...(knowing.open ? { open: true } : {}) }) : undefined;
    return joined([head, known ?? "", entry.text]);
  };

  const own = async (ref: string): Promise<Own> => {
    const kind = kindOf(ref);
    try {
      switch (kind.kind) {
        case "file":
          return { own: true, text: await fileText(kind.path) };
        case "chat":
          return { own: true, text: scope.chat === undefined ? undefined : await chatText(scope, kind.stretch) };
        case "lore":
          return { own: true, text: scope.chat === undefined ? undefined : await loreText(scope, kind.id) };
        case "prompt":
          return { own: true, text: await deps.slice?.(ref, reader) };
        case "host":
          return { own: false };
      }
    } catch (error) {
      env.log.warn("Something an agent was to be given could not be read.", { agent: reader.id, ref, error: error instanceof Error ? error.message : String(error) });
      return { own: true, text: undefined };
    }
  };

  const found = await Promise.all(list.map((item) => own(item.ref)));
  const refs: AttachmentRef[] = list.map((item, at) => ({ ref: item.ref, from: item.from, own: found[at]?.own ?? false }));
  let hosted: ContextBlock[] = [];
  if (refs.length > 0) {
    try {
      hosted = await env.events.attachments(scope, reader, refs, deps.moment);
    } catch (error) {
      env.log.error("The host could not be told what an agent is given, or give its part of it.", { agent: reader.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const given: Given = { blocks: [], missing: [] };
  for (const [at, item] of list.entries()) {
    const mine = found[at];
    const text = mine?.own === true ? mine.text : hosted.find((block) => block.name === item.ref)?.text;
    if (text === undefined) given.missing.push(item.ref);
    else given.blocks.push({ name: item.ref, text });
  }
  return given;
}
