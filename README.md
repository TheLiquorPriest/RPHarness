# RPHarness

RPH is a harness for roleplay and creative writing, built on pi's agent loop.

A host hands it an *environment* (a chat, its lore, a file tree, the host's own tools) and a request to answer. RPH runs a lead agent with tools, sub-agents, sessions, rules and jobs, and releases one reply per generation. It knows what a chat turn is. It does not know any chat application, and it does not know any game engine.

How a turn is run is not in this code. It is in markdown files the user owns: agent definitions, instruction files, skills, rules, tool descriptions and prompt parts. RPH loads them, gives agents their tools, checks the triggers of the user's rules and holds agents to the user's limits. Every text a model reads comes from one of those files, from the host's request, from stored data, or from a model. Code writes none of its own.

## Status

Working, and young. One host embeds it today: [LumiRPEngine](https://github.com/TheLiquorPriest/LumiRPEngine), a roleplay engine for Lumiverse. A second, small host ships here (`src/hosts/folder/`): point it at a folder and it runs. The contract between a host and RPH (`src/contract/`) is frozen: it changes only with the lead's sign-off, recorded with its date and the plan's line, and with both hosts' suites passing the kit.

What it has:

- **A turn for a lead agent** on pi's loop: limits, stop codes, a trace of every call, and each connection's throttle (its requests and tokens a minute and its calls at once, across every agent, turn and job, each wait in the trace).
- **The reply in three forms,** set per connection: tagged in the lead's message, written in two steps, or the whole message. One reply per turn, released once.
- **Guidance from files:** definitions, the instruction stack by level (shipped, the user's, a character's, a chat's), skills, prompt parts, and rules that fire on events, on facts the host gives, at a run's end, or on a yes-or-no question judged by a model.
- **Sub-agents** (`delegate`, `ask_author`, `agent_message`, `agent_drop`) that own what they wrote.
- **Tools:** file tools held to where an agent may write, chat and lore reading, a gap check, a to-do list, skills, suggestions, and a search over every tool that is not in an agent's fixed list (`tool_search`, `tool_use`). Each tool's description is a file.
- **Sessions** as files: what a turn carries from the turns before it, in three ways; compaction only when a call would not fit, with the turns it summarizes kept.
- **Jobs:** background runs that go on after the reply, within the user's limits.
- **The prompt map:** any part of the assembled prompt read by name, from the first turn.
- **Approvals at the gate,** switches for anything that runs a command or calls out, and every limit a setting.
- **A scripted-model rig and a kit** any host must pass (`src/testing/`).
- **The owner's own tools and commands,** each doing nothing until it is switched on from the host's server, and waiting again once what it runs changes; `Harness.external.list` names every one with where it stands:
  - **Command tools:** `.tools/<name>.json` names a command line; a call sends the arguments as JSON on its stdin, and the JSON it prints is the result.
  - **HTTP tools:** `.tools/<name>.json` names an address; a call posts the arguments as JSON there, with headers whose values are secrets kept apart from the files, and the JSON answered is the result.
  - **MCP servers:** `.tools/mcp.json` names each server, started by a command or reached at an address; its tools are found by `tool_search` and called with a timeout.
  - **Rule commands:** a rule's `command:` is asked yes or no at the moment its `at:` names.
  - **Hooks:** `hooks.yml` names commands run at the moments of a turn (a tool call, the release, a run's end, a session's close, a job's start and end, ...), each able to add context, change a tool's input, keep a run going, or block with a reason.
- **A tag check** per connection: simple turns played on it measure whether it keeps the reply's tags, and set its reply form.

## Layout

| Path | What it holds |
|---|---|
| `src/contract/` | What a host implements and what RPH offers it. A host imports only this, `createHarness` (with the members of `Harness`, `parts` among them), the pure helpers of `rp-harness/helpers`, and the entries `rp-harness/hosts/folder`, `rp-harness/testing/rig` and `rp-harness/testing/kit`. |
| `src/harness/` | `createHarness`: a whole turn for the lead; the gate; settings; the judge. |
| `src/loop/` | The agent runner on pi: limits, stop codes, rules in the loop, trace. |
| `src/reply/` | The reply and its forms. |
| `src/files/` | File tools; definitions, skills, rules and prompt parts loaded from files; the rule engine. |
| `src/agents/` | Sub-agents and what each owns. |
| `src/tools/` | The base tools and the tool search. |
| `src/sessions/` | Sessions as files, what is carried, compaction. |
| `src/jobs/` | Background runs. |
| `src/prompt/` | The prompt map. |
| `src/model/` | The model layer on `pi-ai`: connections, limits read from pi, token counts, each connection's throttle, a key held to the place it was given for, requests passed through. |
| `src/hosts/folder/` | A second host: point it at a directory and a tools manifest and it runs. |
| `src/testing/` | The scripted-model rig and the kit any host must pass. |
| `guidance/` | The files RPH ships: its tools' descriptions, its prompt parts, one rule. A host's own files replace any of them by name. |

## Use it from a host

```ts
import { createHarness } from "rp-harness";

const harness = createHarness(env);                        // env: the host's side of the contract
const outcome = await harness.answer(request, sink, signal); // the reply goes to the sink as it is written
```

`env` is the host's implementation of `src/contract/`: the chat, lore, files, models, a store, a log, the host's own tools, and the events through which it is told what happens while a turn runs. `request` says which chat and turn to answer and what the chat application assembled for it. `src/hosts/folder/` is a whole host in a few files, and `src/testing/kit/` is what a host's implementation must pass. [docs/hosts.md](docs/hosts.md) goes through it port by port.

## A first reply, on the folder host

From a fresh clone, with a key for one of the providers (here DeepSeek):

```sh
bun install
mkdir -p play/host/chats/harbor play/files/.agents
echo '{ "character": "wren", "preset": null, "user": "me" }' > play/host/chats/harbor/chat.json
echo 'You are Wren Hale, keeper of the lighthouse. Write in the second person.' > play/host/chats/harbor/system.md
cat > play/files/.agents/lead.md <<'EOF'
---
name: lead
description: The lead of the roleplay. It gives the one reply the player sees.
model: default
effort: max
tools: [chat_read, file_read, file_write]
reads: [rules]
given:
  - prompt:*
  - session:carry
  - briefing
---
You are the lead of this roleplay: read what the player wrote and everything you were given, and write the reply.
EOF
echo 'lead: lead' > play/files/config.yml
printf %s "$DEEPSEEK_API_KEY" | bun src/hosts/folder/cli.ts play connect main --provider deepseek --model deepseek-chat
bun src/hosts/folder/cli.ts play say "I climb the stairs to the lamp room."
```

The reply streams as it is written and is kept in `play/host/chats/harbor/messages.jsonl`; `say` again
goes on, `swipe` plays the turn again. The first command lays RPH's shipped files in `play/files/defaults/`.

## Docs

- [docs/files.md](docs/files.md): every kind of file you write, and its format.
- [docs/settings.md](docs/settings.md): every setting, its default, and where it may be set.
- [docs/folder-host.md](docs/folder-host.md): the folder host's directory and its command line.
- [docs/hosts.md](docs/hosts.md): writing a host, port by port, and checking it with the kit.

## Develop

```sh
bun install
bun run typecheck
bun test
```

Bun 1.4 or newer.

## License

MIT. See `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`.
