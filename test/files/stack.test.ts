// An agent's stack (§5.2): the parts its definition's `reads` names, in §5.2's order whatever order
// `reads` lists them, its definition fifth; the always-on rules it is named in; a template that holds
// only headings and comments left out and said so; the files added for the kind of turn handed over
// for the briefing; a file changed in the middle of a session reaching the next briefing whole, or
// as off; and the snapshot of a block covering every part of it, the reply contract as rendered and
// each tool guide and description too.

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { FrontPart, Stack } from "../../src/files/api";
import { changes, changesText, loadGuidance, snapshot } from "../../src/files/index";
import { openingOf } from "../../src/harness/opening";
import type { HeldTool } from "../../src/tools/registry";
import type { Bench } from "./support";
import { ADDED, bench, drafted, scope } from "./support";

let b: Bench | undefined;
afterEach(async () => {
  await b?.close();
  b = undefined;
});

const brief = (stack: { entries: { part: string; where: string; left?: string; situations?: string[] }[] }) =>
  stack.entries.map((e) => `${e.where}:${e.part}${e.left !== undefined ? `(${e.left})` : ""}${e.situations !== undefined ? `[${e.situations.join(",")}]` : ""}`);

/** A stack's opening files as the block's builder lists them for comparing: each with its text, or why it is left out. */
const front = (stack: Stack): FrontPart[] =>
  stack.entries.flatMap((e) => (e.where !== "opening" ? [] : [{ part: e.part, path: e.path, level: e.level, ...(e.layered === true ? { layered: true as const } : {}), ...(e.text !== undefined ? { text: e.text } : {}), ...(e.left !== undefined ? { left: e.left } : {}) }]));

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
        // Its parts named out of order, and its own file named again by `stack.instructions`.
        ".agents/scribe.md": "---\ndescription: Fixture scribe.\nreads: [TURN, WORLD, AGENTS, rules, ALL-AGENTS]\n---\nFixture scribe: keep the log.\n",
        "config.yml": "stack: { instructions: ['@global/.agents/scribe.md'] }\n",
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
  test("is read at every level that has one, farther first, each its own part; `stack.off` takes all of them; a name not listed is nearest-wins", async () => {
    const tree = await bench({
      global: { "config.yml": "stack: { layered: [AGENTS] }\n", ".agents/lead.md": "---\ndescription: Leads.\nreads: [AGENTS, WORLD]\n---\nLead.\n" },
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
    const opened = snapshot("lead", front(stack));
    await tree.put("chat", "AGENTS.md", "In this chat, the lamp is out.\n");
    expect(changes(opened, front(await loadGuidance(tree.host.files, scope).stack("lead")))).toEqual([{ part: "AGENTS", change: "changed", path: "AGENTS.md", level: "chat", text: "In this chat, the lamp is out.\n" }]);

    await tree.put("chat", "config.yml", "stack: { off: [AGENTS.md] }\n");
    expect(await read()).toEqual([
      ["AGENTS", "character", "off"],
      ["AGENTS", "chat", "off"],
      ["WORLD", "chat", "# World\n\nThe chat's world.\n"],
      ["agents/lead", "global", "Lead.\n"],
    ]);

    await tree.drop("chat", "config.yml");
    await tree.drop("character", "AGENTS.md");
    expect((await read()).filter(([part]) => part === "AGENTS")).toEqual([["AGENTS", "chat", "In this chat, the lamp is out.\n"]]);

    // With no `stack.layered` in any level's config, nothing is layered.
    await tree.put("character", "AGENTS.md", "Wren never lies outright.\n");
    await tree.put("global", "config.yml", "stack: { off: [] }\n");
    expect((await read()).filter(([part]) => part === "AGENTS")).toEqual([["AGENTS", "chat", "In this chat, the lamp is out.\n"]]);
  });
});

