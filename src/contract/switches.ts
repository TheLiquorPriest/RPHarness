// What may run a command or call out (§16): a hook, a rule's command, a command tool, an MCP
// server, the address an HTTP tool calls, and a connection's key at the place its connection now
// goes to. None of them acts until it is switched on from the host's own command line; one written
// in a file, or added in the UI, waits. The host keeps that registry, and only its own command line
// changes it. RPH only reads it, and lists what waits.

/**
 * The kinds of thing that run a command or call out. A `connection` is one whose key or headers'
 * values were given for another place than it now goes to, or kept with no place (READINGS R-53):
 * its `name` is the connection's, its `target` its place as the model layer writes it (`placeOf`).
 */
export type SwitchableKind = "hook" | "rule-command" | "command-tool" | "mcp-server" | "http-tool" | "connection";

/** A thing that runs a command or calls out, as its file or the UI names it. */
export interface Switchable {
  kind: SwitchableKind;
  name: string;
  /**
   * What it runs or calls, exactly as written: the command line, or the address. It is part of
   * what was switched on: once it changes, the thing waits again, so a file edited after the
   * switch cannot point a switched-on name at another command or address (§16).
   */
  target: string;
}

/** Where a thing stands: switched on; waiting to be (written in a file or added in the UI, or never seen by the registry); or switched off. */
export type SwitchState = "on" | "waiting" | "off";

/**
 * The host's registry of what is switched on, each user's own (C31, R-9, §16): the commands and
 * addresses written in his files run as him, so a thing switched on for one user is not on for
 * another of the same kind, name and target. Without it, everything that runs a command or calls
 * out is off.
 */
export interface SwitchesPort {
  /** Where a thing stands for the user. A thing the registry has never seen for him waits. */
  state(user: string, thing: Switchable): Promise<SwitchState>;
}
