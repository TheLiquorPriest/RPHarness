// Pins (R-174): `pins:` in the global config and in a chat's (the folder host's `config.yml` at each,
// where RPE has `RPE-global.yml` and `RPE.yml`), each a file and the agent it is pinned for. At the
// start of each run of that agent the file is handed whole, as a `given` file after its definition's
// own; a pin taken out hands nothing; a pinned file that is gone is said on the Files page and in the
// run's log, and the run goes on with what is there. A pin that is not `{ file, agent }` is said too.

import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGuidance } from "../../src/files/index";
import { request, type Stage, stage, textOf } from "../harness/support";
import type { Bench } from "./support";
import { bench, scope } from "./support";

let open: Stage | undefined;
let b: Bench | undefined;
afterEach(async () => {
  await open?.close();
  await b?.close();
  open = undefined;
  b = undefined;
});

const CHAT = "chats/wren-hale/lighthouse/";
const CHIEF = "---\nname: chief\ndescription: Fixture lead.\nmodel: default\ntools: [delegate]\ngiven: [prompt:*]\n---\nFixture chief: you run the turn.\n";
const KEEPER = "---\nname: keeper\ndescription: Fixture keeper.\nmodel: default\ntools: []\ngiven: [file:persistent-workspace/ledger.md]\n---\nFixture keeper: keep the books.\n";
const LEDGER = "Fixture ledger: forty candles, two lamps.";
const HOUSE = "Fixture house note: the stores are counted on Sundays.";
const PLAN = "Fixture plan: the boat is two days late.";

/** One turn's calls: the chief asks the keeper, the keeper answers, the chief replies. */
const TURN = [
  { pieces: [{ call: "delegate", args: { agent: "keeper", brief: "Keep the books for this turn." }, id: "d-1" }] },
  { pieces: [{ text: "The books are kept." }] },
  { pieces: [{ text: "<reply>Wren counts the candles.</reply>" }] },
];

test("a note pinned for the keeper in a chat's RPE.yml and one in RPE-global.yml are both in the keeper's given, whole, after its own, at the start of each run; unpinned, it is not; a pinned file that is gone is reported and the run goes on", async () => {
  const s = (open = await stage({
    files: {
      ".agents/chief.md": CHIEF,
      ".agents/keeper.md": KEEPER,
      "config.yml": "pins:\n  - { file: '@global/persistent-workspace/house.md', agent: keeper }\n",
      "persistent-workspace/house.md": `${HOUSE}\n`,
      [`${CHAT}config.yml`]: "pins:\n  - file: persistent-workspace/plan.md\n    agent: keeper\n",
      [`${CHAT}persistent-workspace/plan.md`]: `${PLAN}\n`,
      [`${CHAT}persistent-workspace/ledger.md`]: `${LEDGER}\n`,
    },
    answers: [...TURN, ...TURN, ...TURN, ...TURN],
  }));
  const files = join(s.dir, "files");
  /** One turn: what the keeper's run started with, and the brief its first request ends on. */
  const keeperRun = async (turn: string) => {
    const before = s.model.requests.length;
    const { outcome } = await s.turn(request(turn, { lead: "chief" }));
    expect(outcome.status).toBe("released");
    const started = s.trace.of("agent_started").filter((record) => record.agent.definition === "keeper");
    return { given: started.at(-1)?.event.given, brief: textOf(s.model.requests[before + 1]!.messages.at(-1)!) };
  };

  // Both levels' pins, the global level's first, after the keeper's own given file; each whole.
  const first = await keeperRun("t1");
  expect(first.given).toEqual(["file:persistent-workspace/ledger.md", "file:@global/persistent-workspace/house.md", "file:persistent-workspace/plan.md"]);
  expect([LEDGER, HOUSE, PLAN].map((text) => first.brief.indexOf(text))).toEqual([LEDGER, HOUSE, PLAN].map((text) => first.brief.indexOf(text)).sort((a, b) => a - b));
  for (const text of [LEDGER, HOUSE, PLAN]) expect(first.brief).toContain(text);

  // The next run is handed the file as it is when that run starts.
  const later = "Fixture plan: the boat came in at dawn.";
  await writeFile(join(files, CHAT, "persistent-workspace/plan.md"), `${later}\n`);
  const second = await keeperRun("t2");
  expect(second.brief).toContain(later);
  expect(second.brief).not.toContain(PLAN);

  // Unpinned in the chat's config: that file is no longer handed; the global pin still is.
  await writeFile(join(files, CHAT, "config.yml"), "pins: []\n");
  const third = await keeperRun("t3");
  expect(third.given).toEqual(["file:persistent-workspace/ledger.md", "file:@global/persistent-workspace/house.md"]);
  expect(third.brief).not.toContain(later);

  // Gone: said on the Files page and in the log, and the keeper's run goes on with what is there.
  await rm(join(files, "persistent-workspace/house.md"));
  const fourth = await keeperRun("t4");
  expect(fourth.brief).toContain(LEDGER);
  expect(fourth.brief).not.toContain(HOUSE);
  const gone = "The file pinned for keeper, @global/persistent-workspace/house.md, is not there, so keeper is handed nothing for it.";
  expect(await loadGuidance(s.env.files, request("t4").scope).problems()).toContainEqual({ path: "@global/config.yml", level: "global", line: 1, message: gone });
  expect(s.logged.filter((line) => line.fields?.problem === gone).map((line) => line.fields?.agent)).toEqual(["keeper"]);
  expect(s.trace.of("agent_ended").filter((record) => record.agent.definition === "keeper").map((record) => record.event.status)).toEqual(["done", "done", "done", "done"]);
});

test("a pin that is not a file and an agent, a `pins:` that is no list, and a pin for an agent no definition has are each said, and hand nothing", async () => {
  b = await bench({
    global: { "config.yml": "pins: persistent-workspace/plan.md\n", ".agents/keeper.md": KEEPER },
    chat: { "config.yml": "pins:\n  - { file: persistent-workspace/plan.md }\n  - { file: persistent-workspace/plan.md, agent: keepr }\n", "persistent-workspace/plan.md": `${PLAN}\n` },
  });
  const g = loadGuidance(b.host.files, scope);

  expect((await g.definition("keeper"))?.given).toEqual(["file:persistent-workspace/ledger.md"]);
  expect((await g.problems()).map((p) => `${p.path}:${p.line} ${p.message}`).sort()).toEqual([
    "@global/config.yml:1 `pins:` is a list of files, each pinned for an agent: `pins: [{ file: persistent-workspace/plan.md, agent: keeper }]`.",
    "config.yml:1 Pin 1 of `pins:` needs a `file` and an `agent`, as in `{ file: persistent-workspace/plan.md, agent: keeper }`, so it is left out.",
    "config.yml:1 `pins:` pins persistent-workspace/plan.md for keepr, and no agent definition has that name, so nobody is handed it.",
  ]);
});
