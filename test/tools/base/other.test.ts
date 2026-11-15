// `skill_load` and `suggest` over the folder host's seed: a skill's text by its name, and a
// suggestion handed to the host for the user while nothing it names is changed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentRef, Suggestion, TurnEvents } from "../../../src/contract";
import { type Bench, bench, type Extra, LEAD, SCOPE, textOf } from "./support";

const SKILL_BODY = "Fixture skill: the tide turns twice a day; count six hours from high water to low.";

let b: Bench;
beforeAll(async () => {
  b = await bench({ ".skills/tide-tables/SKILL.md": `---\nname: tide-tables\ndescription: How the tides of Vell are reckoned.\n---\n${SKILL_BODY}\n` });
});
afterAll(() => b.close());

/** The host's environment with a record of the suggestions it is handed. */
function host(): { extra: Extra; handed: { agent: AgentRef; suggestion: Suggestion }[] } {
  const handed: { agent: AgentRef; suggestion: Suggestion }[] = [];
  const events: TurnEvents = {
    ...b.host.events,
    suggestion: async (scope, agent, suggestion) => {
      handed.push({ agent, suggestion });
      await b.host.events.suggestion(scope, agent, suggestion);
    },
  };
  return { extra: { env: { ...b.host, events } }, handed };
}

describe("skill_load", () => {
  test("gives a skill's whole text by its name", async () => {
    const result = await b.call("skill_load", { name: "tide-tables" });

    expect(result.error).toBeUndefined();
    expect(textOf(result).trim()).toBe(SKILL_BODY);
  });

  test("a name no skill has is said, not thrown", async () => {
    const result = await b.call("skill_load", { name: "star-charts" });

    expect(result.error).toBe(true);
    expect(textOf(result)).toContain("star-charts");
  });
});

describe("suggest", () => {
  test("a suggestion for a file is handed to the host with its text, its reason and who made it, and the file is left as it was", async () => {
    const before = await b.host.files.read(SCOPE, "WORLD.md");
    const { extra, handed } = host();

    const result = await b.call("suggest", { file: "WORLD.md", text: "The harbor freezes solid in deep winter.", reason: "The story has moved into winter." }, { extra });

    expect(result.error).toBeUndefined();
    expect(handed).toEqual([{ agent: LEAD, suggestion: { target: { file: "WORLD.md" }, text: "The harbor freezes solid in deep winter.", reason: "The story has moved into winter." } }]);
    expect(await b.host.files.read(SCOPE, "WORLD.md")).toEqual(before);
  });

  test("a suggestion for a lore entry names the entry; one for an entry the lore does not have is said and not handed on", async () => {
    const { extra, handed } = host();

    await b.call("suggest", { lore: "e-101", text: "Its lamp now burns rapeseed oil.", reason: "The whale oil ran out." }, { extra });
    const missing = await b.call("suggest", { lore: "e-999", text: "A new bell.", reason: "Turn 3 named it." }, { extra });

    expect(handed.map((h) => h.suggestion.target)).toEqual([{ lore: "e-101" }]);
    expect(missing.error).toBe(true);
    expect(textOf(missing)).toContain("e-999");
  });

  test("a suggestion for new lore is handed on as such", async () => {
    const { extra, handed } = host();

    await b.call("suggest", { new_lore: true, text: "The Gannet Stair: steps cut in the cliff below the lighthouse.", reason: "Tamsin climbed them." }, { extra });

    expect(handed.map((h) => h.suggestion.target)).toEqual([{ newLore: true }]);
  });

  test("a suggestion that names no target, or more than one, is said and not handed on", async () => {
    const { extra, handed } = host();

    const none = await b.call("suggest", { text: "Something.", reason: "Because." }, { extra });
    const two = await b.call("suggest", { file: "WORLD.md", lore: "e-101", text: "Something.", reason: "Because." }, { extra });

    expect([none.error, two.error]).toEqual([true, true]);
    expect(handed).toEqual([]);
  });

  test("a file is named as the agents' view has it; a path that leaves the view is said, in the tool answers' words, and not handed on", async () => {
    const { extra, handed } = host();
    const notices = await b.guidance.part("tool-notices");

    const tidied = await b.call("suggest", { file: "notes/../WORLD.md", text: "The harbor freezes.", reason: "Winter." }, { extra });
    const outside = await b.call("suggest", { file: "../other-chat/WORLD.md", text: "The harbor freezes.", reason: "Winter." }, { extra });

    expect(tidied.error).toBeUndefined();
    expect(outside.error).toBe(true);
    const writable = (await b.host.files.places(SCOPE)).writable;
    expect(textOf(outside)).toBe(notices?.format === "lines" ? (notices.line("refused_outside", { path: "../other-chat/WORLD.md", writable }) ?? "") : "no tool answers' file");
    expect(handed.map((h) => h.suggestion.target)).toEqual([{ file: "WORLD.md" }]);
  });
});
