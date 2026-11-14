// The contract kit (§13.1, §18.1 row 0.7): `bun:test` cases any host's environment must pass. A
// host's suite calls `runContractKit` with a factory that makes the host over an empty folder,
// holding the kit's seed; the lead runs it in both suites (§18.2).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe } from "bun:test";
import { chatCases, loreCases } from "./chat";
import type { KitContext, KitFactory } from "./context";
import { factCases, toolCases } from "./facts";
import { fileCases } from "./files";
import { promptCases } from "./prompt";
import { KIT_SEED } from "./seed";
import { storeCases, traceCases } from "./store";

export type { KitFactory, KitHost } from "./context";
export { KIT_AGENT } from "./files";
export { BASE_TOOL_NAMES, factProblems } from "./facts";
export { schemaProblems } from "./schema";
export type { KitFile, KitMessage, KitPrompt, KitPromptMessage, KitSeed } from "./seed";
export { KIT_SEED } from "./seed";

/** Registers the kit's cases for one host, under `name`. Each run makes the host over a new folder, and removes the folder after. */
export function runContractKit(name: string, make: KitFactory): void {
  describe(`contract kit: ${name}`, () => {
    const ctx = { seed: KIT_SEED, make, scope: KIT_SEED.scope } as KitContext;

    beforeAll(async () => {
      ctx.place = await mkdtemp(join(tmpdir(), "rph-kit-"));
      ctx.host = await make(KIT_SEED, ctx.place);
      ctx.env = ctx.host.env;
    });

    afterAll(async () => {
      await ctx.host?.close();
      if (ctx.place !== undefined) await rm(ctx.place, { recursive: true, force: true });
    });

    describe("files", () => fileCases(ctx));
    describe("chat", () => chatCases(ctx));
    describe("lore", () => loreCases(ctx));
    describe("prompt", () => promptCases(ctx));
    describe("facts", () => factCases(ctx));
    describe("tools", () => toolCases(ctx));
    describe("store", () => storeCases(ctx));
    describe("trace", () => traceCases(ctx));
  });
}
