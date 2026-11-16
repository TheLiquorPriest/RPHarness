// Listing a chat's sessions (Appendix A `SessionsApi.list`): every session the chat has, however
// many, oldest first; none is left out without a sign.
import { afterEach, expect, test } from "bun:test";
import { CHAT, type Stage, stage, USER } from "../harness/support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

test("a chat with more sessions than a host gives by default in one find has every one of them listed", async () => {
  const s = (open = await stage({ answers: [] }));
  const sessions = s.harness.sessions!;
  // Past the folder host's own cap of hits for one find (200).
  const ids = Array.from({ length: 205 }, (_, i) => `s${String(i + 1).padStart(3, "0")}`);
  for (const id of ids) {
    s.clock.advance(1);
    await sessions.open({ user: USER, chat: CHAT, session: id });
  }
  const listed = (await sessions.list(USER, CHAT, { limit: ids.length })).sessions;
  expect(listed.map((view) => view.id)).toEqual(ids);
});
