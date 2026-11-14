# RPHarness

RPH is a harness for roleplay and creative writing, built on pi's agent loop.

A host hands it an *environment* (a chat, its lore, a file tree, the host's own tools) and a request to answer. RPH runs a lead agent with tools, sub-agents, sessions, rules and hooks, and releases one reply per generation. It knows what a chat turn is. It does not know any chat application, and it does not know any game engine.

How a turn is run is not in this code. It is in markdown files the user owns: agent definitions, instruction files, skills and rules. RPH loads them, gives agents their tools, checks the triggers of the user's rules and holds agents to the user's limits.

## Status

Early. This repository started as a copy of [LumiAH](https://github.com/TheLiquorPriest/LumiAH); that tree is kept under `legacy/` as the reference while each part is rebuilt on pi's loop, and is removed when nothing reads it any more.

## Layout

| Path | What it holds |
|---|---|
| `src/contract/` | What a host implements and what RPH offers it. The only thing a host imports besides `createHarness`. |
| `src/loop/` | The agent runner on pi: limits, stop codes, throttles, trace. |
| `src/files/` | File tools; definitions, skills, rules and prompt parts loaded from files; rules that trigger. |
| `src/tools/` | The tool registry, base tools, the tool search, the prompt map, sub-agents. |
| `src/reply/` | The reply and its forms, the turn's life, jobs. |
| `src/sessions/` | Sessions as files, forks, compaction. |
| `src/model/` | The model layer on `pi-ai`: connections, limits read from pi, token counts. |
| `src/hosts/folder/` | A second host: point it at a directory and a tools manifest and it runs. |
| `src/testing/` | The scripted-model rig and the kit any host must pass. |
| `spikes/` | Runnable measurements, each with what it found. |

## Develop

```sh
bun install
bun run typecheck
bun test
```

Bun 1.4 or newer.

## License

MIT. See `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.md`.
