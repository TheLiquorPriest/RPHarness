// His MCP servers (§5.4 "Tools", P15): `<tools>/mcp.json` at any level, `{ "servers": { "<name>": … } }`,
// each started by a command (`command`, its `args`, and `env`: variables given the values of the
// secrets named) or reached at an address (`address`, and `headers`: each header given the value of
// the secret named). No value is ever written in the file: it names secrets, which the secrets
// document keeps (C4). `description`, his words for what the server is for, is what a search finds it
// by while it waits to be switched on, when its tools are not yet known. A nearer level's server
// replaces a farther one's of the same name. A server that cannot be read whole is a problem on the
// Files page, and left out; nothing is guessed.

import type { FileText, LayerLevel } from "../contract/index";
import type { Problem } from "./api";

/** A name a server goes by: the family its tools are found under, and the front of their names. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** An MCP server as his file writes it. */
export interface McpServer {
  name: string;
  /** Exactly what it runs, as one command line (its command, then each argument quoted), or the address it is reached at with its headers' secrets' names. */
  runs: { command: string } | { address: string; headers: Record<string, string> };
  /** For a server started by a command: each environment variable, with the name of the secret its value is. */
  env: Record<string, string>;
  /** His words for what it is for: what a search finds it by while it waits. */
  description?: string;
  path: string;
  level: LayerLevel;
}

/** A server of a file as read: the server where it reads whole, what it runs or calls as far as it says, and why it is left out. */
export interface McpRead {
  name: string;
  path: string;
  level: LayerLevel;
  server?: McpServer;
  /** Its command line or address, where the file gives one. */
  written?: string;
  problems: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An argument as a shell reads it back: bare where it is plain, else in single quotes. */
function quoted(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Each name with the secret's name it is given, or a problem for what is not one. */
function secretNames(value: unknown, field: string, problem: (message: string) => void): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === undefined) return out;
  if (!isObject(value)) {
    problem(`\`${field}\` gives each its secret's name: \`{ "API_KEY": "search-key" }\`.`);
    return out;
  }
  for (const [name, secret] of Object.entries(value)) {
    if (typeof secret === "string" && secret.trim() !== "") out[name] = secret.trim();
    else problem(`\`${field}\` gives ${name} no secret's name.`);
  }
  return out;
}

/** The servers of one `mcp.json`, each read or with its problems; a file that is not one is a problem of its own. */
export function parseMcp(file: FileText): { servers: McpRead[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const fileProblem = (message: string) => problems.push({ path: file.path, level: file.level, message });
  let raw: unknown;
  try {
    raw = JSON.parse(file.text);
  } catch (error) {
    fileProblem(`mcp.json is not JSON (${error instanceof Error ? error.message : String(error)}), so none of its servers is read.`);
    return { servers: [], problems };
  }
  if (!isObject(raw) || !isObject(raw.servers)) {
    fileProblem('mcp.json is one JSON object whose `servers` names each server: `{ "servers": { "search": { "command": "uvx", "args": ["search-server"] } } }`.');
    return { servers: [], problems };
  }
  const servers: McpRead[] = [];
  for (const [name, given] of Object.entries(raw.servers)) {
    const own: string[] = [];
    const problem = (message: string) => own.push(message);
    if (!SERVER_NAME.test(name)) problem("A server's name is letters, digits, `_` and `-`, at most 32 long.");
    let runs: McpServer["runs"] | undefined;
    let written: string | undefined;
    let env: Record<string, string> = {};
    let description: string | undefined;
    if (!isObject(given)) problem("A server is an object: a `command` it is started by, or an `address` it is reached at.");
    else {
      if (typeof given.description === "string" && given.description.trim() !== "") description = given.description.trim();
      else if (given.description !== undefined) problem("`description` is one line of text: what the server is for.");
      const command = typeof given.command === "string" && given.command.trim() !== "" ? given.command.trim() : undefined;
      const address = typeof given.address === "string" && given.address.trim() !== "" ? given.address.trim() : undefined;
      if ((command === undefined) === (address === undefined)) problem("A server is started by a `command` or reached at an `address`: one of the two.");
      else if (command !== undefined) {
        const args = given.args ?? [];
        if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) problem('`args` is a list of the command\'s arguments, each text: `["--port", "0"]`.');
        else written = [command, ...args.map(quoted)].join(" ");
        if (given.headers !== undefined) problem("`headers` goes with `address`, and is not read for a command.");
        env = secretNames(given.env, "env", problem);
        if (written !== undefined) runs = { command: written };
      } else if (address !== undefined) {
        written = address;
        let url: URL | undefined;
        try {
          url = new URL(address);
        } catch {
          url = undefined;
        }
        if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) problem("`address` is a whole http or https address.");
        if (given.args !== undefined || given.env !== undefined) problem("`args` and `env` go with `command`, and are not read for an address.");
        runs = { address, headers: secretNames(given.headers, "headers", problem) };
      }
    }
    for (const message of own) problems.push({ path: file.path, level: file.level, message: `Server ${name}: ${message}` });
    servers.push({ name, path: file.path, level: file.level, ...(own.length === 0 && runs !== undefined ? { server: { name, runs, env, ...(description !== undefined ? { description } : {}), path: file.path, level: file.level } } : {}), ...(written !== undefined ? { written } : {}), problems: own });
  }
  return { servers, problems };
}
