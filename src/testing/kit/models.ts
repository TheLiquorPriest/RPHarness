// The kit's cases for where the model layer's documents are kept (§13.2, `ModelsPort`): each comes
// back whole as last saved, a save replaces the one before whole, and both survive a new instance.
// And, for a whole host, that a key saved there is nowhere in the agents' view (§16).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ConnectionsDoc, SecretsDoc } from "../../contract/index";
import type { KitContext } from "./context";
import { hitsOf } from "./context";

/** A key no file of the seed holds, so finding it anywhere means it leaked. */
const KIT_KEY = "sk-kit-7f3a9c2e5b1d4f6a8c0e";

const CONNECTIONS: ConnectionsDoc = {
  v: 1,
  default: "kit-conn-1",
  connections: [
    {
      id: "kit-conn-1",
      name: "Kit Deep",
      provider: "deepseek",
      auth: "key",
      model: "kit-model",
      effort: "low",
      headers: { "X-Kit": "one", "X-Kit-Dropped": null },
      serialTools: true,
      messageThreads: true,
      retries: 3,
      limits: { "kit-model": { contextWindow: 64_000, maxTokens: 4_096 } },
      reported: { "kit-model": { contextWindow: 65_536 } },
    },
    { id: "kit-conn-2", name: "Kit Local", provider: "openai-compatible", auth: "none", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions" },
  ],
};

const CONNECTIONS_LATER: ConnectionsDoc = { v: 1, default: null, connections: [{ id: "kit-conn-3", name: "Kit Signed", provider: "anthropic", auth: "signin" }] };

const SECRETS: SecretsDoc = {
  v: 1,
  keys: { "kit-conn-1": KIT_KEY },
  signins: { anthropic: { type: "oauth", access: "kit-access", refresh: "kit-refresh", expires: 1_900_000_000_000, accountId: "kit-account" } },
  device: "kit-device",
};

const SECRETS_LATER: SecretsDoc = { v: 1, keys: {}, signins: {} };

export function modelCases(ctx: KitContext<"models">): void {
  test("with nothing saved, there is neither document", async () => {
    expect(await ctx.env.models.loadConnections()).toBeNull();
    expect(await ctx.env.models.loadSecrets()).toBeNull();
  });

  test("each document comes back whole as saved, and a later save replaces it whole", async () => {
    await ctx.env.models.saveConnections(CONNECTIONS);
    await ctx.env.models.saveSecrets(SECRETS);
    expect(await ctx.env.models.loadConnections()).toEqual(CONNECTIONS);
    expect(await ctx.env.models.loadSecrets()).toEqual(SECRETS);
    await ctx.env.models.saveConnections(CONNECTIONS_LATER);
    await ctx.env.models.saveSecrets(SECRETS_LATER);
    expect(await ctx.env.models.loadConnections()).toEqual(CONNECTIONS_LATER);
    expect(await ctx.env.models.loadSecrets()).toEqual(SECRETS_LATER);
  });

  test("both documents survive a new instance over the same place", async () => {
    const place = await mkdtemp(join(tmpdir(), "rph-kit-models-"));
    try {
      const first = await ctx.make(ctx.seed, place);
      await first.models.saveConnections(CONNECTIONS);
      await first.models.saveSecrets(SECRETS);
      await first.close();
      const second = await ctx.make(ctx.seed, place);
      expect(await second.models.loadConnections()).toEqual(CONNECTIONS);
      expect(await second.models.loadSecrets()).toEqual(SECRETS);
      await second.close();
    } finally {
      await rm(place, { recursive: true, force: true });
    }
  });
}

/** For a whole host only: the models port and the files port together. */
export function secretCases(ctx: KitContext<"models" | "files">): void {
  test("a key saved through the models port is nowhere in the agents' view", async () => {
    await ctx.env.models.saveSecrets(SECRETS);
    for (const layer of await ctx.env.files.layers(ctx.scope)) {
      const found = hitsOf(await ctx.env.files.find(ctx.scope, { by: "grep", pattern: KIT_KEY, literal: true, path: layer.mount, limit: 10 }));
      expect({ level: layer.level, found }).toEqual({ level: layer.level, found: [] });
    }
  });
}
