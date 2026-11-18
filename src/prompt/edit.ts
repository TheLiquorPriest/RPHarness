// The prompt map as the Prompt page shows and edits it (§4.8 L365, L369; C-9). `show` gives the map
// as found in a turn's prompt, RPH's own kept copy of it read back (memory.ts): each slice with its
// text, where and how it was found and what the breakdown said, the text of no slice, and the turn's
// notices and front as its located record has them. `edit` makes one of the owner's edits (rename a
// marker, merge slices, split one at given words, correct a line, change a kind) on the map as found
// in that prompt, marks each slice it changes `edited` so a later learn keeps it, writes the finders
// from the text as it stands, and saves the map for every chat on the preset. A refusal is a line of
// `.prompts/prompt-map.md`.
import type { Environment, PromptMap, PromptMapApi, PromptMapEdited, PromptMapShown, PromptSlice, Scope, ShownSlice } from "../contract";
import type { Fields } from "../files/api";
import { loadGuidance } from "../files";
import { readSettings } from "../harness/settings";
import { reserved } from "./cut";
import { withFinders } from "./learn";
import { PromptMemory } from "./memory";
import { SLICE_KINDS, same } from "./names";
import { TurnPrompt } from "./prompt";
import { isBefore, mergedSpans, type Span } from "./text";
import { promptWords } from "./words";

type Env = Pick<Environment, "prompt" | "lore" | "log" | "store" | "files">;

/** A kept turn's prompt (`turn` absent: the chat's newest kept), its slices found by the map as it stands now, read in the session the turn played in; undefined where RPH keeps none. */
export async function keptPrompt(env: Env, scope: Scope, turn?: string): Promise<{ prompt: TurnPrompt; shown: Pick<PromptMapShown, "turn" | "notices" | "front"> } | undefined> {
  const held = await new PromptMemory(env.store, env.files).held(scope, turn);
  if (held === undefined) return undefined;
  const prompt = await TurnPrompt.read({ env, scope: { ...scope, session: held.session, turn: held.turn }, messages: held.messages });
  return { prompt, shown: { turn: held.turn, notices: held.located.notices, front: held.located.front } };
}

/** `split`'s second part: where in a slice's stretches `words` begin, past its start; undefined where its text does not hold them there. */
function splitAt(texts: readonly string[], spans: readonly Span[], words: string): { first: Span[]; second: Span[] } | undefined {
  if (words.trim() === "") return undefined;
  for (const [n, span] of spans.entries()) {
    const text = texts[span.message] ?? "";
    const at = text.indexOf(words, span.start + (n === 0 ? 1 : 0));
    if (at < 0 || at + words.length > span.end) continue;
    return { first: [...spans.slice(0, n), ...(at > span.start ? [{ ...span, end: at }] : [])], second: [{ ...span, start: at }, ...spans.slice(n + 1)] };
  }
  return undefined;
}

/**
 * What keeps slices from being neighbours: the first two of their stretches, in prompt order and of different slices, that have a part of the
 * prompt between them which is no slice of theirs (another slice, chat history, lore, or text no slice claims), with the name of that part;
 * undefined where they sit side by side.
 */
export function between(prompt: TurnPrompt, slices: readonly { marker: string; spans: readonly Span[] }[]): { marker: string; other: string; between: string } | undefined {
  const mine = new Set(slices.map((s) => s.marker));
  const stretches = slices.flatMap((s) => s.spans.map((span) => ({ marker: s.marker, span }))).sort((a, b) => a.span.message - b.span.message || a.span.start - b.span.start);
  const others = prompt.slices.filter((s) => !(s.from === "map" && mine.has(s.marker)));
  for (let n = 1; n < stretches.length; n++) {
    const a = stretches[n - 1];
    const b = stretches[n];
    if (a === undefined || b === undefined || a.marker === b.marker) continue;
    const found = others.find((s) => s.spans.some((o) => isBefore(a.span, o) && isBefore(o, b.span)));
    if (found !== undefined) return { marker: a.marker, other: b.marker, between: found.marker };
  }
  return undefined;
}

