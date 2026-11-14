// An agent's stack (§5.2): exactly what its definition's `reads` names, in that order, after the
// definition itself; the always-on rules it is named in; a template that holds only headings and
// comments left out and said so; the files added for the kind of turn handed over for the briefing;
// and a file changed in the middle of a session reaching the next briefing whole, or as off.

import { afterEach, describe, expect, test } from "bun:test";
import { changes, changesText, loadGuidance, snapshot } from "../../src/files/index";
import type { Bench } from "./support";
import { ADDED, bench, drafted, scope } from "./support";

let b: Bench | undefined;
afterEach(async () => {
  await b?.close();
  b = undefined;
});

const brief = (stack: { entries: { part: string; where: string; left?: string; situations?: string[] }[] }) =>
  stack.entries.map((e) => `${e.where}:${e.part}${e.left !== undefined ? `(${e.left})` : ""}${e.situations !== undefined ? `[${e.situations.join(",")}]` : ""}`);

describe("the stack", () => {
  test("is the definition, then exactly what `reads` names in its order, then what the briefing is handed", async () => {
    b = await bench({ shipped: await drafted(), global: { "config.yml": ADDED } });
    const g = loadGuidance(b.host.files, scope);

    // The shipped WORLD.md holds only headings and a comment: left out, and the stack says so. No AGENTS.md exists.
    expect(brief(await g.stack("author", { situations: ["new"] }))).toEqual([
      "opening:agents/author",
      "opening:ALL-AGENTS",
      "opening:rules/consent",
      "opening:rules/perceptions",
      "opening:AGENTS(missing)",
      "opening:WORLD(empty)",
      "opening:SIMULATION",
      "opening:WRITING",
      "opening:TURN",
      "opening:PRESET",
    ]);
    expect(brief(await g.stack("author", { situations: ["swipe", "delete"] })).slice(10)).toEqual(["briefing:SWIPE[swipe]", "briefing:DELETE[delete]"]);
    // For the Files page: everything the table could add, with what adds it.
    expect(brief(await g.stack("author")).slice(10)).toEqual(["briefing:SWIPE[swipe,regenerate]", "briefing:DELETE[delete]"]);

    // Who is not given the briefing gets nothing for the turn; a rule names only whom it is for.
    expect(brief(await g.stack("gm", { situations: ["swipe"] }))).toEqual(["opening:agents/gm", "opening:ALL-AGENTS", "opening:rules/consent", "opening:rules/perceptions", "opening:WORLD(empty)", "opening:SIMULATION"]);
    expect(brief(await g.stack("character"))).toEqual(["opening:agents/character", "opening:ALL-AGENTS", "opening:rules/consent"]);
    expect(brief(await g.stack("narrator"))).toEqual(["opening:agents/narrator", "opening:WRITING"]);
    expect(brief(await g.stack("indexer"))).toEqual(["opening:agents/indexer"]);
    expect(brief(await g.stack("nobody"))).toEqual(["opening:agents/nobody(missing)"]);

    const parts = await g.stackParts("author");
    expect(parts[0]).toEqual({ part: "agents/author", path: "@shipped/.agents/author.md", level: "shipped", hash: expect.stringMatching(/^[0-9a-f]{64}$/), where: "opening" });
    expect(parts.find((p) => p.part === "WORLD")).toEqual({ part: "WORLD", path: "@shipped/WORLD.md", level: "shipped", hash: expect.any(String), where: "opening", left: "empty" });
    expect(parts.find((p) => p.part === "AGENTS")).toEqual({ part: "AGENTS", path: "AGENTS.md", level: "chat", where: "opening", left: "missing" });
  });

  test("gives each file's whole text as written, and a filled-in template once it holds something", async () => {
    b = await bench({ shipped: await drafted() });
    await b.put("chat", "WORLD.md", "# This story's world\n\n<!-- notes -->\n\n## Premise\n\nA lighthouse keeper's last winter.\n");
    await b.put("character", "AGENTS.md", "Wren never lies outright.\n");
    const stack = await loadGuidance(b.host.files, scope).stack("author");
    const world = stack.entries.find((e) => e.part === "WORLD");
    expect(world).toMatchObject({ level: "chat", path: "WORLD.md", text: "# This story's world\n\n<!-- notes -->\n\n## Premise\n\nA lighthouse keeper's last winter.\n" });
    expect(world?.left).toBeUndefined();
    expect(stack.entries.find((e) => e.part === "AGENTS")).toMatchObject({ level: "character", text: "Wren never lies outright.\n", replaces: [] });
  });

  test("an always-on rule that names a kind of turn is handed over for those turns' briefings, not the opening block", async () => {
    b = await bench({
      global: {
        ".agents/lead.md": "---\ndescription: Leads.\nreads: [rules]\ngiven: [briefing]\n---\nLead.\n",
        ".rules/plain.md": "---\ndescription: Always.\nagents: [lead]\n---\nPlain.\n",
        ".rules/on-swipe.md": "---\ndescription: Swipes only.\nagents: [lead]\nturns: [swipe, regenerate]\n---\nAnother telling.\n",
      },
    });
    const g = loadGuidance(b.host.files, scope);
    expect(brief(await g.stack("lead", { situations: ["new"] }))).toEqual(["opening:agents/lead", "opening:rules/plain"]);
    expect(brief(await g.stack("lead", { situations: ["regenerate"] }))).toEqual(["opening:agents/lead", "opening:rules/plain", "briefing:rules/on-swipe[regenerate]"]);
  });
});

