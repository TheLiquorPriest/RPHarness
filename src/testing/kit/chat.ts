// The kit's cases for the chat (§6.8 `chat_read`, `chat_search`; §4.2 hidden messages) and the
// lore (§9.4).

import { expect, test } from "bun:test";
import type { KitContext } from "./context";

export function chatCases(ctx: KitContext<"chat">): void {
  test("the chat's length, its setting on hidden messages, and the stretches it names", async () => {
    expect(await ctx.env.chat.info(ctx.scope)).toEqual({ length: ctx.seed.messages.length, hiddenReadable: ctx.seed.hiddenReadable, ranges: ctx.seed.ranges });
  });

  test("a read gives the stretch asked for, hidden messages marked with their text withheld, summarized ones marked", async () => {
    const all = await ctx.env.chat.read(ctx.scope, { from: 0, to: ctx.seed.messages.length });
    expect(all).toHaveLength(ctx.seed.messages.length);
    for (const [index, seeded] of ctx.seed.messages.entries()) {
      const got = all[index];
      expect(got).toMatchObject({ id: seeded.id, index, role: seeded.role, name: seeded.name });
      if (seeded.hidden === true) {
        expect(got?.hidden).toBe(true);
        expect(got?.text).toBeUndefined();
      } else {
        expect(got?.hidden).toBeUndefined();
        expect(got?.text).toBe(seeded.text);
      }
      expect(got?.summarized).toBe(seeded.summarized);
    }
    const tail = await ctx.env.chat.read(ctx.scope, { from: 4, to: 99 });
    expect(tail.map((m) => m.index)).toEqual([4, 5]);
    expect(await ctx.env.chat.read(ctx.scope, { from: 7, to: 9 })).toEqual([]);
  });

  test("a search finds messages by their words, and leaves hidden ones out", async () => {
    const lighthouse = await ctx.env.chat.search(ctx.scope, { text: "LIGHTHOUSE" });
    expect(lighthouse.map((h) => h.id)).toEqual(["kit-m0"]);
    expect(lighthouse[0]?.snippet.toLowerCase()).toContain("lighthouse");
    expect((await ctx.env.chat.search(ctx.scope, { text: "tide" })).map((h) => h.index)).toEqual([5]);
    expect(await ctx.env.chat.search(ctx.scope, { text: "tide", within: { from: 0, to: 2 } })).toEqual([]);
    expect(await ctx.env.chat.search(ctx.scope, { text: "quillfeather" })).toEqual([]);
  });
}

export function loreCases(ctx: KitContext<"lore">): void {
  test("a read gives entries in full, in the order asked, and leaves out ids the host does not know", async () => {
    const [bookEntry, , worldEntry] = ctx.seed.lore;
    const read = await ctx.env.lore.read(ctx.scope, [worldEntry?.id ?? "", "e-999", bookEntry?.id ?? ""]);
    expect(read).toEqual([expect.objectContaining(worldEntry), expect.objectContaining(bookEntry)]);
  });

  test("a search finds entries by title, key and text, within the sources asked", async () => {
    expect((await ctx.env.lore.search(ctx.scope, { text: "saltglass" }))[0]?.id).toBe("e-101");
    expect((await ctx.env.lore.search(ctx.scope, { text: "bronze" })).map((h) => h.id)).toEqual(["w-7"]);
    const inBook = await ctx.env.lore.search(ctx.scope, { text: "bell", sources: ["Kit Coast Book"] });
    expect(inBook.map((h) => h.id)).toEqual(["e-102"]);
    expect(await ctx.env.lore.search(ctx.scope, { text: "quillfeather" })).toEqual([]);
  });

  test("what activated for the turn's prompt; nothing for a scope with no turn", async () => {
    expect(await ctx.env.lore.activated(ctx.scope)).toEqual(ctx.seed.prompts[0].activated);
    expect(await ctx.env.lore.activated({ user: ctx.scope.user, chat: ctx.scope.chat, session: ctx.scope.session })).toEqual([]);
  });
}
