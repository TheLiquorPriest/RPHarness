# Writing a host

A host gives RPH an *environment*, its side of the contract in `src/contract/` (`Environment`), and
calls the harness `createHarness(env)` gives back. RPH knows no chat application and no game
engine: everything it reads or keeps goes through these ports. Two hosts exist: RPE, and the folder
host in `src/hosts/folder/` ([folder-host.md](folder-host.md)), a whole host in a few files to read
beside this page.

A host imports only `rp-harness` (`createHarness` and the contract's types), `rp-harness/contract`,
`rp-harness/helpers` (the settings list and its check, the owner-only list, `placeOf`, `runPattern`,
`renderTemplate`, `SHIPPED_GUIDANCE`), `rp-harness/hosts/folder`, `rp-harness/testing/rig` and
`rp-harness/testing/kit`.

## The contract and how it changes

The contract is frozen. It changes only with the lead's sign-off, recorded with its date and the
plan's line, and with both hosts' suites passing the kit. Each member's own comment in `src/contract/`
is its exact duty; this page is the map.

## The ports

Every member names the user it acts for (`Scope`, `RunScope` or `UserScope`) and works on his data
alone. A scope names a user, a chat, a session and, in a turn, the turn; a job of no chat names only
the user and its session.

| Port | Members | What it must do |
|---|---|---|
| `files` (`FilesPort`) | `layers`, `places`, `read`, `find`, `write` | The agents' file tree (§5): the levels farthest first (shipped, global, character, chat), each with its mount and its folders of each kind and its config file; the chat's places (notes, session, turn folders); reads by line range with a hash; finds by list, glob or pattern, saying where it stopped; writes held to where each writer may write, every agent's write in a turn recorded against the turn so a swipe or delete puts it back. A scope that names only the user sees the shipped and global levels, and writes nothing but the global config by the owner's own press. `SHIPPED_GUIDANCE` is the shipped level. |
| `chat` (`ChatPort`) | `info`, `read`, `position`, `search` | The chat's active path: read by position, hidden messages marked and their text withheld unless the chat lets agents read them, summarized ones marked; searched by words. |
| `lore` (`LorePort`) | `read`, `search`, `activated` | Entries of every source the chat is bound to, as the reading agent may know them; what activated for the turn's prompt. |
| `prompt` (`PromptPort`) | `layout`, `map`, `saveMap`, `saveLocated` | The raw layout of the prompt the chat application assembled for the turn, and where prompt maps are kept. RPH finds the slices itself. |
| `tools` (`ToolsPort`) | `all` | The host's own tools, each with its family, tier, lane, schema and what runs it; one that runs a command or calls out names what it runs (`switchable`). |
| `searchers` (`Searcher[]`) | `name`, `search` | What `gap_check` searches besides the chat and lore (a host's records); none is a fine answer. |
| `stores` (`StoresPort`, optional) | `list`, `search`, `read` | Other stores `archive_search` reads: databanks, memory, summaries. |
| `web` (`WebSearchPort`, optional) | `enabled`, `search` | The web searcher; `web_search` says it is off until `enabled` is true. |
| `facts` (`FactsPort`) | `defs`, `read` | Named facts of the moment the rules test and the briefing shows, read as of the scope's turn. |
| `models` (`ModelsPort`) | `loadConnections`, `saveConnections`, `loadSecrets`, `saveSecrets` | Storage for each user's connections document and secrets document, whole, never another user's. Keys are never in the connections, never in the file tree, a transcript or a page. |
| `store` (`StorePort`) | `get`, `set`, `update`, `delete`, `list`, `jobs` | Small durable JSON per user under keys, and the job records (`jobs`: `get`, `set`, `list` a page at a time, `prune`). |
| `trace` (`TracePort`) | `event`, `delta`, `flush` | Everything RPH does, as records in order; streamed text as deltas; `flush` waits for them to be written. |
| `events` (`TurnEvents`) | `intent`, `attachments`, `consent`, `gapCheck`, `dropStaged`, `ruleFired`, `suggestion`, `released`, `ended`, `job` | What RPH tells the host as a turn runs: the lead's intent record, what a sub-agent is given (the host gives its own views' text), a consent grant, a gap check's results, an agent's writes to drop, a rule that fired, a suggestion to file, the reply released, the lead's run over, a job's change. |
| `approvals` (`ApprovalsPort`, optional) | `permission`, `ask` | The user's Auto, Confirm or Never per lane, and his answer to a Confirm. Without it every lane is Auto. A Confirm holds every call of the same model message until it is answered. |
| `switches` (`SwitchesPort`, optional) | `state` | Whether each thing that runs a command or calls out (a hook, a rule's command, a command or HTTP tool, an MCP server, a connection whose key was given for another place) is `on`, `off` or `waiting` for the user, asked by kind, name and exactly what it runs. Only the server's operator switches; a thing just written or changed waits. Without it, all are off. |
| `clock`, `log` | | Time and timers (a test gives the rig's clock), and the host's log. |

## What a host calls

- `harness.answer(request, sink, signal)`: one turn. The request names the scope with its turn, the
  turn it follows (`parent`), its kind (`new`, `swipe`, `regenerate`, `continue`, `impersonate`), the
  lead's definition, the assembled prompt, the host's briefing blocks, what the session carries
  (`carry`), and what happened since the last turn. The reply streams to the sink (`content`, with
  `progress` lines apart) and ends with `finish` or `error`. Give the prompt to the prompt port first.
- `harness.turnLeft(scope)` when a turn leaves the path (a swipe, a delete, or a turn you dropped
  because it kept nothing); `harness.turnShown(scope)` when an earlier attempt is shown again.
- The pages' ways in: `jobs`, `sessions`, `rules`, `live`, `usage`, `definitions`, `models`,
  `promptMap`, `external` (everything that waits to be switched on), `parts`. The members on
  `OWNER_ONLY` (from `rp-harness/helpers`) are called only from the owner's own presses.
- **At start,** list each user's jobs (`harness.jobs.list({ user })`): a job a restart cut off is then
  kept as interrupted and told, and one that only waited is queued again.
- **At shutdown,** `harness.close()`: it stops every run and job (a running job is kept as
  interrupted) and waits for what RPH keeps to be written.

## Checking a host: the kit

`rp-harness/testing/kit` checks each port against what the contract asks, area by area (`files`,
`chat`, `lore`, `prompt`, `facts`, `tools`, `store`, `trace`, `models`). Give it a factory that lays
the kit's seed (`KIT_SEED`: a user, a chat, its files, messages, lore) into a fresh place in your
host's own way and makes the environment over it:

```ts
import { runContractKit, type KitFactory } from "rp-harness/testing/kit";

const make: KitFactory = async (seed, place) => {
  const env = await myHost(seed, place);       // lay the seed, build the environment
  return { env, close: () => env.close() };
};
runContractKit("my host", make);              // under `bun test`
```

`test/hosts/folder-kit.ts` is the folder host's factory. `rp-harness/testing/rig` gives a scripted
model and a clock for a host's own tests of whole turns.
