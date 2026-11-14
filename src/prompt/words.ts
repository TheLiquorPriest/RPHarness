// How the prompt map's answers are laid out: every word is a line of the prompt part
// `.prompts/prompt-map.md`, filled in with the facts; code adds only the line breaks between them.
// A line the file does not have is left out.
import type { Guidance } from "../files/api";
import type { Words } from "../tools/kit";
import type { Item } from "./names";
import type { Slice, TurnPrompt } from "./prompt";

/** The prompt part that holds every line of the prompt map's words. */
export const PROMPT_PART = "prompt-map";

/** The prompt map's lines as the guidance has them; a line the file does not have is no words. */
export async function promptWords(guidance: Pick<Guidance, "part">): Promise<Words> {
  const part = await guidance.part(PROMPT_PART);
  const lines = part?.format === "lines" ? part : undefined;
  return (name, fields) => lines?.line(name, fields);
}

/** Texts one after another, the empty ones left out, a blank line between. */
function blocks(texts: readonly (string | undefined)[]): string {
  return texts.filter((text): text is string => text !== undefined && text !== "").join("\n\n");
}

/** Lines one after another, those left out or empty left out. */
function lines(texts: readonly (string | undefined)[]): string {
  return texts.filter((text): text is string => text !== undefined && text !== "").join("\n");
}

/** A slice's head: a chat message's place, id and speaker, or the slice's marker. */
function head(words: Words, slice: Slice): string | undefined {
  if (slice.source !== undefined) return words("history_head", { index: slice.source.index, id: slice.source.id, role: slice.role, ...(slice.source.name !== undefined ? { name: slice.source.name } : {}) });
  return words("slice_head", { marker: slice.marker, kind: slice.kind });
}

/** What a name found, laid out: each slice and entry under its head, the heads of messages and the raw layout's pieces one line each. */
export function laid(items: readonly Item[], words: Words): string {
  const out: { text: string; line: boolean }[] = [];
  for (const item of items) {
    let text: string;
    switch (item.type) {
      case "message":
        text = words("message_head", { index: item.index, role: item.role, length: item.length, ...(item.images !== undefined ? { images: item.images } : {}) }) ?? "";
        break;
      case "piece": {
        const { piece } = item;
        text =
          words("layout_piece", {
            name: piece.name,
            length: item.length,
            ...(piece.source !== undefined ? { history: { index: piece.source.index, id: piece.source.id } } : {}),
            ...(piece.kind === "lore" ? { lore: true } : {}),
            ...(item.block !== undefined ? { block: item.block } : {}),
          }) ?? "";
        break;
      }
      case "slice":
        text = lines([head(words, item.slice), item.text]);
        break;
      case "entry": {
        const { entry } = item;
        const knowing = entry.knowing;
        text = lines([
          words("entry_head", {
            id: entry.id,
            title: entry.title,
            source: entry.source,
            ...(knowing?.by === "characters" ? { known_by: knowing.names } : {}),
            ...(knowing?.by === "gate" ? { gate: { name: knowing.gate, ...(knowing.open ? { open: true } : {}) } } : {}),
          }),
          entry.text,
        ]);
        break;
      }
    }
    if (text === "") continue;
    const line = item.type === "message" || item.type === "piece";
    const last = out.at(-1);
    // Heads and pieces of the raw layout run on line by line; anything with text stands apart.
    if (last !== undefined && last.line && line && item.type === "piece") last.text += `\n${text}`;
    else out.push({ text, line });
  }
  return blocks(out.map((entry) => entry.text));
}

/** The notices about the prompt's shape, one line each, in the words of the file (§4.8). */
export function noticeLines(prompt: Pick<TurnPrompt, "notices" | "slices">, words: Words): string[] {
  const out: string[] = [];
  for (const notice of prompt.notices) {
    let line: string | undefined;
    switch (notice.kind) {
      case "unmapped":
        line = words("notice_unmapped");
        break;
      case "incomplete":
        line = words("notice_incomplete");
        break;
      case "changed":
        line = words("notice_changed", { marker: notice.marker });
        break;
      case "gone":
        line = words("notice_gone", { marker: notice.marker });
        break;
      case "unclaimed": {
        const at = prompt.slices.find((slice) => slice.from === "unclaimed" && slice.spans.some((span) => span.message === notice.message && span.start === notice.start));
        line = words("notice_unclaimed", { message: notice.message, length: notice.end - notice.start, ...(at !== undefined ? { name: at.marker } : {}) });
        break;
      }
      case "order":
        line = words("notice_order", { markers: notice.markers });
        break;
      case "preset":
        line = words("notice_preset", { ...(notice.was !== null ? { was: preset(notice.was) } : {}), ...(notice.now !== null ? { now: preset(notice.now) } : {}) });
        break;
    }
    if (line !== undefined && line !== "") out.push(line);
  }
  return out;
}

function preset(ref: { id: string; name?: string; revision?: string }): { id: string; name: string; revision?: string } {
  return { id: ref.id, name: ref.name ?? ref.id, ...(ref.revision !== undefined ? { revision: ref.revision } : {}) };
}

/** The map, as `prompt` with no names gives it: each slice in order with its kind, behaviour, size and line; each run of chat history as one line; the lore that activated; then the notices. */
export function listing(prompt: TurnPrompt, words: Words): string {
  const rows: (string | undefined)[] = [];
  const name = prompt.preset?.name ?? prompt.preset?.id;
  rows.push(prompt.mapped ? words("map_learned", { ...(name !== undefined ? { preset: name } : {}) }) : words("map_raw"));
  let run: Slice[] = [];
  const flush = () => {
    const first = run[0]?.source;
    const last = run.at(-1)?.source;
    if (first !== undefined && last !== undefined) rows.push(words("map_history", { count: run.length, first: first.index, last: last.index, length: run.reduce((sum, slice) => sum + prompt.text(slice).length, 0) }));
    run = [];
  };
  for (const slice of prompt.slices) {
    if (slice.kind === "history" && slice.source !== undefined) {
      run.push(slice);
      continue;
    }
    flush();
    const key = slice.from === "unclaimed" ? "map_unclaimed" : "map_slice";
    rows.push(
      words(key, {
        marker: slice.marker,
        kind: slice.kind,
        length: prompt.text(slice).length,
        ...(slice.behaviour !== undefined ? { behaviour: slice.behaviour } : {}),
        ...(slice.line !== undefined && slice.line !== "" ? { line: slice.line } : {}),
        ...(slice.block !== undefined ? { block: slice.block } : {}),
      }),
    );
  }
  flush();
  const ids = prompt.facts.activated.map((entry) => entry.id);
  if (ids.length > 0) rows.push(words("map_lore", { ids }));
  return lines([lines(rows), ...noticeLines(prompt, words)]);
}