/** The prompt map's show and edit over the host's ports. */
export function promptMapApi(env: Env): PromptMapApi {
  return {
    async show(scope) {
      const kept = await keptPrompt(env, scope, scope.turn);
      if (kept === undefined) return undefined;
      const { prompt, shown } = kept;
      const map = prompt.facts.map;
      // History is addressed by message and never mapped: every other named part of the prompt is shown.
      const slices = prompt.slices
        .filter((slice) => slice.from !== "unclaimed" && slice.from !== "history")
        .map((slice): ShownSlice => {
          const text = prompt.text(slice);
          const learned = slice.from === "map" ? map?.slices.find((s) => s.marker === slice.marker) : undefined;
          const how = slice.how;
          return {
            marker: slice.marker,
            kind: slice.kind,
            ...(slice.line !== undefined ? { line: slice.line } : {}),
            ...(slice.behaviour !== undefined ? { behaviour: slice.behaviour } : {}),
            ...(learned?.edited === true ? { edited: true as const } : {}),
            text,
            length: text.length,
            at: slice.spans.map((span) => ({ ...span })),
            ...(how !== undefined ? { found: how.found, ...(how.hint !== undefined ? { hint: how.hint, breakdown: how.corrected === true ? ("corrected" as const) : ("confirmed" as const) } : {}) } : {}),
          };
        });
      const unclaimed = prompt.slices.filter((slice) => slice.from === "unclaimed").flatMap((slice) => slice.spans.map((span) => ({ ...span, text: (prompt.texts[span.message] ?? "").slice(span.start, span.end) })));
      return { ...shown, preset: prompt.preset, mapped: prompt.mapped, slices, unclaimed };
    },

    async edit(scope, edit, by) {
      const guidance = loadGuidance(env.files, scope);
      const [words, settings, kept] = await Promise.all([promptWords(guidance), readSettings(guidance, env, scope), keptPrompt(env, scope, scope.turn)]);
      const refused = (line: string, fields?: Fields): PromptMapEdited => ({ status: "refused", words: words(line, fields) ?? "" });
      if (kept === undefined) return refused("no_prompt");
      const { prompt } = kept;
      const map = prompt.facts.map;
      if (map === undefined || !prompt.mapped) return refused("edit_unmapped");
      const inMap = (marker: string): PromptSlice | undefined => map.slices.find((s) => same(s.marker, marker));
      const spansOf = (slice: PromptSlice): Span[] | undefined => prompt.slices.find((s) => s.from === "map" && s.marker === slice.marker)?.spans;
      /** Why a new marker cannot be: empty or one `prompt` reads itself, or another slice's (`other`: a slice it may replace). */
      const badName = (marker: string, ...others: PromptSlice[]): PromptMapEdited | undefined => {
        if (marker === "" || reserved(marker)) return refused("write_reserved", { marker });
        const taken = inMap(marker);
        return taken !== undefined && !others.includes(taken) ? refused("edit_taken", { marker }) : undefined;
      };
      /** The map with `changed` slices in place of theirs, `gone` taken out, each changed one marked edited; with `spans`, every slice this prompt has gets its finder from the text as it stands. */
      const remade = (changed: readonly { was?: PromptSlice; slice: PromptSlice; spans?: Span[] }[], gone: readonly PromptSlice[] = []): PromptMap => {
        const out = new Map<PromptSlice, { slice: PromptSlice; spans?: Span[] }[]>();
        const added: { slice: PromptSlice; spans?: Span[] }[] = [];
        for (const c of changed) {
          const one = { slice: { ...c.slice, edited: true as const }, ...(c.spans !== undefined ? { spans: c.spans } : {}) };
          if (c.was === undefined) added.push(one);
          else out.set(c.was, [...(out.get(c.was) ?? []), one]);
        }
        const list = map.slices.flatMap((slice) => (gone.includes(slice) ? [] : (out.get(slice) ?? [{ slice }])));
        const all = [...list, ...added];
        const placed = all.flatMap((item) => {
          const spans = item.spans ?? spansOf(item.slice);
          return spans === undefined || spans.length === 0 ? [] : [{ slice: item.slice, spans }];
        });
        const found = withFinders(prompt, placed, settings.signatureHead);
        const missing = all.filter((item) => !placed.some((p) => p.slice === item.slice)).map((item) => item.slice);
        return { ...map, slices: [...found, ...missing] };
      };

      let next: PromptMap;
      // The slices the edit renamed, old marker to new, for the records that name them.
      let named: ReadonlyMap<string, string> = new Map();
      switch (edit.edit) {
        case "rename": {
          const slice = inMap(edit.marker);
          if (slice === undefined) return refused("edit_no_marker", { marker: edit.marker });
          const to = edit.to.trim();
          const bad = badName(to, slice);
          if (bad !== undefined) return bad;
          // Its neighbours' finders follow the new name.
          const renamed = { ...slice, marker: to, edited: true as const };
          next = { ...map, slices: map.slices.map((s) => (s === slice ? renamed : { ...s, find: { ...s.find, ...(s.find.after === slice.marker ? { after: to } : {}), ...(s.find.before === slice.marker ? { before: to } : {}) } })) };
          named = new Map([[slice.marker, to]]);
          break;
        }
        case "line": {
          const slice = inMap(edit.marker);
          if (slice === undefined) return refused("edit_no_marker", { marker: edit.marker });
          next = { ...map, slices: map.slices.map((s) => (s === slice ? { ...s, line: edit.line.trim(), edited: true as const } : s)) };
          break;
        }
        case "kind": {
          const slice = inMap(edit.marker);
          if (slice === undefined) return refused("edit_no_marker", { marker: edit.marker });
          if (!SLICE_KINDS.includes(edit.to)) return refused("write_kind", { marker: slice.marker, kind: edit.to, kinds: [...SLICE_KINDS] });
          next = { ...map, slices: map.slices.map((s) => (s === slice ? { ...s, kind: edit.to, edited: true as const } : s)) };
          break;
        }
        case "merge": {
          const slices = [...new Set(edit.markers.map((marker) => inMap(marker) ?? marker))];
          const unknown = slices.find((s): s is string => typeof s === "string");
          if (unknown !== undefined) return refused("edit_no_marker", { marker: unknown });
          const merged = slices as PromptSlice[];
          if (merged.length < 2) return refused("edit_merge_two");
          const spans = merged.map((s) => spansOf(s));
          const lost = merged.find((_, n) => spans[n] === undefined);
          if (lost !== undefined) return refused("edit_not_found", { marker: lost.marker });
          // One slice is one stretch of the prompt: slices with a part of the prompt between them are not joined over it.
          const apart = between(prompt, merged.map((s, n) => ({ marker: s.marker, spans: spans[n] ?? [] })));
          if (apart !== undefined) return refused("edit_not_neighbours", apart);
          const as = edit.as.trim();
          const bad = badName(as, ...merged);
          if (bad !== undefined) return bad;
          const [first, ...rest] = merged as [PromptSlice, ...PromptSlice[]];
          // Its line says what each of its parts is, in the order they stand in the prompt, until the owner corrects it.
          const inPrompt = merged.map((s, n) => ({ s, at: spans[n]?.[0] })).sort((a, b) => (a.at?.message ?? 0) - (b.at?.message ?? 0) || (a.at?.start ?? 0) - (b.at?.start ?? 0));
          const line = inPrompt.map(({ s }) => s.line.trim()).filter((l) => l !== "").join(" ");
          next = remade([{ was: first, slice: { ...first, marker: as, line, find: {} }, spans: mergedSpans(prompt.texts, spans.flatMap((s) => s ?? [])) }], rest);
          break;
        }
        case "split": {
          const slice = inMap(edit.marker);
          if (slice === undefined) return refused("edit_no_marker", { marker: edit.marker });
          const spans = spansOf(slice);
          if (spans === undefined) return refused("edit_not_found", { marker: slice.marker });
          const parts = splitAt(prompt.texts, mergedSpans(prompt.texts, spans), edit.at);
          if (parts === undefined) return refused("edit_no_words", { marker: slice.marker, words: edit.at });
          const second = edit.second.trim();
          const bad = badName(second);
          if (bad !== undefined) return bad;
          // The second part says it is the second part of the slice it was cut from, until the owner corrects it.
          next = remade([
            { was: slice, slice, spans: parts.first },
            { was: slice, slice: { ...slice, marker: second, line: words("edit_second_part", { marker: slice.marker }) ?? "", find: {} }, spans: parts.second },
          ]);
          break;
        }
      }
      await env.prompt.saveMap(scope, next, by);
      // The records of the chat's turns follow: a renamed slice is named by its new marker in each, and each turn's record is made by the map as it now stands, so the next turn is compared with it and not with the map as it was.
      await new PromptMemory(env.store, env.files).remark(env, scope, next, named);
      return { status: "saved", map: next };
    },
  };
}
