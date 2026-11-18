// What broke a failed call, by what the layer knew of it and else by its words, and the wait before
// each try: grown each time, the provider's asked wait kept to where the settings say, never past the longest.
import { describe, expect, test } from "bun:test";
import { failureOf, retried, retryWait, RETRIED_KINDS, type RetryTerms } from "../../src/model/failure";

describe("what broke a call", () => {
  test("by its status, then by its words", () => {
    expect(failureOf("The connection was closed or reset: The socket connection was closed unexpectedly.").kind).toBe("connection");
    expect(failureOf("The stream ended before the answer did.").kind).toBe("connection");
    expect(failureOf("anything", { unreached: true }).kind).toBe("connection");
    expect(failureOf("The model went silent: nothing came.", { silent: true }).kind).toBe("timeout");
    expect(failureOf("504: Gateway Timeout").kind).toBe("timeout");
    expect(failureOf("529: Overloaded (overloaded_error)")).toEqual({ kind: "overloaded", status: 529 });
    expect(failureOf("Rate limit reached for requests. Please try again in 6.5s.")).toEqual({ kind: "overloaded", asked: 6_500 });
    expect(failureOf("500: Internal server error (api_error)").kind).toBe("server");
    expect(failureOf("Something nobody names.").kind).toBe("other");
    // Never made again.
    expect(failureOf("429: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)").kind).toBe("credit");
    expect(failureOf("402: Insufficient Balance").kind).toBe("credit");
    expect(failureOf("401: invalid x-api-key (authentication_error)").kind).toBe("key");
    expect(failureOf("400: tools.0.name: String should match pattern (invalid_request_error)").kind).toBe("invalid");
    expect(failureOf("400: prompt is too long: 210000 tokens > 200000 maximum").kind).toBe("too-long");
    expect(failureOf("This call comes to about 900 tokens, more than the 1 a minute it takes, so it was not made.", { unmade: true }).kind).toBe("unmade");
    // A status the server answered before its stream broke is no failure's status.
    expect(failureOf("The connection was closed or reset", { status: 200 })).toEqual({ kind: "connection" });
    expect(failureOf("Overloaded", { status: 529, asked: 20_000 })).toEqual({ kind: "overloaded", status: 529, asked: 20_000 });
  });
});

describe("the wait before a try", () => {
  const terms: RetryTerms = { retries: 3, wait: 1_000, growth: 2, most: 5_000, asked: true, kinds: RETRIED_KINDS };

  test("grows each time and never passes the longest; the provider's asked wait is kept to where the settings say, up to the longest", () => {
    expect([0, 1, 2, 3].map((tried) => retryWait(terms, tried))).toEqual([1_000, 2_000, 4_000, 5_000]);
    expect(retryWait(terms, 0, 3_000)).toBe(3_000);
    expect(retryWait(terms, 0, 60_000)).toBe(5_000);
    expect(retryWait({ ...terms, asked: false }, 0, 3_000)).toBe(1_000);
    expect(retryWait({ ...terms, growth: 1 }, 2)).toBe(1_000);
  });

  test("only a kind a try can help, its switch on, with a try left", () => {
    expect(retried(terms, { kind: "connection" }, 2)).toBe(true);
    expect(retried(terms, { kind: "connection" }, 3)).toBe(false);
    expect(retried(terms, { kind: "connection" }, 0, 0)).toBe(false);
    expect(retried({ ...terms, kinds: ["server"] }, { kind: "connection" }, 0)).toBe(false);
    expect(retried({ ...terms, kinds: ["key", "credit"] }, { kind: "key" }, 0)).toBe(false);
  });
});
