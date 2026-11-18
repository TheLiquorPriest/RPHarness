import { describe, expect, test } from "bun:test";
import { failureWords, networkWords } from "../../src/model/words";

const ADVICE = " For more information, pass `verbose: true` in the second argument to fetch()";

describe("a connection that broke", () => {
  test("is said in plain words, with Bun's advice to a programmer taken off and the raw code last in brackets", () => {
    expect(networkWords(`ECONNRESET: The socket connection was closed unexpectedly.${ADVICE}`)).toBe("The connection was closed or reset (ECONNRESET)");
    expect(networkWords("fetch failed: getaddrinfo ENOTFOUND api.harbour.test")).toBe("The name api.harbour.test could not be resolved (ENOTFOUND)");
    expect(networkWords("Connection error.: connect ECONNREFUSED 127.0.0.1:4000")).toBe("The connection to 127.0.0.1:4000 was refused (ECONNREFUSED)");
    expect(networkWords("Unable to connect. Is the computer able to access the url?")).toBe("The connection was refused");
    expect(networkWords("The operation timed out (ETIMEDOUT)")).toBe("The request timed out (ETIMEDOUT)");
  });

  test("keeps what the provider said besides, and leaves any other text as it came", () => {
    expect(networkWords("The gateway dropped the stream: ECONNRESET")).toBe("The connection was closed or reset: The gateway dropped the stream (ECONNRESET)");
    expect(networkWords("The stream ended without a final message.")).toBe("The stream ended without a final message.");
    expect(failureWords("529: Overloaded")).toBe("529: Overloaded");
    expect(failureWords(`Connection error.: The socket connection was closed unexpectedly.${ADVICE} (ECONNRESET)`)).toBe("The connection was closed or reset (ECONNRESET)");
  });
});
