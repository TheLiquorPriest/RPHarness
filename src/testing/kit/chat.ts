// The kit's cases for the chat (§6.8 `chat_read`, `chat_search`; §4.2 hidden messages) and the
// lore (§9.4).

import { expect, test } from "bun:test";
import type { AgentRef } from "../../contract/index";
import type { KitContext } from "./context";
import { KIT_OTHER_USER, unlessRefused } from "./context";

/** The kit's lead: it plays no character, so it reads every entry (§9.4). */
const KIT_LEAD: AgentRef = { id: "kit-lead", definition: "author" };
/** A character's agent playing a character no entry is known to: no host has a character with this id. */
const KIT_OUTSIDER: AgentRef = { id: "kit-character-1", definition: "character", parent: "kit-lead", plays: "kit-no-such-character" };

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

  test("another user's scope reads none of this user's chat", async () => {
    const foreign = { ...ctx.scope, user: KIT_OTHER_USER };
    const ids = ctx.seed.messages.map((m) => m.id);
    const info = await unlessRefused(ctx.env.chat.info(foreign));
    const read = (await unlessRefused(ctx.env.chat.read(foreign, { from: 0, to: ctx.seed.messages.length }))) ?? [];
    const found = (await unlessRefused(ctx.env.chat.search(foreign, { text: "lighthouse lantern tide" }))) ?? [];
    expect({ length: info?.length ?? 0, seen: [...read, ...found].map((m) => m.id).filter((id) => ids.includes(id)) }).toEqual({ length: 0, seen: [] });
  });
}

export function loreCases(ctx: KitContext<"lore">): void {
  test("a read gives entries in full, in the order asked, and leaves out ids the host does not know", async () => {
    const [bookEntry, , worldEntry] = ctx.seed.lore;
    const read = await ctx.env.lore.read(ctx.scope, [worldEntry?.id ?? "", "e-999", bookEntry?.id ?? ""], KIT_LEAD);
    expect(read).toEqual([expect.objectContaining(worldEntry), expect.objectContaining(bookEntry)]);
  });

  test("a search finds entries by title, key and text, within the sources asked", async () => {
    expect((await ctx.env.lore.search(ctx.scope, { text: "saltglass" }, KIT_LEAD))[0]?.id).toBe("e-101");
    expect((await ctx.env.lore.search(ctx.scope, { text: "bronze" }, KIT_LEAD)).map((h) => h.id)).toEqual(["w-7"]);
    const inBook = await ctx.env.lore.search(ctx.scope, { text: "bell", sources: ["Kit Coast Book"] }, KIT_LEAD);
    expect(inBook.map((h) => h.id)).toEqual(["e-102"]);
    expect(await ctx.env.lore.search(ctx.scope, { text: "quillfeather" }, KIT_LEAD)).toEqual([]);
  });

  test("an entry known only to named characters is not given to a reader who plays none of them, by read or by search", async () => {
    // Only entries the host itself marks are checked, so a host that marks none passes as it stands.
    const marked = (await ctx.env.lore.read(ctx.scope, ctx.seed.lore.map((e) => e.id), KIT_LEAD)).filter((e) => e.knowing?.by === "characters");
    for (const entry of marked) {
      expect({ entry: entry.id, read: await ctx.env.lore.read(ctx.scope, [entry.id], KIT_OUTSIDER) }).toEqual({ entry: entry.id, read: [] });
      const found = (await ctx.env.lore.search(ctx.scope, { text: entry.title }, KIT_OUTSIDER)).some((h) => h.id === entry.id);
      expect({ entry: entry.id, found }).toEqual({ entry: entry.id, found: false });
    }
  });

  test("what activated for the turn's prompt; nothing for a scope with no turn", async () => {
    expect(await ctx.env.lore.activated(ctx.scope)).toEqual(ctx.seed.prompts[0].activated);
    expect(await ctx.env.lore.activated({ user: ctx.scope.user, chat: ctx.scope.chat, session: ctx.scope.session })).toEqual([]);
  });

  test("another user's scope reads none of this user's lore", async () => {
    const foreign = { ...ctx.scope, user: KIT_OTHER_USER };
    const mine = (e: { id: string; title: string }) => ctx.seed.lore.some((s) => s.id === e.id && s.title === e.title);
    const read = (await unlessRefused(ctx.env.lore.read(foreign, ctx.seed.lore.map((e) => e.id), KIT_LEAD))) ?? [];
    const found = (await unlessRefused(ctx.env.lore.search(foreign, { text: "saltglass harbor bronze bell" }, KIT_LEAD))) ?? [];
    const activated = (await unlessRefused(ctx.env.lore.activated(foreign))) ?? [];
    expect([...read, ...found, ...activated].filter(mine).map((e) => e.id)).toEqual([]);
  });
}
