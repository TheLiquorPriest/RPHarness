// The owner's own tools' manifests (§5.4 "Tools", P15): `<tools>/<name>.json`, one tool each, a command
// it runs or an address it calls. A manifest that cannot be read as one is a problem shown on the
// Files page, and its tool is left out; nothing is guessed.

import type { FileText, JsonObject } from "../contract/index";
import type { Problem, ToolManifest } from "./api";

/** A name every provider takes for a tool. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The methods whose request carries the arguments as its body. */
const METHODS = ["POST", "PUT", "PATCH"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A manifest read from its file: the tool, or the problems that leave it out; and, either way, what it
 * runs or calls as far as its file says (`written`), so a list of what waits can show a broken one too.
 */
export function parseManifest(file: FileText, name: string): { manifest?: ToolManifest; problems: Problem[]; written?: { kind: "command-tool" | "http-tool"; runs: string } } {
  const problems: Problem[] = [];
  const problem = (message: string) => problems.push({ path: file.path, level: file.level, message });
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (error) {
    problem(`The manifest is not JSON (${error instanceof Error ? error.message : String(error)}), so its tool is left out.`);
    return { problems };
  }
  if (!isObject(raw)) {
    problem("A tool's manifest is one JSON object: its family, what it takes, and the command it runs or the address it calls.");
    return { problems };
  }
  if (!TOOL_NAME.test(name)) problem("A tool's name, its file's name, is letters, digits, `_` and `-`, at most 64 long.");
  if (raw.name !== undefined && raw.name !== name) problem(`\`name\` says ${JSON.stringify(raw.name)}, and a tool goes by its file's name, ${name}.`);
  const family = typeof raw.family === "string" ? raw.family.trim() : "";
  if (family === "") problem("`family` names the group the tool is found under.");
  const takes = raw.takes ?? { type: "object", properties: {} };
  if (!isObject(takes) || takes.type !== "object") problem('`takes` is a JSON schema of an object: `{ "type": "object", "properties": { … } }`.');
  const timeout = raw.timeout;
  if (timeout !== undefined && !(typeof timeout === "number" && timeout > 0)) problem("`timeout` is the seconds the tool may take, more than 0.");
  const command = typeof raw.command === "string" && raw.command.trim() !== "" ? raw.command : undefined;
  const address = typeof raw.address === "string" && raw.address.trim() !== "" ? raw.address.trim() : undefined;
  let runs: ToolManifest["runs"] | undefined;
  if ((command === undefined) === (address === undefined)) problem("A tool runs a `command` or calls an `address`: one of the two.");
  else if (command !== undefined) {
    for (const key of ["method", "headers"] as const) if (raw[key] !== undefined) problem(`\`${key}\` goes with \`address\`, and is not read for a command.`);
    runs = { command };
  } else if (address !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(address);
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) problem("`address` is a whole http or https address.");
    const method = raw.method === undefined ? "POST" : typeof raw.method === "string" ? raw.method.toUpperCase() : "";
    if (!METHODS.some((m) => m === method)) problem(`\`method\` is one of ${METHODS.join(", ")}: the arguments go as the request's JSON body.`);
    const headers: Record<string, string> = {};
    if (raw.headers !== undefined) {
      if (!isObject(raw.headers)) problem('`headers` gives each header the name of the secret its value is kept under: `{ "Authorization": "weather-token" }`.');
      else for (const [header, secret] of Object.entries(raw.headers)) {
        if (typeof secret === "string" && secret.trim() !== "") headers[header] = secret.trim();
        else problem(`\`headers\` gives ${header} no secret's name.`);
      }
    }
    runs = { address, method, headers };
  }
  const written = command !== undefined ? { kind: "command-tool" as const, runs: command } : address !== undefined ? { kind: "http-tool" as const, runs: address } : undefined;
  if (problems.length > 0 || runs === undefined) return { problems, ...(written !== undefined ? { written } : {}) };
  return { manifest: { name, family, parameters: takes as JsonObject, runs, ...(typeof timeout === "number" ? { timeout } : {}), path: file.path, level: file.level }, problems, ...(written !== undefined ? { written } : {}) };
}
