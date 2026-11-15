// The levels (§5.2): shipped, then global, then character, then chat; a file of the same name at a
// nearer level replaces the farther one, whatever its kind; a name switched off in a config stays
// off however often the tree is read again; and a file that does not parse is reported by path and
// line, never stops anything, and is not stood in for by the farther file it replaced. And a
// definition's header (§5.4): read whole, `writer:` with it, by the reader a host imports too, and
// written as the plan writes it, bracketed lists of names that hold brackets of their own included.

import { afterEach, describe, expect, test } from "bun:test";
import type { FileText } from "rp-harness/contract";
import { DEFINITION_FIELDS, parseDefinition } from "rp-harness/helpers";
import { loadGuidance } from "../../src/files/index";
import type { Bench } from "./support";
import { bench, scope } from "./support";

const definition = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\ntools: []\nreads: []\n---\n${body}\n`;
const rule = (description: string, body: string) => `---\ndescription: ${description}\nagents: all\n---\n${body}\n`;

/** The plan's own example of a definition (§5.4, l.506-516), word for word. */
const PLAN_GM = `---
name: gm
description: The engine lane. Give it the scene and what is being attempted. It rules, rolls, stages the consequences, and keeps the map.
model: <a connection profile>
effort: high
tools: [world_query, world_search, world_apply, roll, map_lay, map_edit, map_place, map_view, map_measure, map_door, cast_query, cast_update, perceive, prompt, lore_read, lore_search, chat_read, chat_search, archive_search, story_query, gap_check, file_read, skill_load, todo, tool_search, tool_use, ask_author]
reads: [ALL-AGENTS, rules, WORLD, SIMULATION]
given: [chat:history[scene], prompt:kind(lore), story:brief, world:scene(full, map), world:due, ruleset, file:scratch/scene.md]
limits: { calls: 12 }
---
The agent's instructions, in prose.
`;

let b: Bench | undefined;
afterEach(async () => {
  await b?.close();
  b = undefined;
});

describe("levels", () => {
  test("of every kind, the nearest file of a name is the one in force, and it lists the farther ones it replaces", async () => {
    b = await bench({
      shipped: {
        ".agents/scribe.md": definition("scribe", "Shipped scribe.", "Shipped body."),
        ".rules/tidy.md": rule("Shipped tidy.", "Shipped tidy rule."),
        ".skills/mapping/SKILL.md": "---\nname: mapping\ndescription: Shipped mapping.\n---\nShipped steps.\n",
        ".prompts/frame.md": "Shipped frame.\n",
        ".tools/file_read.md": "Shipped description.\n",
        "WORLD.md": "# World\n\nShipped premise.\n",
      },
      global: {
        ".agents/scribe.md": definition("scribe", "Global scribe.", "Global body."),
        ".rules/tidy.md": rule("Global tidy.", "Global tidy rule."),
        ".skills/mapping/SKILL.md": "---\nname: mapping\ndescription: Global mapping.\n---\nGlobal steps.\n",
        ".prompts/frame.md": "Global frame.\n",
        ".tools/file_read.md": "Global description.\n",
        "WORLD.md": "# World\n\nGlobal premise.\n",
      },
      character: {
        "agents/scribe.md": definition("scribe", "Character scribe.", "Character body."),
        "rules/tidy.md": rule("Character tidy.", "Character tidy rule."),
        "skills/mapping/SKILL.md": "---\nname: mapping\ndescription: Character mapping.\n---\nCharacter steps.\n",
      },
      chat: {
        "agents/scribe.md": definition("scribe", "Chat scribe.", "Chat body."),
        "WORLD.md": "# World\n\nChat premise.\n",
      },
    });
    const g = loadGuidance(b.host.files, scope);
    const scribe = await g.definition("scribe");
    expect(scribe?.description).toBe("Chat scribe.");
    expect(scribe?.source).toMatchObject({ path: "agents/scribe.md", level: "chat" });
    expect(scribe?.replaces).toEqual([
      { level: "shipped", path: "@shipped/.agents/scribe.md" },
      { level: "global", path: "@global/.agents/scribe.md" },
      { level: "character", path: "@character/agents/scribe.md" },
    ]);
    // The folder host has no prompts or tools folders below the global level, so the global ones win.
    const frame = await g.part("frame");
    expect(frame?.format === "template" ? frame.render().text : undefined).toBe("Global frame.\n");
    const tool = await g.tool("file_read");
    expect(tool?.format === "template" ? tool.render().text : undefined).toBe("Global description.\n");
    expect((await g.skill("mapping"))?.body).toBe("Character steps.\n");
    expect((await g.rules()).find((r) => r.name === "tidy")).toMatchObject({ level: "character", description: "Character tidy.", replaces: [{ level: "shipped" }, { level: "global" }] });

    const stack = await loadGuidance(b.host.files, scope).stack("scribe");
    expect(stack.entries).toHaveLength(1);
    await b.put("chat", "agents/scribe.md", definition("scribe", "Chat scribe.", "Chat body.").replace("reads: []", "reads: [WORLD, rules]"));
    const world = (await loadGuidance(b.host.files, scope).stack("scribe")).entries;
    expect(world.map((e) => [e.part, e.level, e.text])).toEqual([
      ["rules/tidy", "character", "Character tidy rule.\n"],
      ["WORLD", "chat", "# World\n\nChat premise.\n"],
      ["agents/scribe", "chat", "Chat body.\n"],
    ]);
  });

  test("a name switched off in a config stays off at every level, read after read, until the config says otherwise", async () => {
    b = await bench({
      shipped: { ".agents/scribe.md": definition("scribe", "Scribe.", "Body."), ".rules/tidy.md": rule("Tidy.", "Keep it tidy."), ".skills/mapping/SKILL.md": "---\nname: mapping\ndescription: Maps.\n---\nSteps.\n" },
      global: { "config.yml": "off: [.rules/tidy.md, '@shipped/.skills/mapping/SKILL.md']\n" },
      chat: { "rules/tidy.md": rule("The chat's own tidy.", "Tidier."), "config.yml": "off:\n  - agents/scribe\n" },
    });
    for (let i = 0; i < 2; i++) {
      const g = loadGuidance(b.host.files, scope);
      expect(await g.definition("scribe")).toBeUndefined();
      expect((await g.definitions()).find((d) => d.name === "scribe")?.off).toBe(true);
      expect((await g.rules()).find((r) => r.name === "tidy")).toMatchObject({ level: "chat", inForce: false, why: "off" });
      expect(await g.skills()).toEqual([]);
      expect(await g.skill("mapping")).toBeUndefined();
      expect((await g.stack("scribe")).entries[0]).toMatchObject({ part: "agents/scribe", left: "off", where: "opening" });
    }
    await b.put("global", "config.yml", "off: []\n");
    await b.put("chat", "config.yml", "# nothing off\n");
    const g = loadGuidance(b.host.files, scope);
    expect((await g.definition("scribe"))?.name).toBe("scribe");
    expect((await g.rules()).find((r) => r.name === "tidy")).toMatchObject({ inForce: true });
    expect((await g.skills()).map((s) => s.name)).toEqual(["mapping"]);
  });

  test("a header that does not parse is reported by path and line; the file is not used, and the farther one does not stand in", async () => {
    b = await bench({
      shipped: { ".agents/scribe.md": definition("scribe", "Shipped scribe.", "Body.") },
      chat: {
        "agents/scribe.md": "---\nname: scribe\ndescription: The chat's scribe.\ntools: [file_read\nreads: []\n---\nBody.\n",
        "rules/loose.md": "---\ndescription: Loose.\nagents: all\nrepeat: twice a day\nat: run-end\n---\nText.\n",
        "rules/open-block.md": "---\ndescription: Open.\nagents: all\n---\nFirst line.\n{{#stage.unperceived}}\nNever closed.\n",
      },
    });
    const g = loadGuidance(b.host.files, scope);
    expect(await g.definition("scribe")).toBeUndefined();
    const problems = await g.problems();
    expect(problems).toContainEqual(expect.objectContaining({ path: "agents/scribe.md", level: "chat", line: 4 }));
    expect(problems.find((p) => p.path === "agents/scribe.md")?.message).toStartWith("Line 4 of the header cannot be read");
    expect(problems).toContainEqual(expect.objectContaining({ path: "rules/loose.md", line: 4, message: expect.stringContaining("`repeat:` is `once per turn`") }));
    expect(problems).toContainEqual(expect.objectContaining({ path: "rules/open-block.md", line: 6, message: expect.stringContaining("never closed") }));
    expect((await g.stack("scribe")).entries[0]).toMatchObject({ part: "agents/scribe", path: "agents/scribe.md", left: "broken" });
    const rules = await g.rules();
    expect(rules.find((r) => r.name === "loose")).toMatchObject({ inForce: false, why: "broken", trigger: "moment", agents: "all" });
    expect(rules.find((r) => r.name === "open-block")).toMatchObject({ inForce: false, why: "broken" });
  });

  test("a field that cannot be read is reported and left out, and the rest of the file is used", async () => {
    b = await bench({ chat: { "agents/scribe.md": "---\nname: scrivener\ndescription: Scribe.\neffort: furious\ntools: [file_read]\nlimits: { calls: 3, time: 90, naps: 2 }\ntemperature: 2\n---\nBody.\n" } });
    const g = loadGuidance(b.host.files, scope);
    const scribe = await g.definition("scribe");
    expect(scribe).toMatchObject({ name: "scribe", tools: ["file_read"], limits: { calls: 3, time: 90_000 } });
    expect(scribe?.effort).toBeUndefined();
    const lines = (await g.problems()).map((p) => p.line);
    expect(lines.sort()).toEqual([2, 4, 6, 7]);
  });

  test("a body that names a field no run fills is reported at its line with the fields a body may name, and the definition is used; one that names what a sub-agent is filled with is not reported", async () => {
    b = await bench({
      chat: {
        "agents/scribe.md": "---\nname: scribe\ndescription: Scribe.\ntools: []\n---\nYou are {{plays}}, {{agent}} of {{definition}}.\n",
        "agents/actor.md": "---\nname: actor\ndescription: Actor.\ntools: []\n---\nFirst line.\nYou are {{character.name}}.\n",
      },
    });
    const g = loadGuidance(b.host.files, scope);
    expect((await g.definition("actor"))?.instructions.render({ plays: "Wren Hale" }).text).toBe("First line.\nYou are .\n");
    expect(await g.problems()).toEqual([expect.objectContaining({ path: "agents/actor.md", level: "chat", line: 7, message: "The body names {{character.name}}, which nothing fills: a body may name {{agent}}, {{definition}}, {{plays}}. It is put in empty." })]);
  });
});

describe("a definition's header", () => {
  test("a definition's `writer:` is read and shown; one naming no definition is a problem", async () => {
    b = await bench({
      shipped: { ".agents/teller.md": definition("teller", "Tells the scene.", "You tell it.") },
      chat: {
        "agents/scribe.md": definition("scribe", "Keeps the record.", "Body.").replace("reads: []", "reads: []\nwriter: teller"),
        "agents/herald.md": definition("herald", "Calls the hour.", "Body.").replace("tools: []", "writer: crier\ntools: []"),
      },
    });
    const g = loadGuidance(b.host.files, scope);
    // A writer at another level is a definition all the same.
    expect((await g.definition("scribe"))?.writer).toBe("teller");
    const views = await g.definitions();
    expect(views.find((d) => d.name === "scribe")).toMatchObject({ writer: "teller" });
    // Code names no writer: a header that names none gives none.
    expect(views.find((d) => d.name === "teller")).not.toHaveProperty("writer");
    expect(await g.problems()).toEqual([expect.objectContaining({ path: "agents/herald.md", level: "chat", line: 4, message: expect.stringContaining('`writer:` names "crier", and no agent definition has that name') })]);
    // The name stays as written, so the page shows what the problem is about.
    expect(views.find((d) => d.name === "herald")).toMatchObject({ writer: "crier" });
  });

  test("the reader exported from RPH's root reads every header field, `writer:` included", () => {
    // A header as a host writes an imported agent's: every field of the list, in its order.
    const values: Record<(typeof DEFINITION_FIELDS)[number], string> = {
      name: "scout",
      description: "Walks ahead and says what it sees.",
      model: "quick",
      effort: "low",
      tools_as: "text",
      tools: "[file_read, todo]",
      out_of_reach: "[maps]",
      reads: "[ALL-AGENTS, rules]",
      given: "[chat:history[scene], world:scene(full, map)]",
      opening: "[map:drawn]",
      limits: "{ calls: 4, time: 30 }",
      writer: "teller",
    };
    const text = `---\n${DEFINITION_FIELDS.map((field) => `${field}: ${values[field]}`).join("\n")}\n---\nYou walk ahead.\n`;
    const lines = text.split("\n").length - 1;
    const file: FileText = { status: "read", path: "imported/agents/scout.md", level: "global", kind: "yours", text, start: 1, end: lines, lines, bytes: Buffer.byteLength(text), hash: "0".repeat(64), modified: 0 };
    const read = parseDefinition(file, "scout", [], new Set(["scout", "teller"]));
    expect(read.problems).toEqual([]);
    expect(read.definition).toMatchObject({
      name: "scout",
      description: "Walks ahead and says what it sees.",
      model: "quick",
      effort: "low",
      toolsAs: "text",
      tools: ["file_read", "todo"],
      outOfReach: ["maps"],
      reads: ["ALL-AGENTS", "rules"],
      given: ["chat:history[scene]", "world:scene(full, map)"],
      opening: ["map:drawn"],
      limits: { calls: 4, time: 30_000 },
      writer: "teller",
    });
    expect(read.definition?.instructions.text).toBe("You walk ahead.\n");
  });

  test("the plan's example header, copied verbatim from §5.4, loads with every `given:` item whole; the one-per-line form loads the same", async () => {
    const given = ["chat:history[scene]", "prompt:kind(lore)", "story:brief", "world:scene(full, map)", "world:due", "ruleset", "file:scratch/scene.md"];
    const tree = await bench({ chat: { "agents/gm.md": PLAN_GM } });
    b = tree;
    const read = async () => {
      const g = loadGuidance(tree.host.files, scope);
      const gm = await g.definition("gm");
      // What the Files page shows of it, and what it does not: its limits and its instructions.
      const loaded = { view: (await g.definitions()).find((d) => d.name === "gm"), limits: gm?.limits, body: gm?.instructions.text };
      return { problems: await g.problems(), gm, loaded };
    };
    const bracketed = await read();
    expect(bracketed.problems).toEqual([]);
    expect(bracketed.gm?.given).toEqual(given);
    expect(bracketed.gm).toMatchObject({ model: "<a connection profile>", effort: "high", reads: ["ALL-AGENTS", "rules", "WORLD", "SIMULATION"], limits: { calls: 12 } });
    expect(bracketed.gm?.tools).toHaveLength(27);

    const oneEach = "given:\n  - chat:history[scene]\n  - prompt:kind(lore)\n  - story:brief\n  - world:scene(full, map)\n  - world:due\n  - ruleset\n  - file:scratch/scene.md";
    await tree.put("chat", "agents/gm.md", PLAN_GM.replace(/^given: .*$/m, oneEach));
    const listed = await read();
    expect(listed.problems).toEqual([]);
    expect(listed.loaded).toEqual(bracketed.loaded);

    // A problem below the list is at its own line in the file: the limits' line 9, or 10 with the list run onto a second line.
    const naps = PLAN_GM.replace("limits: { calls: 12 }", "limits: { calls: 12, naps: 2 }");
    await tree.put("chat", "agents/gm.md", naps);
    expect((await read()).problems).toEqual([expect.objectContaining({ path: "agents/gm.md", line: 9 })]);
    await tree.put("chat", "agents/gm.md", naps.replace("story:brief, ", "story:brief,\n  "));
    const wrapped = await read();
    expect(wrapped.problems).toEqual([expect.objectContaining({ path: "agents/gm.md", line: 10 })]);
    expect(wrapped.gm?.given).toEqual(given);
  });
});
