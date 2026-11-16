// The Author's opening block in a whole turn (§5.2, §10.2): its stack in §5.2's order whatever order
// its definition's `reads` lists the parts, its definition fifth and once, then the reply contract.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { SHIPPED_GUIDANCE } from "../../src/helpers";
import { request, type Stage, stage, textOf } from "./support";

let open: Stage | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const ALL_AGENTS = "Fixture house rule: everyone keeps to the lighthouse's log.";
const RULE = "Fixture rule: say where each scene takes place.";
const WORLD = "Fixture world: Gannet Rock, one winter, no boats.";
const DEFINITION = "Fixture Author: you run the turn and give the reply.";
const TURN = "Fixture turn: weigh what the player wants, then answer.";

test("the Author's first request holds ALL-AGENTS, the rules, WORLD, then its definition, then TURN", async () => {
  const s = (open = await stage({
    files: {
      // Its `reads` lists the parts backwards.
      ".agents/author.md": `---\nname: author\ndescription: Fixture Author.\nmodel: default\ntools: []\nreads: [TURN, WORLD, rules, ALL-AGENTS]\ngiven: [prompt:*, briefing]\n---\n${DEFINITION}\n`,
      "ALL-AGENTS.md": `${ALL_AGENTS}\n`,
      ".rules/places.md": `---\ndescription: Fixture always-on rule.\nagents: [author]\n---\n${RULE}\n`,
      "chats/wren-hale/lighthouse/WORLD.md": `${WORLD}\n`,
      "TURN.md": `${TURN}\n`,
    },
    answers: [{ pieces: [{ text: "<reply>No boat tonight.</reply>" }] }],
  }));

  const { outcome } = await s.turn(request("t1"));

  expect(outcome.status).toBe("released");
  // The rules are RPH's own shipped one first, then the global level's.
  const consent = await Bun.file(join(SHIPPED_GUIDANCE, ".rules", "consent.md")).text();
  const shippedRule = consent.slice(consent.indexOf("\n---\n", 3) + "\n---\n".length).trimEnd();
  const opening = textOf(s.model.requests[0]!.messages[0]!);
  const stack = [ALL_AGENTS, shippedRule, RULE, WORLD, DEFINITION, TURN].join("\n\n");
  expect(opening.slice(0, stack.length + 2)).toBe(`${stack}\n\n`);
  expect(opening.split(DEFINITION)).toHaveLength(2);
});
