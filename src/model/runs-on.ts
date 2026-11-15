// What a definition runs on among one user's connections (C28): the connection its header names, by
// its name or its id (`default`, or none named, his default connection), that connection's model, and
// the effort the agent thinks at, which is its definition's alone (READINGS N-7): where the definition
// names none, the connection's own, and where that names none either, the provider's own default. A
// run's agents are made on the connection `connectionNamed` finds, and the Agents page shows `runOf`.

import type { ConnectionList, ConnectionView, DefinitionRun, Effort } from "../contract";

/** The connection a definition's `model:` names among the user's connections: `default`, or none, his default; any other name a connection's name or id. Undefined where none is there. */
export function connectionNamed(list: ConnectionList, model: string | undefined): ConnectionView | undefined {
  if (model === undefined || model === "default") return list.default === null ? undefined : list.connections.find((c) => c.id === list.default);
  return list.connections.find((c) => c.name === model || c.id === model);
}

/** What a definition runs on, resolved among the user's connections. */
export function runOf(list: ConnectionList, definition: { model?: string; effort?: Effort }): DefinitionRun {
  const connection = connectionNamed(list, definition.model);
  return {
    connection: connection === undefined ? null : { id: connection.id, name: connection.name },
    model: connection?.model ?? null,
    effort: definition.effort ?? connection?.effort ?? null,
  };
}
