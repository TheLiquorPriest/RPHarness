// The contract kit (§13.1, §18.1 row 0.7): `bun:test` cases any host's environment must pass. A
// host's suite calls `runContractKit` with a factory that makes the whole host over an empty folder,
// holding the kit's seed; the lead runs it in both suites (§18.2). A host whose ports are built
// apart (each by its own lane) runs one area at a time against the one port it needs, with
// `runKitPart`; the cases that need two ports at once run only for a whole host.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "bun:test";
import type { Environment } from "../../contract/index";
import { chatCases, loreCases } from "./chat";
import type { KitArea, KitContext, KitFactory, KitHost, KitPartFactory, KitPorts } from "./context";
import { KIT_AREAS } from "./context";
import { factCases, toolCases } from "./facts";
import { fileCases } from "./files";
import { modelCases, secretCases } from "./models";
import { promptCases } from "./prompt";
import { KIT_SEED } from "./seed";
import { storeCases, traceCases } from "./store";

export type { KitArea, KitFactory, KitHost, KitPartFactory, KitPorts } from "./context";
export { KIT_AREAS } from "./context";
export { KIT_AGENT } from "./files";
export { BASE_TOOL_NAMES, factProblems } from "./facts";
export { schemaProblems } from "./schema";
export type { KitFile, KitMessage, KitPrompt, KitPromptMessage, KitSeed } from "./seed";
export { KIT_SEED } from "./seed";

/** Each area's cases, by the port it runs against. */
const AREA_CASES: { [A in KitArea]: (ctx: KitContext<A>) => void } = {
  files: fileCases,
  chat: chatCases,
  lore: loreCases,
  prompt: promptCases,
  facts: factCases,
  tools: toolCases,
  store: storeCases,
  trace: traceCases,
  models: modelCases,
};

/** The ports of a whole host that the areas run against. */
function portsOf(env: Environment): Pick<Environment, KitArea> {
  return { files: env.files, chat: env.chat, lore: env.lore, prompt: env.prompt, facts: env.facts, tools: env.tools, store: env.store, trace: env.trace, models: env.models };
}

/** Registers every area's cases for one whole host, under `name`. Each run makes the host over a new folder, and removes the folder after. */
export function runContractKit(name: string, make: KitFactory): void {
  describe(`contract kit: ${name}`, () => {
    let host: KitHost | undefined;
    const reopen: KitPartFactory<KitArea> = async (seed, place) => {
      const again = await make(seed, place);
      return { ...portsOf(again.env), close: () => again.close() };
    };
    const ctx = { seed: KIT_SEED, scope: KIT_SEED.scope, make: reopen } as KitContext<KitArea>;

    beforeAll(async () => {
      ctx.place = await mkdtemp(join(tmpdir(), "rph-kit-"));
      host = await make(KIT_SEED, ctx.place);
      ctx.env = host.env;
    });

    afterAll(async () => {
      await host?.close();
      if (ctx.place !== undefined) await rm(ctx.place, { recursive: true, force: true });
    });

    for (const area of KIT_AREAS) describe(area, () => AREA_CASES[area](ctx));
    describe("models and files", () => secretCases(ctx));
  });
}

/**
 * Registers one area's cases, under `name`, against the one port it runs against: `make` gives
 * that port (`{ lore: LorePort, close }` for `lore`) over a new folder holding the seed, and the
 * folder is removed after.
 */
export function runKitPart<A extends KitArea>(name: string, area: A, make: KitPartFactory<A>): void {
  describe(`contract kit: ${name}`, () => {
    let ports: KitPorts<A> | undefined;
    const ctx = { seed: KIT_SEED, scope: KIT_SEED.scope, make } as KitContext<A>;

    beforeAll(async () => {
      ctx.place = await mkdtemp(join(tmpdir(), "rph-kit-"));
      ports = await make(KIT_SEED, ctx.place);
      ctx.env = ports;
    });

    afterAll(async () => {
      await ports?.close();
      if (ctx.place !== undefined) await rm(ctx.place, { recursive: true, force: true });
    });

    describe(area, () => AREA_CASES[area](ctx));
  });
}
