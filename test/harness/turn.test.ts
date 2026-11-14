// A whole turn on the folder host, under the drafted guidance (§10.2, §10.3, §10.7, §10.11): one
// model call for a simple turn, with the lead's context in its blocks and the prompt's messages in
// the order sent; the intent record told to the host before any tool runs; the reply streamed as it
// is written; a tool nobody registered left out and reported; and the turn's call limit.
import { afterEach, describe, expect, test } from "bun:test";
import { gate, PROMPT, request, said, type Stage, stage, textOf, WatchedSink } from "./support";

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

  test("the intent record reaches the host before any tool runs, even when the host is slow to take it", async () => {
    const kept = gate();
    const order: string[] = [];
    const s = (open = await stage({
      drafted: true,
      tools: { world_query: { tier: "read", description: "Fixture: reads the world.", run: async () => (order.push("tool:world_query"), said("The boat is overdue by two days.")) } },
      events: (inner) => ({
        ...inner,
        intent: async (scope, text) => {
          await kept.opened;
          order.push("intent:kept");
          return inner.intent(scope, text);
        },
      }),
      answers: [{ pieces: [{ text: `<intent>${INTENT}</intent>` }, { call: "world_query" }] }, { pieces: [{ text: "<reply>Overdue, Wren says. Two days now.</reply>" }] }],
    }));

    const turn = s.turn(request("t1"));
    // The tool's call has begun, and everything that could happen without the host has happened: the tool has not run.
    await s.trace.seen((record) => record.event.kind === "tool_started");
    await s.clock.idle();
    expect(order).toEqual([]);
    kept.open();
    const { outcome } = await turn;

    expect(outcome.status).toBe("released");
    expect(order).toEqual(["intent:kept", "tool:world_query"]);
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
    expect(declared).toEqual(["file_find", "file_read", "file_write", "reply_release", "todo", "world_query", "write_reply"]);
    const reported = s.logged.find((line) => line.level === "warn" && line.message.startsWith("Tools the lead's definition lists are registered by nobody"));
    expect(reported?.fields?.["tools"]).toContain("chat_read");
    expect(reported?.fields?.["tools"]).toContain("delegate");
    expect(reported?.fields?.["tools"]).not.toContain("world_query");
  });
});

describe("limits", () => {
  test("the turn's call limit holds: the call past it is never made, and the host is told which limit", async () => {
    const s = (open = await stage({
      drafted: true,
      config: "limits:\n  turn:\n    calls: 2\n",
      tools: { world_query: { tier: "read", description: "Fixture: reads the world.", run: async () => said("still calm") } },
      answers: Array.from({ length: 4 }, () => ({ pieces: [{ call: "world_query" }] })),
    }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(s.model.requests).toHaveLength(2);
    expect(outcome).toMatchObject({ status: "limit", released: false, limit: { limit: "calls", per: "turn", max: 2, value: 2 } });
    expect(sink.errors).toEqual([{ code: "limit", limit: { limit: "calls", per: "turn", max: 2, value: 2 } }]);
    expect(s.told.at(-1)?.kind).toBe("ended");
  });
});
