// The one module of pure helpers a host may import from RPH, as `rp-harness/helpers` (§13.1, Appendix
// A): beside the contract's types and `createHarness`, the values and functions by which a host agrees
// with RPH without reaching into it. Each is data that does not change or a function that reads only
// what it is given. Nothing else of RPH's is a host's to import.
//
// - `SETTINGS`: every setting RPH reads, as a config file writes it, with its name and what it is for
//   (§5.4 "Config", §14), so a host's Settings page shows and edits exactly those, and a setting RPH
//   adds reaches the page with nothing copied by hand.
// - `mergedConfig`: the merge of levels RPH reads every setting by (the contract's `MergeLevels`), so
//   a host reading the same config files reads what RPH reads.
// - `checkSettingValue`: the one check of a value against what a setting takes, which RPH's reader
//   passes every value a config file sets through, so a host's Settings page takes and refuses
//   exactly the values RPH reads and passes over, and says why in RPH's words.
// - `parseDefinition` and `DEFINITION_FIELDS`: the reader of an agent definition's file and the
//   fields its header has (§5.4, C8), so a host that writes or imports a definition (the migration's
//   imported agents) reads its header exactly as RPH does.

export { mergedConfig, SETTINGS } from "./harness/settings";
export { checkSettingValue } from "./harness/settings/check";
export { DEFINITION_FIELDS } from "./files/api";
export { parseDefinition } from "./files/definitions";
