// RPH's front door: the contract, re-exported whole; `createHarness`, which builds a harness over a
// host's environment; where RPH's own shipped files are, for a host to put under its own files as
// the lowest layer; and the guidance loader, so a host renders its own texts from the same tree, with
// the same layers, overrides, `off:` and templates the agents get. A guidance part is a
// `TemplatePart` or a `LinesPart`; the name `PromptPart` here is the contract's, a piece of a message.

export type * from "./contract/index";
export type { Fields, Guidance, LinesPart, TemplatePart } from "./files/index";
export { loadGuidance } from "./files/index";
export { createHarness, type CreateHarnessOptions, SHIPPED_GUIDANCE } from "./harness/index";
