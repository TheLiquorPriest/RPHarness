import { describe, expect, test } from "bun:test";
import { USER, bodyOf, failed, json, rig } from "./support";

const KEY = "sk-harbour-embed-0123456789";

describe("embed", () => {
  test("with no embedding connection, embed answers that none is set; naming a connection whose provider offers none is reported", async () => {
    const r = rig();
    await r.layer.api.save(USER, { name: "Claude", provider: "anthropic", auth: "key", model: "claude-sonnet-4-5" }, KEY);
    expect(await r.layer.api.embed(USER, ["a quay"])).toMatchObject({ status: "none" });
    r.configs.global = "embedding:\n  connection: Claude\n  model: any\n";
    const named = await r.layer.api.embed(USER, ["a quay"]);
    expect(named.status).toBe("failed");
    expect(named.status === "failed" && named.words).toContain("offers no embeddings");
    expect(r.sent).toHaveLength(0);
    expect((await r.layer.api.list(USER)).providers.filter((p) => p.embeds).map((p) => p.id)).toEqual(["openai", "google", "mistral", "openai-compatible"]);
    await r.done();
  });

  test("on scripted OpenAI-compatible, Google and Mistral servers, texts come back as vectors in order and in batches; a 429 is tried again; no key is in failure words", async () => {
    let busy = true;
    const r = rig({
      script: (sent) => {
        if (sent.url.includes(":batchEmbedContents")) return json({ embeddings: (bodyOf(sent).requests as unknown[]).map((_, i) => ({ values: [i, 0.5] })) });
        if (sent.url.startsWith("https://api.mistral.ai")) return failed(401, { message: `bad key ${KEY}` });
        if (busy) {
          busy = false;
          return failed(429, { error: { message: "slow down" } });
        }
        const input = bodyOf(sent).input as string[];
        // Given back out of order: the layer puts them in order by index.
        return json({ model: "served-embed", data: input.map((t, index) => ({ index, embedding: [t.length, index] })).reverse(), usage: { total_tokens: 3 } });
      },
      global: "calls:\n  retryWait: 0\nembedding:\n  connection: Local\n  model: served-embed\n  batch: 2\n",
    });
    await r.layer.api.save(USER, { name: "Local", provider: "openai-compatible", auth: "key", baseUrl: "http://127.0.0.1:8080/v1", model: "served-model" }, KEY);
    const local = await r.clock.settle(r.layer.api.embed(USER, ["a", "bb", "ccc"]));
    expect(local).toEqual({ status: "embedded", connection: "Local", model: "served-embed", vectors: [[1, 0], [2, 1], [3, 0]] });
    expect(r.sent.map((s) => [s.url, s.redirect, s.headers.authorization])).toEqual([
      ["http://127.0.0.1:8080/v1/embeddings", "error", `Bearer ${KEY}`],
      ["http://127.0.0.1:8080/v1/embeddings", "error", `Bearer ${KEY}`],
      ["http://127.0.0.1:8080/v1/embeddings", "error", `Bearer ${KEY}`],
    ]);

    await r.layer.api.save(USER, { name: "Gemini", provider: "google", auth: "key", model: "gemini-2.5-flash" }, KEY);
    r.configs.global = "embedding:\n  connection: Gemini\n  model: gemini-embedding-001\n";
    expect(await r.layer.api.embed(USER, ["x", "y"])).toEqual({ status: "embedded", connection: "Gemini", model: "gemini-embedding-001", vectors: [[0, 0.5], [1, 0.5]] });
    expect(r.sent.at(-1)?.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${KEY}`);

    await r.layer.api.save(USER, { name: "Mistral", provider: "mistral", auth: "key", model: "mistral-small-latest" }, KEY);
    r.configs.global = "embedding:\n  connection: Mistral\n  model: mistral-embed\n";
    const refused = await r.layer.api.embed(USER, ["x"]);
    expect(r.sent.at(-1)?.url).toBe("https://api.mistral.ai/v1/embeddings");
    expect(refused.status).toBe("failed");
    expect(refused.status === "failed" && refused.words).not.toContain(KEY);
    await r.done();
  });
});
