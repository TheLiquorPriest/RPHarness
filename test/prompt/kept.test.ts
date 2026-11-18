// What RPH keeps of a turn's prompt is found where the host placed the turn's folder: RPH never names a
// turn folder by the turn's id itself. This host names a turn's folder as RPE does (`turn-<n>-<first 8 of the id>`).
import { expect, test } from "bun:test";
import type { Scope } from "../../src/contract";
import { PromptMemory, promptTurn } from "../../src/prompt/memory";
import { messageText } from "../../src/prompt/text";
import { LEAD, memoryHost, type MemoryHost, presetA, SCOPE } from "./support";

const FIRST = "6c2f62d6-0b1e-4c55-9d1a-3e5f7a9b1c2d";
const SECOND = "9a41be07-5c2d-4e8f-a1b3-c5d7e9f1a3b5";
const THIRD = "d03c8e15-7f6a-4b9c-8d2e-1f3a5b7c9d0e";

async function play(host: MemoryHost, turn: string, session: string, parent: string | null) {
  const built = presetA({ history: 4, lore: ["e-1"] });
  host.set(built, ["e-1"]);
  await promptTurn({ env: host.env, scope: { ...SCOPE, session, turn }, messages: built.messages, parent, by: LEAD });
  return built;
}

test("a kept prompt is read back where the host placed its turn's folder, the newest with no turn named, and let go once its folder is gone", async () => {
  const host = memoryHost();
  const memory = new PromptMemory(host.env.store, host.env.files);
  const at: Scope = { user: SCOPE.user, chat: SCOPE.chat, session: "s-2" };
  const kept = async () => (await host.env.store.list(at, "prompt/turns/")).length;

  const first = await play(host, FIRST, "s-1", null);
  await play(host, SECOND, "s-2", FIRST);
  // The second turn was compared with the first, played in the session before: the same prompt, so its whole front held.
  expect(host.located[1]?.front.brokenBy).toBeUndefined();
  expect(host.located[1]?.front.length).toBeGreaterThan(0);

  // The first turn's prompt is read back after the next turn is kept, with the session it played in.
  const held = await memory.held(at, FIRST);
  expect(held?.session).toBe("s-1");
  expect(held?.messages.map((m) => m.content)).toEqual(first.messages.map(messageText));
  // With no turn named, the chat's newest kept.
  expect((await memory.held(at))?.turn).toBe(SECOND);

  // The host takes the first turn's folder away: its prompt is no longer read, and the next turn kept lets it go.
  host.removeFolder(FIRST);
  expect(await memory.held(at, FIRST)).toBeUndefined();
  expect(await kept()).toBe(3);
  await play(host, THIRD, "s-2", SECOND);
  expect(await kept()).toBe(3);
  expect((await memory.held(at, SECOND))?.turn).toBe(SECOND);
  expect((await memory.held(at))?.turn).toBe(THIRD);
});
