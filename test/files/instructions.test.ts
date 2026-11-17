// `stack.instructions` in a level's config (§5.2: "A chat's `RPE.yml` can add more files to a stack with
// an `instructions:` list, the way OpenCode's config does"): a list reaches every agent whose
// definition reads an instruction file, a mapping only the agents it names; its files come after
// part 4 and before the definition, the farther level's first, each file once; and an entry that
// finds only agents' notes or generated files is reported and adds nothing.

import { afterEach, expect, test } from "bun:test";
import type { Problem, Stack } from "../../src/files/index";
import { loadGuidance } from "../../src/files/index";
import type { Bench } from "./support";
import { bench, scope } from "./support";

let b: Bench | undefined;
afterEach(async () => {
  await b?.close();
  b = undefined;
});

const brief = (stack: Stack) => stack.entries.map((e) => `${e.part}${e.left !== undefined ? `(${e.left})` : ""}`);
const agent = (reads: string) => `---\ndescription: Fixture agent.\nreads: ${reads}\n---\nFixture body.\n`;

test("a list reaches every agent that reads instruction files, after WORLD and before the definition; a mapping only the agent it names; the nearer level's after the farther's; `stack.off` takes one out; an entry naming a notes file is a problem and adds nothing", async () => {
  b = await bench({
    global: {
      "config.yml": "stack: { instructions: [STYLE, '@global/house/*.md'] }\n",
      ".agents/scribe.md": agent("[TURN, WORLD]"),
      ".agents/narrator.md": agent("[WRITING]"),
      ".agents/keeper.md": agent("[]"),
      ".agents/sorter.md": agent("[rules]"),
      "STYLE.md": "Short sentences, past tense.\n",
      "house/places.md": "The lamp room is above the stores.\n",
      "house/canon.md": "The lamp has never once gone out.\n",
      "WORLD.md": "Gannet Rock, one winter.\n",
      "TURN.md": "Weigh what the player wants.\n",
    },
    chat: {
      "config.yml": "stack:\n  off: ['@global/house/places.md']\n  instructions:\n    scribe: [house/scene.md, STYLE.md, persistent-workspace/notes.md]\n    keeper: [house/scene.md]\n",
      "house/scene.md": "Tonight: the storm, the boat that did not come.\n",
      "persistent-workspace/notes.md": "The boat is two days late.\n",
    },
  });
  const g = loadGuidance(b.host.files, scope);

  const scribe = await g.stack("scribe");
  expect(brief(scribe)).toEqual(["WORLD", "STYLE", "@global/house/canon.md", "@global/house/places.md(off)", "house/scene.md", "agents/scribe", "TURN"]);
  expect(scribe.entries.slice(1, 5).map((e) => [e.level, e.text])).toEqual([
    ["global", "Short sentences, past tense.\n"],
    ["global", "The lamp has never once gone out.\n"],
    ["global", undefined],
    ["chat", "Tonight: the storm, the boat that did not come.\n"],
  ]);
  expect(brief(await g.stack("narrator"))).toEqual(["WRITING(missing)", "STYLE", "@global/house/canon.md", "@global/house/places.md(off)", "agents/narrator"]);
  expect(brief(await g.stack("keeper"))).toEqual(["house/scene.md", "agents/keeper"]);
  expect(brief(await g.stack("sorter"))).toEqual(["agents/sorter"]);

  const notes: Problem = { path: "config.yml", level: "chat", line: 4, message: "`stack.instructions` names persistent-workspace/notes.md, which finds only agents' notes or generated files. Those are not instructions, so it adds nothing." };
  expect(await g.problems()).toEqual([notes]);
  expect(scribe.problems).toEqual([notes]);
  expect((await g.stack("keeper")).problems).toEqual([]);
});

test("an entry finding only generated files or nothing, a list for an agent no definition has, and a value that is no list are each said, and add nothing", async () => {
  b = await bench({
    global: { "config.yml": "stack: { instructions: 3 }\n", ".agents/scribe.md": agent("[WORLD]"), "WORLD.md": "Gannet Rock.\n" },
    chat: {
      "config.yml": "stack:\n  instructions:\n    scribe: [PROMPT-MAP, 'persistent-workspace/*.md', 'house/*.md']\n    scrib: [WORLD]\n",
      "PROMPT-MAP.md": "Fixture prompt map.\n",
      "persistent-workspace/notes.md": "The boat is two days late.\n",
    },
  });
  const g = loadGuidance(b.host.files, scope);

  expect(brief(await g.stack("scribe"))).toEqual(["WORLD", "agents/scribe"]);
  // Each is found as its entry is read, so the order they come in says nothing.
  expect((await g.problems()).map((p) => `${p.path}:${p.line} ${p.message}`).sort()).toEqual([
    "@global/config.yml:1 `stack.instructions` is a list of files added to the stack of every agent that reads instruction files, `stack: { instructions: [STYLE, house/canon.md] }`, or such a list for each agent by name: `stack: { instructions: { gm: [house/rules.md] } }`.",
    "config.yml:3 `stack.instructions` names PROMPT-MAP, which finds only agents' notes or generated files. Those are not instructions, so it adds nothing.",
    "config.yml:3 `stack.instructions` names house/*.md, and no file matches it, so it adds nothing.",
    "config.yml:3 `stack.instructions` names persistent-workspace/*.md, which finds only agents' notes or generated files. Those are not instructions, so it adds nothing.",
    "config.yml:4 `stack.instructions` gives a list to scrib, and no agent definition has that name, so the list reaches no stack.",
  ]);
});
