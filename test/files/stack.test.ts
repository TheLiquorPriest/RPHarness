// An agent's stack (§5.2): the parts its definition's `reads` names, in §5.2's order whatever order
// `reads` lists them, its definition fifth; the always-on rules it is named in; a template that holds
// only headings and comments left out and said so; the files added for the kind of turn handed over
// for the briefing; and a file changed in the middle of a session reaching the next briefing whole,
// or as off.

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
  test("the stack keeps §5.2's order whatever `reads` lists; the definition is fifth", async () => {
    b = await bench({
      shipped: await drafted(),
      global: {
        "config.yml": ADDED,
        // The drafted Author's parts, listed backwards.
        ".agents/backwards.md": "---\ndescription: Reads its parts backwards.\nreads: [PRESET, TURN, WRITING, SIMULATION, WORLD, AGENTS, rules, ALL-AGENTS]\n---\nBackwards.\n",
        ".agents/turner.md": "---\ndescription: Reads TURN before anything.\nreads: [TURN, ALL-AGENTS]\n---\nTurner.\n",
        // Two instruction files §5.2 does not number, between the numbered ones.
        ".agents/stylist.md": "---\ndescription: Reads files of its own.\nreads: [TURN, CANON, WORLD, ALL-AGENTS, STYLE.md]\n---\nStylist.\n",
      },
      chat: { "CANON.md": "The lamp has never once gone out.\n", "STYLE.md": "Short sentences.\n" },
    });
    const g = loadGuidance(b.host.files, scope);

    // 1 ALL-AGENTS, 2 the rules, 3 AGENTS, 4 WORLD, SIMULATION, WRITING, 5 the definition, 6 TURN, PRESET. The
    // shipped WORLD.md holds only headings and a comment: left out, and the stack says so. No AGENTS.md exists.
    expect(brief(await g.stack("author", { situations: ["new"] }))).toEqual([
      "opening:ALL-AGENTS",
      "opening:rules/consent",
      "opening:rules/perceptions",
      "opening:AGENTS(missing)",
      "opening:WORLD(empty)",
      "opening:SIMULATION",
      "opening:WRITING",
      "opening:agents/author",
      "opening:TURN",
      "opening:PRESET",
    ]);
    expect(brief(await g.stack("backwards"))).toEqual([
      "opening:ALL-AGENTS",
      "opening:rules/consent",
      "opening:AGENTS(missing)",
      "opening:WORLD(empty)",
      "opening:SIMULATION",
      "opening:WRITING",
      "opening:agents/backwards",
      "opening:TURN",
      "opening:PRESET",
    ]);
    expect(brief(await g.stack("turner"))).toEqual(["opening:ALL-AGENTS", "opening:agents/turner", "opening:TURN"]);
    // A file §5.2 does not number comes after part 4 and before the definition, in the order `reads` gives.
    expect(brief(await g.stack("stylist"))).toEqual(["opening:ALL-AGENTS", "opening:WORLD(empty)", "opening:CANON", "opening:STYLE", "opening:agents/stylist", "opening:TURN"]);

    expect(brief(await g.stack("author", { situations: ["swipe", "delete"] })).slice(10)).toEqual(["briefing:SWIPE[swipe]", "briefing:DELETE[delete]"]);
    // For the Files page: everything the table could add, with what adds it.
    expect(brief(await g.stack("author")).slice(10)).toEqual(["briefing:SWIPE[swipe,regenerate]", "briefing:DELETE[delete]"]);

    // Who is not given the briefing gets nothing for the turn; a rule names only whom it is for.
    expect(brief(await g.stack("gm", { situations: ["swipe"] }))).toEqual(["opening:ALL-AGENTS", "opening:rules/consent", "opening:rules/perceptions", "opening:WORLD(empty)", "opening:SIMULATION", "opening:agents/gm"]);
    expect(brief(await g.stack("character"))).toEqual(["opening:ALL-AGENTS", "opening:rules/consent", "opening:agents/character"]);
    expect(brief(await g.stack("narrator"))).toEqual(["opening:WRITING", "opening:agents/narrator"]);
    expect(brief(await g.stack("indexer"))).toEqual(["opening:agents/indexer"]);
    expect(brief(await g.stack("nobody"))).toEqual(["opening:agents/nobody(missing)"]);

    const parts = (await g.stack("author")).entries;
    expect(parts[7]).toMatchObject({ kind: "definition", part: "agents/author", path: "@shipped/.agents/author.md", level: "shipped", hash: expect.stringMatching(/^[0-9a-f]{64}$/), where: "opening" });
    expect(parts.find((p) => p.part === "WORLD")).toMatchObject({ kind: "instruction", part: "WORLD", path: "@shipped/WORLD.md", level: "shipped", hash: expect.any(String), where: "opening", left: "empty" });
    expect(parts.find((p) => p.part === "AGENTS")).toEqual({ kind: "instruction", part: "AGENTS", path: "AGENTS.md", level: "chat", where: "opening", replaces: [], left: "missing" });
  });

  test("the definition appears once, fifth", async () => {
    b = await bench({
      global: {
        // Its parts named out of order, and its own file named again by `instructions:`.
        ".agents/scribe.md": "---\ndescription: Fixture scribe.\nreads: [TURN, WORLD, AGENTS, rules, ALL-AGENTS]\n---\nFixture scribe: keep the log.\n",
        "config.yml": "instructions: ['@global/.agents/scribe.md']\n",
        "ALL-AGENTS.md": "Everyone keeps to the log.\n",
        ".rules/places.md": "---\ndescription: Places.\nagents: all\n---\nSay where each scene takes place.\n",
        "AGENTS.md": "Wren never lies outright.\n",
        "WORLD.md": "Gannet Rock, one winter.\n",
        "TURN.md": "Weigh what the player wants.\n",
      },
    });
    const stack = await loadGuidance(b.host.files, scope).stack("scribe");
    expect(brief(stack)).toEqual(["opening:ALL-AGENTS", "opening:rules/places", "opening:AGENTS", "opening:WORLD", "opening:agents/scribe", "opening:TURN"]);
    expect(stack.entries[4]).toMatchObject({ kind: "definition", path: "@global/.agents/scribe.md", text: "Fixture scribe: keep the log.\n" });
    expect(stack.entries.filter((e) => e.path === "@global/.agents/scribe.md" || e.text?.includes("Fixture scribe"))).toHaveLength(1);
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
    expect(brief(await g.stack("lead", { situations: ["new"] }))).toEqual(["opening:rules/plain", "opening:agents/lead"]);
    expect(brief(await g.stack("lead", { situations: ["regenerate"] }))).toEqual(["opening:rules/plain", "opening:agents/lead", "briefing:rules/on-swipe[regenerate]"]);
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
      ["AGENTS", "character", "Wren never lies outright.\n", true, 0],
      ["AGENTS", "chat", "In this chat, the lamp is failing.\n", true, 0],
      ["WORLD", "chat", "# World\n\nThe chat's world.\n", undefined, 1],
      ["agents/lead", "global", "Lead.\n", undefined, 0],
    ]);

    // A change at one level is that level's part alone.
    const opened = snapshot(stack);
    await tree.put("chat", "AGENTS.md", "In this chat, the lamp is out.\n");
    expect(changes(opened, await loadGuidance(tree.host.files, scope).stack("lead"))).toEqual([{ part: "AGENTS", change: "changed", path: "AGENTS.md", level: "chat", text: "In this chat, the lamp is out.\n" }]);

    await tree.put("chat", "config.yml", "off: [AGENTS.md]\n");
    expect(await read()).toEqual([
      ["AGENTS", "character", "off"],
      ["AGENTS", "chat", "off"],
      ["WORLD", "chat", "# World\n\nThe chat's world.\n"],
      ["agents/lead", "global", "Lead.\n"],
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
    expect(opened.parts.map((p) => p.part)).toEqual(["ALL-AGENTS", "rules/consent", "rules/perceptions", "SIMULATION", "WRITING", "agents/author", "TURN", "PRESET"]);

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
