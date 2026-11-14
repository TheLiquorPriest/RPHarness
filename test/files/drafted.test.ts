// The drafted guidance, copied as fixtures, loads whole: every agent definition, instruction file,
// skill, rule (always on, triggered, and the examples), template part and `format: lines` part, and
// none is reported broken. What each holds is read as the plan says.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Guidance } from "../../src/files/index";
import { loadGuidance } from "../../src/files/index";
import type { Bench } from "./support";
import { ADDED, bench, drafted, scope } from "./support";

let b: Bench;
let g: Guidance;

beforeAll(async () => {
  b = await bench({ shipped: await drafted(), global: { "config.yml": ADDED } });
  g = loadGuidance(b.host.files, scope);
});
afterAll(() => b.close());

describe("the drafted guidance", () => {
  test("every file of every kind loads, and none is reported broken", async () => {
    expect(await g.problems()).toEqual([]);
  });

  test("every agent definition, with its header as written", async () => {
    const defs = await g.definitions();
    expect(defs.map((d) => d.name)).toEqual(["assistant", "author", "character", "gm", "historian", "indexer", "keeper", "mapper", "narrator"]);
    for (const d of defs) expect(d).toMatchObject({ level: "shipped", off: false, model: "default" });

    const author = await g.definition("author");
    expect(author).toMatchObject({ effort: "high", reads: ["ALL-AGENTS", "rules", "AGENTS", "WORLD", "SIMULATION", "WRITING", "TURN", "PRESET"], given: ["prompt:*", "session:carry", "briefing"], limits: { calls: 40 } });
    expect(author?.tools).toHaveLength(30);
    expect(author?.instructions.text.startsWith("You are the Author of this story")).toBe(true);

    const gm = await g.definition("gm");
    expect(gm?.given).toEqual(["chat:history[scene]", "prompt:kind(lore)", "story:brief", "world:scene(full, map)", "world:due", "ruleset", "file:scratch/scene.md"]);
    expect((await g.definition("narrator"))?.tools).toEqual([]);
    expect((await g.definition("indexer"))?.reads).toEqual([]);

    // The character's instructions are a template: the character it plays is filled in when the agent starts.
    const character = await g.definition("character");
    expect(character?.instructions.fields).toEqual(["plays"]);
    expect(character?.instructions.render({ plays: "Wren Hale" }).text.startsWith("You are Wren Hale. Not an assistant playing them.")).toBe(true);
  });

  test("every skill is in the index by name and description, and its body is there when asked for", async () => {
    const index = await g.skills();
    expect(index.map((s) => s.name)).toEqual(["bootstrap", "casting", "chapter-pass", "long-input", "places-and-maps", "sandbox", "scene-end"]);
    for (const s of index) expect(s.description.length).toBeGreaterThan(20);
    expect((await g.skill("sandbox"))?.body.startsWith("# Running a moment at the table")).toBe(true);
  });

  test("every rule: always-on and triggered ones in force, the examples listed and never in force", async () => {
    const rules = Object.fromEntries((await g.rules()).map((r) => [r.name, r]));
    expect(Object.keys(rules).sort()).toEqual(
      ["banned-phrases", "consent", "engine-silent", "history-leaving", "memory-nudge", "no-player-voice", "perceptions", "perceptions-missing", "perceptions-owed", "reply-missing", "save-before-compaction", "scene-too-long", "unsourced"].sort(),
    );
    expect(rules.consent).toMatchObject({ trigger: "always", agents: "all", inForce: true });
    expect(rules.perceptions).toMatchObject({ trigger: "always", agents: ["author", "gm"], inForce: true });
    for (const name of ["engine-silent", "history-leaving", "perceptions-missing", "perceptions-owed", "reply-missing", "save-before-compaction"]) expect(rules[name]).toMatchObject({ trigger: "moment", inForce: true });
    expect(rules.unsourced).toMatchObject({ trigger: "pattern", agents: "all", inForce: true });
    expect(rules["banned-phrases"]).toMatchObject({ trigger: "pattern", inForce: false, why: "example" });
    expect(rules["no-player-voice"]).toMatchObject({ trigger: "question", inForce: false, why: "example" });
    expect(rules["memory-nudge"]).toMatchObject({ trigger: "interval", inForce: false, why: "example" });
    expect(rules["scene-too-long"]).toMatchObject({ trigger: "moment", inForce: false, why: "example" });
  });

  test("every prompt part: the templates, and the two that hold one line per name", async () => {
    for (const name of ["briefing", "carried", "compaction", "continue-after-rule", "delegate-brief", "lore-map", "prompt-frame", "question", "reply-contract", "world-state"]) {
      expect((await g.part(name))?.format).toBe("template");
    }
    const notices = await g.part("notices");
    if (notices?.format !== "lines") throw new Error("notices.md is not read as lines");
    expect(notices.names).toEqual(["file_changed", "file_off", "prompt_unmapped", "prompt_shape", "migrated_chat", "unplayed", "edited", "deleted", "swipe_flipped", "job_finished", "job_interrupted", "change_awaiting", "panel_request", "depth_asked", "pictures_left_out", "history_trimmed", "previous_run_stopped"]);
    expect(notices.line("deleted", { count: 2 })).toBe("2 turn(s) were deleted since the last one.");
    const progress = await g.part("progress");
    if (progress?.format !== "lines") throw new Error("progress.md is not read as lines");
    expect(progress.line("still", { elapsed: "2m 10s" })).toBe("Still working (2m 10s).");
    expect(progress.line("no-such-line")).toBeUndefined();
  });

  test("the reply contract's tag names come from its own header", async () => {
    const contract = await g.part("reply-contract");
    if (contract?.format !== "template") throw new Error("reply-contract.md is not a template");
    expect(contract.header.tags).toEqual({ reply: "reply", intent: "intent" });
    const tags = contract.render({ form: { tags: true } }).text;
    expect(tags).toContain("between `<reply>` and `</reply>`");
    expect(tags).not.toContain("scratch/intent.md");
    const twoStep = contract.render({ form: { two_step: true } }).text;
    expect(twoStep).toContain("scratch/intent.md");
    expect(twoStep).not.toContain("`<reply>`");
  });

  test("the briefing's layout shows only the parts that have something in them", async () => {
    const briefing = await g.part("briefing");
    if (briefing?.format !== "template") throw new Error("briefing.md is not a template");
    const { text, missing } = briefing.render({
      turn: { kind: "swipe", speaker: "Wren Hale" },
      asked: ["walk to the lamp room"],
      since: { items: ["Message 41 was edited after its turn."] },
      files_added: "SWIPE text",
    });
    expect(missing).toEqual([]);
    expect(text).toBe(
      "# Briefing for this turn\n\n- This turn: swipe, replying as Wren Hale.\n- The player asked for: walk to the lamp room\n\n## Since the last turn\n\n- Message 41 was edited after its turn.\n\n## Added for this turn\n\nSWIPE text\n",
    );
  });
});
