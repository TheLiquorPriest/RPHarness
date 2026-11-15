// `delegate` (§13.4, §10.5): a sub-agent starts from its definition (its own model, effort, tools
// and instructions) on the lead's brief, laid out by the brief's part with everything it is given
// in full, and nothing of the lead's conversation; its last message is the lead's answer. What it is
// given by name is found, kept with the turn, and what cannot be found is said. How deep and how
// many are the user's settings.
import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { CHARACTER, CHAT, definition, said, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const SCENE = "# The lamp room\n\nThe gap to the far ledge is twenty feet. The rail on the near side is rotten.\n";
const LEDGE = "The far ledge of Gannet Rock is a shelf of wet basalt, never climbed since the old keeper fell.";
const PLAYER = "She leaps for the far ledge.";

const LEAD = definition("lead", { model: "lead-model", tools: ["delegate", "agent_message", "file_read"] }, "Fixture lead: you run the turn.");
const GM = definition("gm", { model: "gm-model", effort: "high", tools: ["file_read", "ask_author", "roll"], reads: ["rules"] }, "Fixture GM: rule on what you are asked, from what you are given.");
const CHAT_FOLDER = `chats/${CHARACTER}/${CHAT}`;

function toolResults(messages: readonly Message[]): string[] {
  return messages.filter((message) => message.role === "toolResult").map(textOf);
}

describe("delegate", () => {
  test("starts the sub-agent its definition describes, on the brief with both attachments in full, and its last message answers the lead", async () => {
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/gm.md": GM, [`${CHAT_FOLDER}/persistent-workspace/scene.md`]: SCENE },
      lore: [{ id: "e-112", source: "Fixture book", title: "The far ledge", keys: ["ledge"], text: LEDGE }],
      tools: { roll: { tier: "read", description: "Fixture: rolls dice.", run: async () => said("4") } },
      models: {
        "lead-model": [
          { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Can she make the jump to the far ledge?", attach: ["file:persistent-workspace/scene.md", "lore:e-112"] }, id: "d-1" }] },
          { pieces: [{ text: "Settled." }] },
        ],
        "gm-model": [{ pieces: [{ text: "At twenty feet the jump fails." }] }],
      },
    }));

    const turn = await s.play(PLAYER);
    const outcome = await turn.done;

    expect(outcome.status).toBe("done");
    const [first] = s.models["gm-model"]!.requests;
    if (first === undefined) throw new Error("The GM was never called.");
    // Its own model, its own tools, as its definition lists them.
    expect(first.model).toBe("gm-model");
    expect(first.tools.map((tool) => tool.name)).toEqual(["file_read", "ask_author", "roll"]);
    // Its own instructions, in §5.2's order: the rules it reads, then its definition.
    const system = first.messages[0];
    expect(system?.role).toBe("system");
    expect(textOf(system ?? { content: "" })).toContain("Fixture GM: rule on what you are asked");
    expect(textOf(system ?? { content: "" })).toContain("# Do not fill gaps on your own");
    expect(textOf(system ?? { content: "" })).not.toContain("Fixture lead");
    // The brief in its frame, then both attachments whole, in the order named; none of the lead's conversation.
    expect(first.messages).toHaveLength(2);
    const brief = textOf(first.messages[1] ?? { content: "" });
    expect(brief).toContain("## Your task\n\nCan she make the jump to the far ledge?");
    const task = brief.indexOf("Can she make the jump");
    const scene = brief.indexOf(`### file:persistent-workspace/scene.md\n\n${SCENE.trimEnd()}`);
    const ledge = brief.indexOf(`### lore:e-112\n\nThe far ledge (Fixture book)\n\n${LEDGE}`);
    expect(task).toBeGreaterThan(-1);
    expect(scene).toBeGreaterThan(task);
    expect(ledge).toBeGreaterThan(scene);
    expect(JSON.stringify(first.messages)).not.toContain(PLAYER);
    // Its effort, its session, and the call it hangs under.
    const started = s.trace.of("agent_started").find((record) => record.agent.id === "gm-1");
    expect(started?.event).toMatchObject({ definition: "gm", model: "gm-model", connection: "gm-model", effort: "high", given: ["file:persistent-workspace/scene.md", "lore:e-112"] });
    expect(started?.event.session).not.toBe("s1");
    expect(started?.agent).toEqual({ id: "gm-1", definition: "gm", parent: turn.lead.id });
    expect(started?.parent).toEqual({ agent: turn.lead.id, run: "t1", call: "d-1" });
    // Its last message is the lead's answer, under the name it goes by.
    expect(toolResults(s.models["lead-model"]!.requests[1]!.messages)).toEqual(["gm-1 answered:\n\nAt twenty feet the jump fails."]);
    // The list is kept with the turn by the host.
    const kept = (await s.kept("events")).filter((line) => line["kind"] === "attachments");
    expect(kept).toEqual([
      expect.objectContaining({
        agent: { id: "gm-1", definition: "gm", parent: turn.lead.id },
        refs: [
          { ref: "file:persistent-workspace/scene.md", from: "delegate", own: true },
          { ref: "lore:e-112", from: "delegate", own: true },
        ],
      }),
    ]);
  });

  test("gives a stretch of the chat and a view of the host by name, takes its definition's own, and says what could not be found", async () => {
    const gm = definition("gm", { model: "gm-model", tools: ["file_read", "ask_author"], given: ["world:scene"] }, "Fixture GM.");
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/gm.md": gm, [`${CHAT_FOLDER}/sessions/s1/turns/t1/scratch/plan.md`]: "Fixture plan: the jump first.\n" },
      messages: [
        { role: "user", name: "Mara", text: "We climb the stairs." },
        { role: "assistant", name: "Wren Hale", text: "The lamp turns above you." },
        { role: "user", name: "Mara", text: "I look across the gap." },
        { role: "assistant", name: "Wren Hale", text: "The far ledge glistens in the rain." },
        { role: "user", name: "Mara", text: PLAYER, hidden: true },
      ],
      ranges: { scene: { from: 2, to: 5 } },
      views: { "world:scene": "Fixture view: the lamp room; the storm breaks within the hour." },
      models: {
        "lead-model": [{ pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump.", attach: ["chat:history[scene]", "lore:e-999", "file:scratch/plan.md", "file:persistent-workspace/none.md"] }, id: "d-1" }] }, { pieces: [{ text: "Settled." }] }],
        "gm-model": [{ pieces: [{ text: "It fails." }] }],
      },
    }));

    await (await s.play("Go on.")).done;

    const brief = textOf(s.models["gm-model"]!.requests[0]!.messages[1] ?? { content: "" });
    // The definition's own first, then the lead's, each whole under its name; a turn's file named from the turn's folder.
    expect(brief).toContain("### world:scene\n\nFixture view: the lamp room; the storm breaks within the hour.\n\n### chat:history[scene]\n\n#2 Mara: I look across the gap.\n\n#3 Wren Hale: The far ledge glistens in the rain.\n\n#4 Mara (hidden):\n\n### file:scratch/plan.md\n\nFixture plan: the jump first.");
    // What nobody could give is said in the lead's answer, in the file's words, and the answer is not clean.
    const answer = s.models["lead-model"]!.requests[1]!.messages.find((message) => message.role === "toolResult");
    expect(textOf(answer ?? { content: "" })).toBe("gm-1 answered:\n\nIt fails.gm-1 was not given lore:e-999: it could not be found.gm-1 was not given file:persistent-workspace/none.md: it could not be found.");
    expect(s.trace.of("tool_ended").find((record) => record.event.callId === "d-1")?.event.clean).toBe(false);
    // The host is told the whole list: what RPH found itself, and what it asked the host for.
    const told = s.told.find((item) => item.kind === "attachments");
    expect(told?.kind === "attachments" ? told.refs : []).toEqual([
      { ref: "world:scene", from: "definition", own: false },
      { ref: "chat:history[scene]", from: "delegate", own: true },
      { ref: "lore:e-999", from: "delegate", own: true },
      { ref: "file:scratch/plan.md", from: "delegate", own: true },
      { ref: "file:persistent-workspace/none.md", from: "delegate", own: true },
    ]);
  });

  test("how deep and how many are the player's settings: past either, nobody is started and the call says which", async () => {
    const gm = definition("gm", { model: "gm-model", tools: ["delegate"] }, "Fixture GM.");
    const keeper = definition("keeper", { model: "keeper-model", tools: [] }, "Fixture keeper.");
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/gm.md": gm, ".agents/keeper.md": keeper, "config.yml": "limits:\n  turn:\n    depth: 1\n    agents: 1\n" },
      models: {
        "lead-model": [
          { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump." }, id: "d-1" }] },
          { pieces: [{ call: "delegate", args: { agent: "keeper", brief: "Note the jump." }, id: "d-2" }] },
          { pieces: [{ text: "Settled." }] },
        ],
        "gm-model": [{ pieces: [{ call: "delegate", args: { agent: "keeper", brief: "Check the rail." }, id: "d-3" }] }, { pieces: [{ text: "It fails." }] }],
        "keeper-model": [],
      },
    }));

    const outcome = await (await s.play(PLAYER)).done;

    expect(outcome.status).toBe("done");
    expect(s.models["keeper-model"]!.requests).toHaveLength(0);
    expect(toolResults(s.models["gm-model"]!.requests[1]!.messages)).toEqual(["keeper was not started: it would stand 2 deep, and the player allows 1."]);
    expect(toolResults(s.models["lead-model"]!.requests[2]!.messages).at(-1)).toBe("keeper was not started: this turn has started 1 agents, and the player allows 1.");
    expect(s.trace.of("limit").map((record) => [record.agent.id, record.event.hit])).toEqual([
      ["gm-1", { limit: "depth", per: "turn", max: 1, value: 2 }],
      [expect.any(String), { limit: "agents", per: "turn", max: 1, value: 1 }],
    ]);
  });

  test("calls made in one step cannot pass the count together", async () => {
    const keeper = definition("keeper", { model: "keeper-model", tools: [] }, "Fixture keeper.");
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/keeper.md": keeper, "config.yml": "limits:\n  turn:\n    agents: 2\n" },
      models: {
        "lead-model": [{ pieces: [1, 2, 3].map((n) => ({ call: "delegate", args: { agent: "keeper", brief: `Note thing ${n}.` }, id: `d-${n}` })) }, { pieces: [{ text: "Settled." }] }],
        "keeper-model": [{ pieces: [{ text: "Noted." }] }, { pieces: [{ text: "Noted." }] }],
      },
    }));

    const outcome = await (await s.play(PLAYER)).done;

    expect(outcome.status).toBe("done");
    expect(s.models["keeper-model"]!.requests).toHaveLength(2);
    expect(toolResults(s.models["lead-model"]!.requests[1]!.messages).sort()).toEqual(["keeper was not started: this turn has started 2 agents, and the player allows 2.", "keeper-1 answered:\n\nNoted.", "keeper-2 answered:\n\nNoted."]);
  });

  test("a stretch of the chat an agent is given holds no more messages than the player lets one call take", async () => {
    const gm = definition("gm", { model: "gm-model", tools: [] }, "Fixture GM.");
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/gm.md": gm, "config.yml": "tools:\n  perCall: 2\n" },
      messages: [
        { role: "user", name: "Mara", text: "Fixture line zero." },
        { role: "assistant", name: "Wren Hale", text: "Fixture line one." },
        { role: "user", name: "Mara", text: "Fixture line two." },
        { role: "assistant", name: "Wren Hale", text: "Fixture line three." },
        { role: "user", name: "Mara", text: "Fixture line four." },
      ],
      ranges: { scene: { from: 1, to: 5 } },
      models: {
        "lead-model": [{ pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule.", attach: ["chat:history[-30:]", "chat:history[#0..#4]", "chat:history[scene]"] }, id: "d-1" }] }, { pieces: [{ text: "Settled." }] }],
        "gm-model": [{ pieces: [{ text: "Ruled." }] }],
      },
    }));

    await (await s.play(PLAYER)).done;

    const brief = textOf(s.models["gm-model"]!.requests[0]!.messages[1] ?? { content: "" });
    // The last few are the newest; any other stretch stops at the bound from its start.
    expect(brief).toContain("### chat:history[-30:]\n\n#3 Wren Hale: Fixture line three.\n\n#4 Mara: Fixture line four.\n\n### chat:history[#0..#4]\n\n#0 Mara: Fixture line zero.\n\n#1 Wren Hale: Fixture line one.\n\n### chat:history[scene]\n\n#1 Wren Hale: Fixture line one.\n\n#2 Mara: Fixture line two.");
    expect(brief).not.toContain("Fixture line two.\n\n#3");
  });

  test("a sub-agent that could not go on is said to have had its model fail only when its model did", async () => {
    const gm = definition("gm", { model: "gm-model", tools: [] }, "Fixture GM.");
    const files = { ".agents/lead.md": LEAD, ".agents/gm.md": gm };
    const lead = { "lead-model": [{ pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule." }, id: "d-1" }] }, { pieces: [{ text: "Settled." }] }] };

    const model = (open = await stage({ files, models: { ...lead, "gm-model": [{ pieces: [{ text: "Half a ru" }], end: { error: "Fixture provider error: overloaded." } }] } }));
    await (await model.play(PLAYER)).done;
    expect(toolResults(model.models["lead-model"]!.requests[1]!.messages)).toEqual(["gm-1 could not go on: a call to its model failed."]);
    await model.close();

    // RPH's own work broke under the sub-agent: the trace it writes through would not take its calls.
    const harness = (open = await stage({ files, models: { ...lead, "gm-model": [{ pieces: [{ text: "Ruled." }] }] } }));
    const record = harness.trace.event.bind(harness.trace);
    harness.trace.event = (one) => {
      if (one.agent.id === "gm-1" && (one.event.kind === "call_started" || one.event.kind === "call_ended")) throw new Error("Fixture: the trace takes no more.");
      record(one);
    };
    await (await harness.play(PLAYER)).done;
    expect(toolResults(harness.models["lead-model"]!.requests[1]!.messages)).toEqual(["gm-1 could not go on: the system that runs it failed."]);
  });

  test("a lore entry an agent is given is marked with who may know it; one the agent may not know is not given, and the host is not asked for it", async () => {
    const gm = definition("gm", { model: "gm-model", tools: [] }, "Fixture GM.");
    const character = definition("character", { model: "character-model", tools: [] }, "Fixture character.");
    const s = (open = await stage({
      files: { ".agents/lead.md": LEAD, ".agents/gm.md": gm, ".agents/character.md": character },
      lore: [{ id: "w-31", source: "Fixture world", title: "The keeper's fall", keys: ["keeper"], text: "The old keeper was pushed.", knowing: { by: "characters", names: ["Wren Hale"] } }],
      // A host that would give a text for the name, were it asked.
      views: { "lore:w-31": "Fixture view: the old keeper was pushed." },
      models: {
        "lead-model": [
          {
            pieces: [
              { call: "delegate", args: { agent: "gm", brief: "Rule.", attach: ["lore:w-31"] }, id: "d-1" },
              { call: "delegate", args: { agent: "character", brief: "Speak.", attach: ["lore:w-31"], plays: "Mara" }, id: "d-2" },
            ],
          },
          { pieces: [{ text: "Settled." }] },
        ],
        "gm-model": [{ pieces: [{ text: "Ruled." }] }],
        "character-model": [{ pieces: [{ text: "Spoken." }] }],
      },
    }));

    await (await s.play(PLAYER)).done;

    expect(textOf(s.models["gm-model"]!.requests[0]!.messages[1] ?? { content: "" })).toContain("### lore:w-31\n\nThe keeper's fall (Fixture world)\n\nKnown only to Wren Hale.\n\nThe old keeper was pushed.");
    expect(textOf(s.models["character-model"]!.requests[0]!.messages[1] ?? { content: "" })).not.toContain("pushed");
    const told = s.told.flatMap((item) => (item.kind === "attachments" && item.agent.plays === "Mara" ? item.refs : []));
    expect(told).toEqual([{ ref: "lore:w-31", from: "delegate", own: true }]);
  });
});
