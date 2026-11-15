// The kit's cases for where the model layer's documents are kept (§13.2, `ModelsPort`): each user's
// come back whole as last saved for him, a save replaces the one before whole, both survive a new
// instance, and one user's are never another's (READINGS R-52). And, for a whole host, that a key or
// a header's value saved there is nowhere in the agents' view (§16).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { ConnectionsDoc, SecretsDoc } from "../../contract/index";
import type { KitContext } from "./context";
import { hitsOf, KIT_OTHER_USER, unlessRefused } from "./context";

/** A key no file of the seed holds, so finding it anywhere means it leaked. */
const KIT_KEY = "sk-kit-7f3a9c2e5b1d4f6a8c0e";
/** A header's value, a credential like a key, that no file of the seed holds. */
const KIT_HEADER_VALUE = "kit-header-3e9b51c7d0a4f286";

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
      headers: ["X-Kit", "X-Kit-Dropped"],
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
  // `X-Kit-Dropped` is named in the connections with no value here, so it is not sent.
  headers: { "kit-conn-1": { "X-Kit": KIT_HEADER_VALUE } },
  device: "kit-device",
};

const SECRETS_LATER: SecretsDoc = { v: 1, keys: {}, signins: {} };

export function modelCases(ctx: KitContext<"models">): void {
  const user = { user: ctx.scope.user };

  test("with nothing saved, there is neither document", async () => {
    expect(await ctx.env.models.loadConnections(user)).toBeNull();
    expect(await ctx.env.models.loadSecrets(user)).toBeNull();
  });

  test("each document comes back whole as saved, and a later save replaces it whole", async () => {
    await ctx.env.models.saveConnections(user, CONNECTIONS);
    await ctx.env.models.saveSecrets(user, SECRETS);
    expect(await ctx.env.models.loadConnections(user)).toEqual(CONNECTIONS);
    expect(await ctx.env.models.loadSecrets(user)).toEqual(SECRETS);
    await ctx.env.models.saveConnections(user, CONNECTIONS_LATER);
    await ctx.env.models.saveSecrets(user, SECRETS_LATER);
    expect(await ctx.env.models.loadConnections(user)).toEqual(CONNECTIONS_LATER);
    expect(await ctx.env.models.loadSecrets(user)).toEqual(SECRETS_LATER);
  });

  test("a connection saved for one user is not listed for another, and each user's keys are his own", async () => {
    const other = { user: KIT_OTHER_USER };
    await ctx.env.models.saveConnections(user, CONNECTIONS);
    await ctx.env.models.saveSecrets(user, SECRETS);
    // A host that serves one user only may refuse another's scope outright; one that keeps both keeps each his own.
    expect({ connections: (await unlessRefused(ctx.env.models.loadConnections(other))) ?? null, secrets: (await unlessRefused(ctx.env.models.loadSecrets(other))) ?? null }).toEqual({ connections: null, secrets: null });
    const accepted = await unlessRefused(ctx.env.models.saveConnections(other, CONNECTIONS_LATER).then(() => true));
    await unlessRefused(ctx.env.models.saveSecrets(other, SECRETS_LATER));
    expect(await ctx.env.models.loadConnections(user)).toEqual(CONNECTIONS);
    expect(await ctx.env.models.loadSecrets(user)).toEqual(SECRETS);
    const theirs = { connections: (await unlessRefused(ctx.env.models.loadConnections(other))) ?? null, secrets: (await unlessRefused(ctx.env.models.loadSecrets(other))) ?? null };
    expect(theirs).toEqual(accepted === true ? { connections: CONNECTIONS_LATER, secrets: SECRETS_LATER } : { connections: null, secrets: null });
  });

  test("both documents survive a new instance over the same place", async () => {
    const place = await mkdtemp(join(tmpdir(), "rph-kit-models-"));
    try {
      const first = await ctx.make(ctx.seed, place);
      await first.models.saveConnections(user, CONNECTIONS);
      await first.models.saveSecrets(user, SECRETS);
      await first.close();
      const second = await ctx.make(ctx.seed, place);
      expect(await second.models.loadConnections(user)).toEqual(CONNECTIONS);
      expect(await second.models.loadSecrets(user)).toEqual(SECRETS);
      await second.close();
    } finally {
      await rm(place, { recursive: true, force: true });
    }
  });
}

/** For a whole host only: the models port and the files port together. */
export function secretCases(ctx: KitContext<"models" | "files">): void {
  test("a key or a header's value saved through the models port is nowhere in the agents' view", async () => {
    await ctx.env.models.saveSecrets({ user: ctx.scope.user }, SECRETS);
    for (const layer of await ctx.env.files.layers(ctx.scope)) {
      for (const secret of [KIT_KEY, KIT_HEADER_VALUE]) {
        const found = hitsOf(await ctx.env.files.find(ctx.scope, { by: "grep", pattern: secret, literal: true, path: layer.mount, limit: 10 }));
        expect({ level: layer.level, secret, found }).toEqual({ level: layer.level, secret, found: [] });
      }
    }
  });
}
