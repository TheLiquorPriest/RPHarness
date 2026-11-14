// Guidance from files (§5): agent definitions, instruction stacks, skills, rules and prompt parts,
// loaded in layers through the host's `FilesPort`, and the engine for the user's triggered rules.
// The types and how they are used are in `api.ts`.

export * from "./api";
export { createFacts, OWN_FACTS } from "./facts";
export { loadGuidance } from "./guidance";
export { changes, changesText, holdsNothing, snapshot } from "./stack";
export { parseTemplate } from "./template";
