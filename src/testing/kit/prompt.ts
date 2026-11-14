// The kit's cases for the prompt port (§4.8): the raw layout is the facts of the prompt and only
// them, the same prompt gives the same layout, and a prompt map comes back as it was saved.

import { expect, test } from "bun:test";
import type { AgentRef, LocatedSlices, PromptMap, PromptMessage } from "../../contract/index";
import type { KitContext } from "./context";
import { layoutHash } from "./context";

const MAPPER: AgentRef = { id: "kit-mapper-1", definition: "mapper", job: "kit-job-1" };

function textOf(m: PromptMessage): string {
  return typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function promptCases(ctx: KitContext<"prompt">): void {
  const turn = (n: 0 | 1 | 2) => ({ ...ctx.scope, turn: ctx.seed.prompts[n].turn });

  test("the layout is the prompt's facts: each message's role, length, hash and parts, the blocks, the preset", async () => {
    const [first] = ctx.seed.prompts;
    const layout = await ctx.env.prompt.layout(turn(0));
    expect(layout.complete).toBe(true);
    expect(layout.preset?.id).toBe(ctx.seed.preset.id);
    expect(layout.blocks).toEqual(first.blocks);
    expect(layout.blocksFrom).not.toBeNull();
    expect(layout.messages).toHaveLength(first.messages.length);
    for (const [i, m] of first.messages.entries()) {
      const raw = layout.messages[i];
      const text = textOf(m);
      expect(raw).toMatchObject({ role: m.role, length: text.length, hash: layoutHash(text) });
      expect(raw?.parts.length).toBeGreaterThan(0);
      for (const part of raw?.parts ?? []) expect(part.start >= 0 && part.start <= part.end && part.end <= text.length).toBe(true);
      expect(raw?.parts.map((p) => p.kind)).toContain(m.kind);
      if (m.source !== undefined) expect(raw?.parts.find((p) => p.kind === "history")?.source).toEqual(m.source);
    }
    // The main prompt's block is found where its text is.
    const main = first.blocks[0]?.text ?? "";
    expect(layout.messages[0]?.parts[0]?.blocks).toEqual([{ block: 0, start: 0, end: main.length }]);
  });

  test("the same prompt gives the same layout; a changed message changes only its own hash", async () => {
    const a = await ctx.env.prompt.layout(turn(0));
    expect(await ctx.env.prompt.layout(turn(0))).toEqual(a);
    expect(await ctx.env.prompt.layout(turn(1))).toEqual(a);
    const changed = await ctx.env.prompt.layout(turn(2));
    expect(changed.messages).toHaveLength(a.messages.length);
    const differ = changed.messages.flatMap((m, i) => (m.hash === a.messages[i]?.hash ? [] : [i]));
    expect(differ).toEqual([1]);
  });

  test("a prompt map comes back as it was saved, for the preset the chat is on", async () => {
    expect(await ctx.env.prompt.map(ctx.scope)).toBeUndefined();
    const map: PromptMap = {
      format: 1,
      preset: ctx.seed.preset,
      slices: [
        { marker: "preset.main", kind: "instructions", line: "How the narrator is to write.", behaviour: "fixed", find: { signature: "kit-sig-1", block: "Main Prompt", role: "system" } },
        { marker: "card", kind: "character", line: "Who Wren is.", behaviour: "fixed", find: { after: "preset.main", before: "lore" } },
        { marker: "history", kind: "history", line: "The chat so far.", behaviour: "turn", find: { after: "lore" } },
      ],
    };
    await ctx.env.prompt.saveMap(ctx.scope, map, MAPPER);
    expect(await ctx.env.prompt.map(ctx.scope)).toEqual(map);
    const edited: PromptMap = { ...map, slices: map.slices.map((s) => (s.marker === "card" ? { ...s, marker: "card.wren", edited: true } : s)) };
    await ctx.env.prompt.saveMap(ctx.scope, edited, MAPPER);
    expect(await ctx.env.prompt.map(ctx.scope)).toEqual(edited);
    // The map is the preset's: another turn of the chat sees it too.
    expect(await ctx.env.prompt.map(turn(2))).toEqual(edited);
  });

  test("where the slices were found this turn is kept", async () => {
    const located: LocatedSlices = {
      preset: ctx.seed.preset,
      slices: [{ marker: "preset.main", kind: "instructions", at: [{ message: 0, start: 0, end: 10 }], length: 10, hash: layoutHash("kit") }],
      unclaimed: [],
      notices: [{ kind: "changed", marker: "card" }, { kind: "unmapped" }],
      front: { length: 120, brokenBy: "card" },
    };
    await ctx.env.prompt.saveLocated(ctx.scope, located);
  });
}
