// Sub-agents past the reply (§13.4): one not kept ends with the reply and its handle answers that it
// ended; a kept one may be messaged after the reply and works on that message, and the turn's answer
// resolves once every agent of it has finished.
import { afterEach, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { request, type Stage, stage, textOf } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [delegate, agent_message]\ngiven: [prompt:*]\n---\nFixture chief: you run the turn.\n";
const GM = "---\nname: gm\ndescription: Fixture GM.\nmodel: default\ntools: []\n---\nFixture GM.\n";

function lastResult(messages: readonly Message[]): string {
  const result = messages.filter((message) => message.role === "toolResult").at(-1);
  return result === undefined ? "" : textOf(result);
}

test("an agent not kept ends with the reply; a kept one is messaged after it, and the turn's answer waits for the end of its work", async () => {
  const s = (open = await stage({
    files: { ".agents/chief.md": CHIEF, ".agents/gm.md": GM },
    answers: [
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the jump.", keep: true }, id: "d-1" }] },
      { pieces: [{ text: "Ruled." }] },
      { pieces: [{ call: "delegate", args: { agent: "gm", brief: "Rule on the rope." }, id: "d-2" }] },
      { pieces: [{ text: "Roped." }] },
      { pieces: [{ text: "<reply>She leaps.</reply>" }, { call: "agent_message", args: { agent: "gm-2", message: "And the knot?" }, id: "m-1" }] },
      { pieces: [{ call: "agent_message", args: { agent: "gm-1", message: "Note what came of it." }, id: "m-2" }] },
      { pieces: [{ text: "Noted." }] },
      { pieces: [{ text: "Done." }] },
    ],
  }));

  const { outcome } = await s.turn(request("t1", { lead: "chief" }));

  expect(outcome).toMatchObject({ status: "released", reply: "She leaps." });
  // The one not kept ended with the reply.
  expect(lastResult(s.model.requests[5]!.messages)).toBe("gm-2 ended when this turn's reply went out, so it cannot be messaged now.");
  // The kept one worked on the message after the reply, and finished before the run's end.
  const kinds = s.trace.records.flatMap((record) => (record.event.kind === "agent_ended" && record.agent?.id === "gm-1" ? [`gm-1 ${record.event.status}`] : record.event.kind === "run_ended" ? ["run_ended"] : []));
  expect(kinds).toEqual(["gm-1 done", "gm-1 done", "run_ended"]);
});
