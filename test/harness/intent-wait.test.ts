// The wait for the intent record (§10.3, the setting `reply.intentWait`): a tool and the reply wait
// for the host to take the intent record written before them, so the Live page and the turn's
// record hold it first, but never longer than the user's bound; nothing is refused. A reply that
// went out with no intent record taken before it says so on its release, for the Turn page and the
// host. Everything here is invented.
import { afterEach, expect, test } from "bun:test";
import type { TurnEvents } from "../../src/contract";
import { request, type Stage, stage, WatchedSink } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** The host, its taking of intent records held back while `holding` is set. */
function slowHost(holding: { now: boolean; taken: Promise<void> }): (inner: TurnEvents) => TurnEvents {
  return (inner) => ({
    ...inner,
    intent: async (scope, text) => {
      if (holding.now) await holding.taken;
      return inner.intent(scope, text);
    },
  });
}

test("the reply waits for the host to take its intent record no longer than the setting, then goes out marked as without it", async () => {
  const taken = Promise.withResolvers<void>();
  const holding = { now: true, taken: taken.promise };
  const s = (open = await stage({
    config: "reply:\n  intentWait: 1\n",
    events: slowHost(holding),
    answers: [
      { pieces: [{ text: "<intent>Wants: news of the boat.</intent><reply>No boat tonight.</reply>" }] },
      { pieces: [{ text: "<intent>Wants: the lamp lit.</intent><reply>The lamp is lit.</reply>" }] },
      { pieces: [{ text: "<reply>Dawn comes grey.</reply>" }] },
    ],
  }));
  const sink = new WatchedSink(s.clock);
  const playing = s.turn(request("t1", { lead: "lead" }), sink);
  await s.trace.seen((record) => record.event.kind === "call_ended");
  await s.clock.idle();
  // The reply is whole, and nothing of it has reached the player while the host has not taken the record.
  expect(sink.text).toBe("");
  s.clock.advance(999);
  await s.clock.idle();
  expect(sink.text).toBe("");
  s.clock.advance(1);
  await sink.until(() => sink.finished.length > 0);
  expect(sink.text).toBe("No boat tonight.");
  holding.now = false;
  taken.resolve();
  expect((await playing).outcome.status).toBe("released");
  // Taken at once: the reply is marked only when it went out with no intent record taken before it.
  expect((await s.turn(request("t2", { lead: "lead", parent: "t1" }))).outcome.status).toBe("released");
  // No intent record at all.
  expect((await s.turn(request("t3", { lead: "lead", parent: "t2" }))).outcome.status).toBe("released");

  // On the Turn page and to the host: the first reply and the one with no intent record are marked.
  expect(s.trace.of("released").map((record) => record.event.release.withoutIntent)).toEqual([true, undefined, true]);
  const told = s.told.flatMap((item) => (item.kind === "released" && typeof item.payload === "object" && item.payload !== null ? [item.payload] : []));
  expect(told.map((payload) => ("withoutIntent" in payload ? payload.withoutIntent : undefined))).toEqual([true, undefined, true]);
});

test("a tool waits for the host to take the intent record no longer than the setting, then runs", async () => {
  const taken = Promise.withResolvers<void>();
  const holding = { now: true, taken: taken.promise };
  const s = (open = await stage({
    config: "reply:\n  intentWait: 2\n",
    events: slowHost(holding),
    answers: [
      { pieces: [{ text: "<intent>Wants: the tide table.</intent>" }, { call: "todo", args: { items: [{ text: "read the tide", done: false }] } }] },
      { pieces: [{ text: "<reply>High water at nine.</reply>" }] },
    ],
  }));
  const playing = s.turn(request("t1", { lead: "lead" }));
  await s.trace.seen((record) => record.event.kind === "call_ended");
  await s.clock.idle();
  expect(s.trace.of("todo")).toHaveLength(0);
  s.clock.advance(2000);
  await s.trace.seen((record) => record.event.kind === "todo");
  holding.now = false;
  taken.resolve();
  const { outcome } = await playing;
  expect(outcome).toMatchObject({ status: "released", reply: "High water at nine." });
  expect(s.model.requests).toHaveLength(2);
});
