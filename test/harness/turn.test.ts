// A whole turn on the folder host, under the drafted guidance (§10.2, §10.3, §10.7, §10.11): one
// model call for a simple turn, with the lead's context in its blocks and the prompt's messages in
// the order sent; the intent record told to the host before any tool runs; the reply streamed as it
// is written; a tool nobody registered left out and reported, once in a session; and the turn's
// call limit. Under RPH's own guidance: the reply contract shown again in the briefing where its
// template puts it, and only when its template says so.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TurnRequest } from "../../src/contract";
import { loadGuidance } from "../../src/files";
import { SHIPPED_GUIDANCE } from "../../src/helpers";
import { briefingAround, CONTRACT_MARK, contractFor, gate, PROMPT, request, said, type Stage, stage, textOf, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const INTENT = "Wants: news of the supply boat. Scope: one exchange. Story lane: the storm closes in. Engine lane: nothing changes. Needs: nothing.";

describe("a simple turn", () => {
  test("is exactly one model call, and its first request holds the opening block, the prompt in the order sent, and the briefing", async () => {
    const s = (open = await stage({
      drafted: true,
      answers: [{ pieces: [{ text: `<intent>${INTENT}</intent>` }, { text: "<reply>Wren shakes her head. No boat, not in this sea.</reply>" }, { call: "todo", args: { items: [{ text: "record the missing boat", done: true }], closing: true } }] }],
    }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(outcome).toMatchObject({ status: "released", released: true, reply: "Wren shakes her head. No boat, not in this sea.", form: "tags" });
    expect(s.model.requests).toHaveLength(1);
    // The prompt's earlier replies are not answers to a call of the lead's: one call ended, the one it made.
    expect(s.trace.of("call_ended").map((record) => record.event.call)).toEqual([1]);
    expect(sink.text).toBe("Wren shakes her head. No boat, not in this sea.");
    expect(sink.finished).toHaveLength(1);
    expect(sink.errors).toEqual([]);

    const sent = s.model.requests[0]!.messages;
    // 1. The opening block: the definition, its stack, the reply contract, with the tools declared.
    const opening = sent[0]!;
    expect(opening.role).toBe("system");
    const openingText = textOf(opening);
    expect(openingText).toContain("You are the Author of this story");
    expect(openingText).toContain("# How a turn is run");
    expect(openingText).toContain("# Writing the reply");
    expect(openingText).toContain("whatever the player should see goes between `<reply>` and `</reply>`");
    expect(openingText).not.toContain("Working text goes in files");
    expect(openingText.indexOf("You are the Author")).toBeLessThan(openingText.indexOf("# How a turn is run"));
    // 2. The frame, then every message of the prompt, unchanged, in order, with its role: the note at depth stays in the middle.
    expect(sent[1]!.role).toBe("system");
    expect(textOf(sent[1]!)).toBe("What follows is the prompt the chat application assembled for this reply, exactly as it was sent and in its own order. Its instructions are the contract for whatever is shown to the player.");
    const prompt = sent.slice(2, 2 + PROMPT.length);
    expect(prompt.map((message) => [message.role, textOf(message)])).toEqual(PROMPT.map((message) => [message.role, message.content as string]));
    expect(prompt[5]!.role).toBe("system");
    // 3. What the session carries: in the mode "nothing", with no summary the session opened with, there is nothing to place.
    // 4. The briefing, last.
    expect(sent).toHaveLength(2 + PROMPT.length + 1);
    const briefing = sent[2 + PROMPT.length]!;
    expect(briefing.role).toBe("system");
    expect(textOf(briefing)).toStartWith("# Briefing for this turn");
    expect(textOf(briefing)).toContain("- This turn: new.");

    // The intent record went to the host, then the release, then the run's end.
    expect(s.told.map((told) => told.kind)).toEqual(["intent", "released", "ended"]);
    expect(s.told[0]!.payload).toBe(INTENT);
    expect(s.trace.of("intent").map((record) => record.event.text)).toEqual([INTENT]);
  });

  test("the trace marks the intent record's beginning as its opening tag is read, and its end, the intent, as it closes", async () => {
    const more = gate();
    const s = (open = await stage({ drafted: true, answers: [{ pieces: [{ text: "<intent>Wants: news" }, { hold: more }, { text: " of the boat.</intent><reply>No boat tonight.</reply>" }] }] }));

    const turn = s.turn(request("t1"));
    await s.trace.seen((record) => record.event.kind === "intent_began");
    await s.clock.idle();
    expect(s.trace.of("intent")).toEqual([]);
    more.open();
    expect((await turn).outcome.status).toBe("released");

    const marks = s.trace.records.filter((record) => record.event.kind === "intent_began" || record.event.kind === "intent");
    expect(marks.map((record) => record.event)).toEqual([{ kind: "intent_began" }, { kind: "intent", text: "Wants: news of the boat." }]);
    expect(marks.every((record) => record.agent?.definition === "author" && record.run === marks[0]!.run)).toBe(true);
  });

  test("the reply reaches the sink as it is written, while the model is still writing it", async () => {
    const more = gate();
    const s = (open = await stage({ drafted: true, answers: [{ pieces: [{ text: "<intent>Short.</intent><reply>The lamp gutters." }, { hold: more }, { text: " Wren swears softly.</reply>" }] }] }));
    const sink = new WatchedSink(s.clock);

    const turn = s.turn(request("t1"), sink);
    await sink.until(() => sink.text !== "");
    await s.clock.idle();
    expect(sink.text).toBe("The lamp gutters.");
    expect(sink.finished).toHaveLength(0);
    more.open();
    await turn;

    expect(sink.pieces.map((piece) => piece.text)).toEqual(["The lamp gutters.", " Wren swears softly."]);
    expect(sink.finished).toHaveLength(1);
  });

  test("a request that carries no prompt is given no frame introducing one; one that carries a prompt is", async () => {
    /** Whether any message of a stage's first request holds the frame part's words, rendered from the file in force. */
    const framed = async (prompt: TurnRequest["prompt"]): Promise<boolean> => {
      const s = (open = await stage({ answers: [{ pieces: [{ text: "<reply>Settled.</reply>" }] }] }));
      const part = await loadGuidance(s.env.files, request("t1").scope).part("prompt-frame");
      const frame = part?.format === "template" ? part.render().text.trim() : "";
      if (frame === "") throw new Error("The stage has no frame part.");
      await s.turn(request("t1", { lead: "lead", prompt }));
      const holds = s.model.requests[0]!.messages.some((message) => textOf(message).includes(frame));
      await s.close();
      open = undefined;
      return holds;
    };

    expect(await framed([])).toBe(false);
    expect(await framed(PROMPT)).toBe(true);
  });
});

describe("where the reply contract is shown", () => {
  test("RPH's own briefing carries it: the contract, rendered for the connection's form, is in the opening block and again, word for word, where the briefing's template puts it", async () => {
    const s = (open = await stage({ answers: [{ pieces: [{ text: "<reply>No boat tonight.</reply>" }] }] }));

    await s.turn(request("t1", { lead: "lead" }));

    const contract = await contractFor(s, "tags");
    const sent = s.model.requests[0]!.messages;
    expect(textOf(sent[0]!)).toContain(contract);
    expect(textOf(sent[0]!)).not.toContain(await contractFor(s, "two_step"));
    expect(textOf(sent.at(-1)!)).toBe((await briefingAround()).replace(CONTRACT_MARK, contract));
  });

  test("a briefing template with the field taken out leaves the contract in the opening block only", async () => {
    const shipped = await Bun.file(join(SHIPPED_GUIDANCE, ".prompts", "briefing.md")).text();
    const without = shipped.replace(/\{\{#reply_contract\}\}[\s\S]*\{\{\/reply_contract\}\}\n?/, "");
    expect(without).not.toContain("{{reply_contract}}");
    const s = (open = await stage({ files: { ".prompts/briefing.md": without }, answers: [{ pieces: [{ text: "<reply>No boat tonight.</reply>" }] }] }));

    await s.turn(request("t1", { lead: "lead" }));

    const contract = await contractFor(s, "tags");
    const sent = s.model.requests[0]!.messages;
    expect(textOf(sent[0]!)).toContain(contract);
    const briefing = textOf(sent.at(-1)!);
    expect(briefing).not.toBe("");
    expect(briefing).not.toContain(contract);
  });

  test("in the two-step form, where the lead writes its intent record to a file itself, the briefing gives that file's whole path; in the tag form it does not", async () => {
    /** The whole path of the intent record's file in a stage's turn: the turn's folder, and the file the reply contract's header names. */
    const intentPath = async (s: Stage, scope: TurnRequest["scope"]): Promise<string> => {
      const contract = await loadGuidance(s.env.files, scope).part("reply-contract");
      const file = contract?.format === "template" ? contract.header["intent_file"] : undefined;
      const turn = (await s.env.files.places(scope)).turn;
      if (typeof file !== "string" || turn === undefined) throw new Error("The shipped reply contract names no intent file, or the turn has no folder.");
      return `${turn}${file}`;
    };
    const twoStep = (open = await stage({ config: "reply:\n  form: two-step\n", answers: [{ pieces: [{ text: "No boat tonight." }] }] }));
    const first = request("t1", { lead: "lead" });
    await twoStep.turn(first);
    const whole = await intentPath(twoStep, first.scope);
    expect(textOf(twoStep.model.requests[0]!.messages.at(-1)!)).toContain(whole);
    await twoStep.close();

    const tags = (open = await stage({ answers: [{ pieces: [{ text: "<reply>No boat tonight.</reply>" }] }] }));
    const second = request("t1", { lead: "lead" });
    await tags.turn(second);
    const briefing = textOf(tags.model.requests[0]!.messages.at(-1)!);
    expect(briefing).toContain((await tags.env.files.places(second.scope)).turn ?? "no turn folder");
    expect(briefing).not.toContain(await intentPath(tags, second.scope));
  });
});

describe("a rule on what the lead writes", () => {
  test("on its text, and stopping the call, holds the reply back by a sentence in the tag form, so what it matches inside the reply is never shown", async () => {
    const s = (open = await stage({
      files: { ".rules/fixture-shiver.md": "---\ndescription: Fixture - no shivers.\nagents: [lead]\ncondition: shiver ran down\nscope: [text]\n---\nFixture rule: that phrase is worn out.\n" },
      answers: [{ pieces: [{ text: "<reply>The hall is dark. A shiver" }, { text: " ran down her spine.</reply>" }] }, { pieces: [{ text: "<reply>She runs.</reply>" }] }],
    }));

    const { outcome, sink } = await s.turn(request("t1", { lead: "lead" }));

    expect(outcome.status).toBe("released");
    expect(s.trace.of("rule_fired").map((record) => [record.event.firing.rule, record.event.firing.action])).toEqual([["fixture-shiver", "cut"]]);
    expect(sink.text).toStartWith("The hall is dark.");
    expect(sink.text).not.toContain("shiver");
  });
});

describe("the lead's tools", () => {
  test("a tool its definition names that nobody registered is left out and reported, and the turn still runs", async () => {
    const s = (open = await stage({
      drafted: true,
      tools: { world_query: { tier: "read", description: "Fixture: reads the world.", run: async () => said("calm") } },
      answers: [{ pieces: [{ text: "<reply>Calm, for now.</reply>" }] }],
    }));

    const { outcome } = await s.turn(request("t1"));

    expect(outcome.status).toBe("released");
    const declared = s.model.requests[0]!.tools.map((tool) => tool.name).sort();
    expect(declared).toEqual(["agent_message", "archive_search", "chat_read", "chat_search", "delegate", "file_find", "file_read", "file_write", "gap_check", "job_start", "lore_read", "lore_search", "prompt", "reply_release", "skill_load", "suggest", "todo", "tool_search", "tool_use", "web_search", "world_query", "write_reply"]);
    const reported = s.logged.find((line) => line.level === "warn" && line.message.startsWith("Tools the lead's definition lists are registered by nobody"));
    expect(reported?.fields?.["tools"]).toContain("roll");
    // The folder host now registers the searches of other stores and of the web too.
    expect(reported?.fields?.["tools"]).not.toContain("archive_search");
    expect(reported?.fields?.["tools"]).not.toContain("delegate");
    expect(reported?.fields?.["tools"]).not.toContain("world_query");
  });

  // hardening
  test.skip("a tool nobody registered is reported once, when the session opens: not again on its later turns, and again for another session", async () => {
    const s = (open = await stage({ answers: Array.from({ length: 3 }, () => ({ pieces: [{ text: "<reply>Calm, for now.</reply>" }] })) }));
    const warnings = (): unknown[] => s.logged.filter((line) => line.level === "warn" && line.message.startsWith("Tools the lead's definition lists are registered by nobody")).map((line) => line.fields?.["tools"]);

    for (const req of [request("t1", { lead: "lead" }), request("t2", { lead: "lead", parent: "t1" })]) expect((await s.turn(req)).outcome.status).toBe("released");
    // RPH's own lead names the searches of the host's other stores and of the web, which the folder host does not offer.
    expect(warnings()).toEqual([["archive_search", "web_search"]]);

    const other = request("u1", { lead: "lead" });
    expect((await s.turn({ ...other, scope: { ...other.scope, session: "s2" } })).outcome.status).toBe("released");
    expect(warnings()).toEqual([["archive_search", "web_search"], ["archive_search", "web_search"]]);
  });
});

describe("limits", () => {
  test("the turn's call limit holds: the call past it is never made, and the host is told which limit, with the lead's last plain text", async () => {
    const s = (open = await stage({
      drafted: true,
      config: "limits:\n  turn:\n    calls: 2\n",
      tools: { world_query: { tier: "read", description: "Fixture: reads the world.", run: async () => said("still calm") } },
      answers: Array.from({ length: 4 }, (_, i) => ({ pieces: [{ text: `Checking the sea, ${i + 1}.` }, { call: "world_query" }] })),
    }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(s.model.requests).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "limit", released: false, limit: { limit: "calls", per: "turn", max: 2, value: 2 } });
    expect(sink.errors).toEqual([{ code: "limit", limit: { limit: "calls", per: "turn", max: 2, value: 2 }, text: "Checking the sea, 2." }]);
    expect(s.told.at(-1)?.kind).toBe("ended");
  });

  test("a limit an agent names for file_find is held to the player's most a call takes", async () => {
    const notes = Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [`chats/wren-hale/lighthouse/persistent-workspace/${name}.md`, `Fixture note ${name}.`]));
    const s = (open = await stage({
      config: "tools:\n  perCall: 2\n",
      files: { ".agents/chief.md": "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [file_find]\ngiven: [prompt:*]\n---\nFixture chief.\n", ...notes },
      answers: [{ pieces: [{ call: "file_find", args: { by: "list", path: "persistent-workspace", limit: 1000 }, id: "f-1" }] }, { pieces: [{ text: "<reply>Two notes.</reply>" }] }],
    }));

    await s.turn(request("t1", { lead: "chief" }));

    // Two hits, then the line that says the search stopped at the player's most.
    const found = s.model.requests[1]!.messages.find((message) => message.role === "toolResult" && message.toolCallId === "f-1");
    const lines = textOf(found!).split("\n");
    expect(lines.filter((line) => line.includes("persistent-workspace/"))).toHaveLength(2);
    expect(lines.at(-1)).toContain("2");
  });
});
