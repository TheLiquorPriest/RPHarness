// RPH's front door: the contract, re-exported whole, and `createHarness`, which builds a harness over a
// host's environment (CONTRACT condition 4). A host reads the chat's layered parts through the
// harness's `parts` member; where RPH's shipped files are, and the one template renderer, come from the
// helpers module (`rp-harness/helpers`).

export type * from "./contract/index";
export { createHarness, type CreateHarnessOptions } from "./harness/index";
