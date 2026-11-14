// The reply's forms (§10.6, §10.7): the two-step form for a connection that does not keep tags; the
// narrator's draft, read by the lead and released (three calls); the narrator live (two calls); and
// one reply per generation, a second attempt answered with a plain line from a file.
import { afterEach, describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { gate, PROMPT, request, type Stage, stage, textOf, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const SECOND = "The reply for this turn has already gone out. Nothing more goes to the chat.";
const BRIEF = "Wren says the boat has not come. Keep to her words; do not name the boat.";
const PRESET = { temperature: 0.9, top_p: 0.95, stop: ["\nPlayer:"] };

function lastToolResult(messages: readonly Message[]): string {
  const result = messages.filter((message) => message.role === "toolResult").at(-1);
  return result === undefined ? "" : textOf(result);
}

describe("the two-step form", () => {
  test("working text is never shown; the plain text of a message that ends with no work left is the reply, shown whole; the intent record written to its file reaches the host", async () => {
    const more = gate();
    const intent = "Wants: news of the boat. Engine lane: nothing changes.";
    const s = (open = await stage({
      config: "reply:\n  form: two-step\n",
      answers: [
        { pieces: [{ text: "Checking what the notes say first." }, { call: "file_write", args: { path: "sessions/s1/turns/t1/scratch/intent.md", op: "write", text: intent } }] },
        { pieces: [{ text: "Wren shakes her head." }, { hold: more }, { text: " No boat, not in this sea." }, { call: "todo", args: { items: [], closing: true } }] },
      ],
    }));
    const sink = new WatchedSink(s.clock);

    const turn = s.turn(request("t1", { lead: "lead" }), sink);
    await s.trace.seen((record) => record.event.kind === "call_started" && record.event.call === 2);
    await s.clock.idle();
    // Mid-message, nothing is shown: the text is shown only once its message ends as the reply.
    expect(sink.pieces).toEqual([]);
    more.open();
    const { outcome } = await turn;

    expect(outcome).toMatchObject({ status: "released", form: "message", reply: "Wren shakes her head. No boat, not in this sea." });
    expect(s.model.requests).toHaveLength(2);
    expect(sink.pieces.map((piece) => piece.text)).toEqual(["Wren shakes her head. No boat, not in this sea."]);
    expect(sink.text).not.toContain("Checking");
    // The contract the lead was given is the two-step one.
    const opening = textOf(s.model.requests[0]!.messages[0]!);
    expect(opening).toContain("Working text goes in files, never in a message.");
    expect(opening).toContain("written first to `scratch/intent.md` in the turn's folder");
    expect(opening).not.toContain("<reply>");
    // RPH's own briefing, last, ends on the same contract, rendered for the same form.
    const briefing = textOf(s.model.requests[0]!.messages.at(-1)!);
    expect(briefing).toContain("Working text goes in files, never in a message.");
    expect(briefing).toEndWith("If one comes back with a report, you get another call to read it.");
    expect(briefing).not.toContain("<reply>");
    expect(s.told.map((told) => told.kind)).toEqual(["intent", "released", "ended"]);
    expect(s.told[0]!.payload).toBe(intent);
  });
});

describe("the narrator", () => {
  test("draft first: the lead hands over a brief, reads the draft, and releases it whole; three calls", async () => {
    const s = (open = await stage({
      drafted: true,
      answers: [
        { pieces: [{ text: "<intent>Hand the prose over.</intent>" }, { call: "write_reply", args: { brief: BRIEF } }] },
        { pieces: [{ text: " has not come," }, { text: " Wren says, and turns back to the brass." }] },
        { pieces: [{ call: "reply_release", args: { closing: true } }] },
      ],
    }));

    const { outcome, sink } = await s.turn(request("t1", { prefill: "The boat", prompt: [...PROMPT, { role: "assistant", content: "The boat" }], presetSampling: PRESET, replyMaxTokens: 600 }));

    expect(outcome).toMatchObject({ status: "released", form: "narrator", reply: " has not come, Wren says, and turns back to the brass." });
    expect(s.model.requests).toHaveLength(3);
    // Sent whole, once the lead released it.
    expect(sink.pieces.map((piece) => piece.text)).toEqual([" has not come, Wren says, and turns back to the brass."]);
    const narrator = s.model.requests[1]!;
    // The prompt exactly as it was sent, then the narrator's own definition and what it reads, then the brief, then the prefilled start to go on from.
    expect(narrator.messages.slice(0, PROMPT.length).map((message) => [message.role, textOf(message)])).toEqual(PROMPT.map((message) => [message.role, message.content as string]));
    const after = narrator.messages.slice(PROMPT.length);
    expect(after.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(textOf(after[0]!)).toStartWith("The prompt above is the one the chat application assembled for this reply.");
    expect(textOf(after[0]!)).toContain("# Writing the reply");
    expect(textOf(after[1]!)).toBe(BRIEF);
    expect(textOf(after[2]!)).toBe("The boat");
    expect(narrator.tools).toEqual([]);
    expect(narrator.options).toMatchObject({ temperature: 0.9, maxTokens: 600, samplingParams: { top_p: 0.95, stop: ["\nPlayer:"] } });
    // The lead's own calls keep its own sampling.
    expect(s.model.requests[0]!.options.temperature).toBeUndefined();
    // The lead read the draft.
    expect(lastToolResult(s.model.requests[2]!.messages)).toBe(" has not come, Wren says, and turns back to the brass.");
    const narratorStarted = s.trace.of("agent_started").find((record) => record.agent.definition === "narrator");
    expect(narratorStarted?.parent).toEqual({ agent: "id-1", run: "t1", call: "call_1_1" });
  });

  test("live: the narrator's words reach the player as they are written, and a closing hand-over ends the turn; two calls", async () => {
    const more = gate();
    const s = (open = await stage({
      drafted: true,
      answers: [
        { pieces: [{ call: "write_reply", args: { brief: BRIEF, live: true, closing: true } }] },
        { pieces: [{ text: "Not yet," }, { hold: more }, { text: " Wren says." }] },
      ],
    }));
    const sink = new WatchedSink(s.clock);

    const turn = s.turn(request("t1"), sink);
    await sink.until(() => sink.text !== "");
    await s.clock.idle();
    expect(sink.text).toBe("Not yet,");
    more.open();
    const { outcome } = await turn;

    expect(outcome).toMatchObject({ status: "released", form: "narrator-live", reply: "Not yet, Wren says." });
    expect(s.model.requests).toHaveLength(2);
    expect(sink.pieces.map((piece) => piece.text)).toEqual(["Not yet,", " Wren says."]);
    const released = s.told.find((told) => told.kind === "released")?.payload;
    expect(released).toMatchObject({ form: "narrator-live", by: { definition: "narrator" }, length: "Not yet, Wren says.".length });
  });
});

describe("one reply per generation", () => {
  test("a second release is answered with the plain line, and nothing more reaches the chat", async () => {
    const s = (open = await stage({
      drafted: true,
      files: { "chats/wren-hale/lighthouse/persistent-workspace/draft.md": "A second telling.\n" },
      answers: [
        { pieces: [{ text: "<reply>No boat tonight.</reply>" }, { call: "reply_release", args: { path: "persistent-workspace/draft.md", closing: true } }] },
        { pieces: [{ text: "Understood." }] },
      ],
    }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(outcome).toMatchObject({ status: "released", form: "tags", reply: "No boat tonight." });
    expect(sink.text).toBe("No boat tonight.");
    // The answer was not clean, so the lead got a call to read it.
    expect(s.model.requests).toHaveLength(2);
    expect(lastToolResult(s.model.requests[1]!.messages)).toBe(SECOND);
  });

  test("a second reply in tags is not shown, and the lead is told so with the plain line", async () => {
    const s = (open = await stage({
      drafted: true,
      answers: [
        { pieces: [{ text: "<reply>No boat tonight.</reply>" }, { call: "todo", args: { items: [{ text: "check the log", done: false }] } }] },
        { pieces: [{ text: "<reply>On second thought, a boat.</reply>" }] },
        { pieces: [{ text: "Understood." }] },
      ],
    }));

    const { outcome, sink } = await s.turn(request("t1"));

    expect(outcome.status).toBe("released");
    expect(sink.text).toBe("No boat tonight.");
    expect(s.model.requests).toHaveLength(3);
    const told = s.model.requests[2]!.messages.at(-1)!;
    expect(told.role).toBe("user");
    expect(textOf(told)).toBe(SECOND);
  });
});