describe("a file changed in the middle of a session", () => {
  test("reaches the next briefing as its whole current text, or as switched off, in the notices' words", async () => {
    b = await bench({ shipped: await drafted() });
    const opened = snapshot("author", front(await loadGuidance(b.host.files, scope).stack("author")));
    expect(opened.parts.map((p) => p.part)).toEqual(["ALL-AGENTS", "rules/consent", "rules/perceptions", "SIMULATION", "WRITING", "agents/author", "TURN", "PRESET"]);

    // Nothing changed: nothing to say.
    expect(changes(opened, front(await loadGuidance(b.host.files, scope).stack("author")))).toEqual([]);

    const turn = "# How a turn is run\n\nWeigh what the player wants, then answer in one call.\n";
    await b.put("chat", "TURN.md", turn);
    await b.put("chat", "config.yml", "stack: { off: [WRITING, rules/consent] }\n");
    await b.put("chat", "WORLD.md", "## Premise\n\nA storm is coming.\n");
    const found = changes(opened, front(await loadGuidance(b.host.files, scope).stack("author")));
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
  });

  test("without its notice line the whole text is still given, and an off file goes unsaid", async () => {
    b = await bench({ shipped: await drafted() });
    const opened = snapshot("author", front(await loadGuidance(b.host.files, scope).stack("author")));
    await b.put("chat", "PRESET.md", "Map nothing.\n");
    await b.put("chat", "config.yml", "stack: { off: [SIMULATION] }\n");
    await b.put("global", ".prompts/notices.md", "---\nformat: lines\n---\nprompt_unmapped: Not mapped yet.\n");
    const g = loadGuidance(b.host.files, scope);
    expect(changesText(changes(opened, front(await g.stack("author"))), await g.part("notices"))).toBe("Map nothing.");
  });
});

describe("the snapshot of an opening block", () => {
  test("the snapshot holds the reply contract, each guide and each description with its hash", async () => {
    const contract = "---\ndescription: Fixture contract.\n---\n{{#form.tags}}Reply in tags.{{/form.tags}}{{#form.two_step}}Reply in two steps.{{/form.two_step}}\n";
    b = await bench({
      global: {
        ".agents/lead.md": "---\ndescription: Leads.\nreads: [TURN]\ntools: [file_read]\n---\nLead.\n",
        "TURN.md": "Fixture turn.\n",
        ".prompts/reply-contract.md": contract,
        ".tools/files.md": "---\ndescription: Fixture guide to the file tools.\n---\nFixture files guide.\n",
        ".tools/file_read.md": "---\ndescription: The fixture's file_read as the model is told it.\n---\nFixture file_read description.\n",
      },
    });
    const g = loadGuidance(b.host.files, scope);
    const [definition, part] = await Promise.all([g.definition("lead"), g.part("reply-contract")]);
    if (part?.format !== "template") throw new Error("The fixture contract is not a template.");
    const tool: HeldTool = { name: "file_read", description: "Fixture file_read description.", parameters: { type: "object" }, run: async () => ({ content: [] }), family: "files", tier: "read", from: "rph" };
    const block = await openingOf({ guidance: g, agent: "lead", definition, tools: [tool], isTool: () => false, contract: { part, form: "tags" } });
    const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

    expect(block.snapshot.agent).toBe("lead");
    expect(block.snapshot.parts.map((p) => [p.part, p.path, p.hash])).toEqual([
      ["agents/lead", "@global/.agents/lead.md", hash("Lead.")],
      ["TURN", "@global/TURN.md", hash("Fixture turn.")],
      ["prompts/reply-contract", "@global/.prompts/reply-contract.md", hash("Reply in tags.")],
      ["tools/files", "@global/.tools/files.md", hash("Fixture files guide.")],
      ["tools/file_read", "@global/.tools/file_read.md", hash("Fixture file_read description.")],
    ]);
    // Plain JSON, so the session file keeps it whole.
    expect(JSON.parse(JSON.stringify(block.snapshot))).toEqual(block.snapshot);

    // The contract rendered for the other form is another part's text: a block made so is compared as changed.
    const twoStep = await openingOf({ guidance: g, agent: "lead", definition, tools: [tool], isTool: () => false, contract: { part, form: "two-step" } });
    expect(changes(block.snapshot, twoStep.front)).toEqual([{ part: "prompts/reply-contract", change: "changed", path: "@global/.prompts/reply-contract.md", level: "global", text: "Reply in two steps." }]);
  });
});