describe("a layered instruction file", () => {
  test("is read at every level that has one, farther first, each its own part; `off:` takes all of them; a name not listed is nearest-wins", async () => {
    const tree = await bench({
      global: { "config.yml": "layered: [AGENTS]\n", ".agents/lead.md": "---\ndescription: Leads.\nreads: [AGENTS, WORLD]\n---\nLead.\n" },
      character: { "AGENTS.md": "Wren never lies outright.\n", "WORLD.md": "# World\n\nThe character's world.\n" },
      chat: { "AGENTS.md": "In this chat, the lamp is failing.\n", "WORLD.md": "# World\n\nThe chat's world.\n" },
    });
    b = tree;
    const read = async () => (await loadGuidance(tree.host.files, scope).stack("lead")).entries.map((e) => [e.part, e.level, e.left ?? e.text]);
    const stack = await loadGuidance(tree.host.files, scope).stack("lead");
    expect(stack.entries.map((e) => [e.part, e.level, e.text, e.layered, e.replaces.length])).toEqual([
      ["agents/lead", "global", "Lead.\n", undefined, 0],
      ["AGENTS", "character", "Wren never lies outright.\n", true, 0],
      ["AGENTS", "chat", "In this chat, the lamp is failing.\n", true, 0],
      ["WORLD", "chat", "# World\n\nThe chat's world.\n", undefined, 1],
    ]);

    // A change at one level is that level's part alone.
    const opened = snapshot(stack);
    await tree.put("chat", "AGENTS.md", "In this chat, the lamp is out.\n");
    expect(changes(opened, await loadGuidance(tree.host.files, scope).stack("lead"))).toEqual([{ part: "AGENTS", change: "changed", path: "AGENTS.md", level: "chat", text: "In this chat, the lamp is out.\n" }]);

    await tree.put("chat", "config.yml", "off: [AGENTS.md]\n");
    expect(await read()).toEqual([
      ["agents/lead", "global", "Lead.\n"],
      ["AGENTS", "character", "off"],
      ["AGENTS", "chat", "off"],
      ["WORLD", "chat", "# World\n\nThe chat's world.\n"],
    ]);

    await tree.drop("chat", "config.yml");
    await tree.drop("character", "AGENTS.md");
    expect((await read()).filter(([part]) => part === "AGENTS")).toEqual([["AGENTS", "chat", "In this chat, the lamp is out.\n"]]);

    // With no `layered:` in any level's config, nothing is layered.
    await tree.put("character", "AGENTS.md", "Wren never lies outright.\n");
    await tree.put("global", "config.yml", "off: []\n");
    expect((await read()).filter(([part]) => part === "AGENTS")).toEqual([["AGENTS", "chat", "In this chat, the lamp is out.\n"]]);
  });
});

describe("a file changed in the middle of a session", () => {
  test("reaches the next briefing as its whole current text, or as switched off, in the notices' words", async () => {
    b = await bench({ shipped: await drafted() });
    const opened = snapshot(await loadGuidance(b.host.files, scope).stack("author"));
    expect(opened.parts.map((p) => p.part)).toEqual(["agents/author", "ALL-AGENTS", "rules/consent", "rules/perceptions", "SIMULATION", "WRITING", "TURN", "PRESET"]);

    // Nothing changed: nothing to say.
    expect(changes(opened, await loadGuidance(b.host.files, scope).stack("author"))).toEqual([]);

    const turn = "# How a turn is run\n\nWeigh what the player wants, then answer in one call.\n";
    await b.put("chat", "TURN.md", turn);
    await b.put("chat", "config.yml", "off: [WRITING, rules/consent]\n");
    await b.put("chat", "WORLD.md", "## Premise\n\nA storm is coming.\n");
    const now = await loadGuidance(b.host.files, scope).stack("author");
    const found = changes(opened, now);
    expect(found).toEqual([
      { part: "WORLD", change: "added", path: "WORLD.md", level: "chat", text: "## Premise\n\nA storm is coming.\n" },
      { part: "TURN", change: "changed", path: "TURN.md", level: "chat", text: turn },
      { part: "rules/consent", change: "off", path: "@shipped/.rules/consent.md", level: "shipped", why: "off" },
      { part: "WRITING", change: "off", path: "@shipped/WRITING.md", level: "shipped", why: "off" },
    ]);

    const notices = await loadGuidance(b.host.files, scope).part("notices");
    expect(changesText(found, notices)).toBe(
      [
        "You changed WORLD.md since this session opened. The copy in the opening block no longer stands. Its whole current text follows.",
        "## Premise\n\nA storm is coming.",
        "You changed TURN.md since this session opened. The copy in the opening block no longer stands. Its whole current text follows.",
        "# How a turn is run\n\nWeigh what the player wants, then answer in one call.",
        "@shipped/.rules/consent.md has been switched off since this session opened. The copy in the opening block no longer stands.",
        "@shipped/WRITING.md has been switched off since this session opened. The copy in the opening block no longer stands.",
      ].join("\n\n"),
    );

    // "Apply now": the opening block starts afresh from the files as they stand, and nothing is owed.
    const applied = snapshot(now);
    expect(changes(applied, await loadGuidance(b.host.files, scope).stack("author"))).toEqual([]);
  });

  test("without its notice line the whole text is still given, and an off file goes unsaid", async () => {
    b = await bench({ shipped: await drafted() });
    const opened = snapshot(await loadGuidance(b.host.files, scope).stack("author"));
    await b.put("chat", "PRESET.md", "Map nothing.\n");
    await b.put("chat", "config.yml", "off: [SIMULATION]\n");
    await b.put("global", ".prompts/notices.md", "---\nformat: lines\n---\nprompt_unmapped: Not mapped yet.\n");
    const g = loadGuidance(b.host.files, scope);
    expect(changesText(changes(opened, await g.stack("author")), await g.part("notices"))).toBe("Map nothing.");
  });
});
