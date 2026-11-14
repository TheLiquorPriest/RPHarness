// RPH's front door: the contract, re-exported whole; `createHarness`, which builds a harness over a
// host's environment; and where RPH's own shipped files are, for a host to put under its own files
// as the lowest layer.

export type * from "./contract/index";
export { createHarness, type CreateHarnessOptions, SHIPPED_GUIDANCE } from "./harness/index";
