// A connection edited by hand while the harness runs (§13.2): every turn starts by reading the
// connections again through the host, so the turn's first request goes where the edit says; what
// that read has to say goes to the log, never in front of an agent. The lead runs on the model
// layer here, its server a scripted fetch, the connections document where the folder host keeps it.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bodyOf, chatStream, chunk, eventStream, type Sent, scriptedFetch } from "../model/support";
import { request, type Stage, stage, USER } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/** A stage whose server answers every call with a reply, its one connection saved as the Connections page saves one, and the file the host keeps the connections in. */
async function served(): Promise<{ s: Stage; sent: Sent[]; doc: string }> {
  const { fetch, sent } = scriptedFetch(() => eventStream(chatStream([chunk({ role: "assistant", content: "<reply>No boat tonight.</reply>" }), chunk({}, "stop")])));
  const s = (open = await stage({ fetch, answers: [] }));
  const saved = await s.harness.models.save(USER, { name: "Harbour", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "first-model" });
  await s.harness.models.setDefault(USER, saved.id);
  return { s, sent, doc: join(s.dir, "host", "user", createHash("sha256").update(USER).digest("hex"), "models", "connections.json") };
}

test("a connection edited by hand between two turns is the one the second turn's first request goes to", async () => {
  const { s, sent, doc } = await served();

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  // Behind the harness, as a user would in a text editor: the same connection, another server and model.
  const kept = JSON.parse(await readFile(doc, "utf8")) as { connections: Record<string, unknown>[] };
  Object.assign(kept.connections[0]!, { baseUrl: "http://127.0.0.1:9090/v1", model: "second-model" });
  await writeFile(doc, JSON.stringify(kept));
  expect((await s.turn(request("t2", { lead: "lead" }))).outcome.status).toBe("released");

  expect(sent.map((one) => [one.url, bodyOf(one).model])).toEqual([
    ["http://127.0.0.1:8080/v1/chat/completions", "first-model"],
    ["http://127.0.0.1:9090/v1/chat/completions", "second-model"],
  ]);
});

test("a document that no longer reads: the turns run on the connections last read, and the read's words go to the log once, never to an agent", async () => {
  const { s, sent, doc } = await served();

  await s.turn(request("t1", { lead: "lead" }));
  await writeFile(doc, '{ "v": 1, "connections": [');
  for (const turn of ["t2", "t3"]) expect((await s.turn(request(turn, { lead: "lead" }))).outcome.status).toBe("released");

  expect(sent.map((one) => bodyOf(one).model)).toEqual(["first-model", "first-model", "first-model"]);
  const words = "The saved connections couldn't be read: fix what keeps them. Until then, the connections as last read are used.";
  expect(s.logged.filter((line) => line.message.includes("saved connections"))).toEqual([{ level: "info", message: words }]);
  expect(sent.filter((one) => one.text.includes("saved connections"))).toEqual([]);
});

test("a call held by its connection's throttle shows the wait in the trace", async () => {
  const { fetch, sent } = scriptedFetch(() => eventStream(chatStream([chunk({ role: "assistant", content: "<reply>No boat tonight.</reply>" }), chunk({}, "stop")])));
  const s = (open = await stage({ fetch, answers: [], config: "throttles:\n  connections:\n    Harbour:\n      requestsPerMinute: 1\n" }));
  const saved = await s.harness.models.save(USER, { name: "Harbour", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:8080/v1", model: "first-model" });
  await s.harness.models.setDefault(USER, saved.id);

  expect((await s.turn(request("t1", { lead: "lead" }))).outcome.status).toBe("released");
  // One request a minute: the second turn's call waits for the connection's minute, and its run's trace says so, then how long.
  const second = s.turn(request("t2", { lead: "lead" }));
  await s.trace.seen((record) => record.event.kind === "connection_wait");
  expect(sent).toHaveLength(1);
  s.clock.advance(60_000);
  expect((await second).outcome.status).toBe("released");
  const waits = s.trace.records.filter((record) => record.event.kind === "connection_wait");
  expect(waits.map((record) => [record.scope.turn, record.agent.definition, record.event])).toEqual([
    ["t2", "lead", { kind: "connection_wait", connection: "Harbour", for: "minute" }],
    ["t2", "lead", { kind: "connection_wait", connection: "Harbour", for: "minute", ms: 60_000 }],
  ]);
  expect(sent).toHaveLength(2);
});
