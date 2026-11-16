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
// - `OWNER_ONLY`: the members of the harness's API that only the owner's own presses may call
//   (`jobs.start`, `live.pause`, ...), which both repositories' call-site tests read, so a member
//   renamed in the contract or called by anything but a press fails them loudly (C-24).
// - `placeOf`: the form of the place a connection's key and headers' values were given for (its
//   provider and its address's origin and path), so a host that writes keys for the layer (the
//   migration) writes their places as the layer records them (C22, R-53).
// - `runPattern`: the one pattern facility (R-55): a pattern's first match in a text, run where it
//   is stopped after the time given, so a host's own searches (RPE's grep) never refuse a pattern
//   for being slow and never stall its process.
// - `renderTemplate`: the one template renderer (R-44), with which RPH renders every shipped part, so
//   a host's own texts (an engine's answers, a world state's layout) lay out exactly as RPH's do.
// - `SHIPPED_GUIDANCE`: where RPH's shipped files are, fixed where the package is installed, for a
//   host to serve through its own file port as the lowest level.

export { mergedConfig, SETTINGS } from "./harness/settings";
export { checkSettingValue } from "./harness/settings/check";
export { DEFINITION_FIELDS } from "./files/api";
export { parseDefinition } from "./files/definitions";
export { OWNER_ONLY } from "./owner";
export { placeOf } from "./model/place";
export { runPattern, type PatternRun } from "./files/pattern";
export { renderTemplate } from "./files/template";
export { SHIPPED_GUIDANCE } from "./harness/shipped";
