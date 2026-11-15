// What a host may import from RPH (§13.1, Appendix A): the contract module, which holds types alone;
// `createHarness` from the package's root, with the members of the harness it makes; and the one
// module of pure helpers, `rp-harness/helpers`, which the contract's index names. Each later helper
// joins that module, so a helper offered anywhere else fails here: the package offers no entry beyond
// these, the contract nothing at run time, and the root nothing new.

import { expect, test } from "bun:test";
import * as root from "rp-harness";
import * as contract from "rp-harness/contract";
import * as helpers from "rp-harness/helpers";
import manifest from "../../package.json";

/** Whether a value can be changed by whoever holds it: a function is a helper's code; data must be frozen through. */
function frozenThrough(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenThrough);
}

test("a host finds RPH's helpers in rp-harness/helpers alone: the contract holds types, the root createHarness, and the package offers no other entry for them", () => {
  // The folder host, the rig and the kit are entries of their own, for a second host and for tests.
  expect(Object.keys(manifest.exports).sort()).toEqual([".", "./contract", "./helpers", "./hosts/folder", "./package.json", "./testing/kit", "./testing/rig"]);
  expect(Object.keys(contract)).toEqual([]);
  // The root also offers the two values hosts took from it before the helpers module existed; they are recorded so that nothing joins them.
  expect(Object.keys(root).sort()).toEqual(["SHIPPED_GUIDANCE", "createHarness", "loadGuidance"]);

  // Every helper is pure: a function, or data no host can change under RPH, which reads the same values.
  expect(Object.keys(helpers).length).toBeGreaterThan(0);
  for (const [name, value] of Object.entries(helpers)) expect({ name, pure: typeof value === "function" || frozenThrough(value) }).toEqual({ name, pure: true });
  expect(helpers.SETTINGS.length).toBeGreaterThan(0);
});
