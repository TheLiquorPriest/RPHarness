// RPH's own shipped files (§13.1): what any roleplay host would want, laid out like a host's tree
// (`.prompts/`, `.rules/`, `.tools/`, `.agents/`). A host puts this folder under its own files as the
// lowest layer, and a host's file of the same name replaces RPH's.
import { fileURLToPath } from "node:url";

/**
 * The folder of RPH's own shipped files, to put under a host's files as the lowest layer. A host
 * that bundles the harness copies the folder beside its bundle and has its build put the copy's
 * place, relative to the bundle, in `RPH_GUIDANCE_DIR`: in a bundle every module has the bundle's
 * own address, so the path from this file would point outside it.
 */
export const SHIPPED_GUIDANCE = fileURLToPath(new URL(process.env.RPH_GUIDANCE_DIR ?? "../../guidance/", import.meta.url));
