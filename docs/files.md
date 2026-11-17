# The files you write

How a turn is run lives in markdown and YAML files you own. RPH reads them through the host's file
port; code holds no text of its own. This page gives every kind of file and its format. RPH's own
shipped files (`guidance/` in this repository) are the lowest level, and each is an example of its kind.

## Levels and folders

Files are read at four levels, farthest first: **shipped** (RPH's own), **global** (yours, for every
chat), **character** (one character's chats), **chat** (one chat). A file of the same name at a nearer
level replaces the farther one, of every kind. A file that does not parse is reported with its path
and line (on the host's Files page, and by the folder host in its log), is not used, and the farther
file of its name is not used in its place either.

Each level keeps each kind in a folder the host names. In the folder host (and in RPE):

| Kind | Shipped and global | Character | Chat |
|---|---|---|---|
| Agent definitions | `.agents/<name>.md` | `agents/` | `agents/` |
| Skills | `.skills/<name>/SKILL.md` | `skills/` | `skills/` |
| Rules | `.rules/<name>.md` | `rules/` | `rules/` |
| Hooks | `.hooks/hooks.yml` | | `hooks/hooks.yml` |
| Prompt parts | `.prompts/<name>.md` | | |
| Tool descriptions, your tools | `.tools/<name>.md`, `.tools/<name>.json`, `.tools/mcp.json` | | |
| Instruction files | `<NAME>.md` at the level's root | the same | the same |
| Config | `config.yml` (global) | | `config.yml` |

Agents see the chat's folder as their root, and the other levels mounted read-only as `@shipped/`,
`@global/` and `@character/`. They write only in the chat's notes folder (`persistent-workspace/`) and
in the turn's own folders (`queries/`, `scratch/`, `output/`, `cache/` under the session's turn folder).

## Config (`config.yml`)

YAML. Besides the settings ([settings.md](settings.md)), five keys:

- `off:` names switched off, at every level: `off: [rules/perceptions-owed, TURN, hooks/sourced-writes, tools/mcp]`.
  An instruction file by its name; anything else as `<kind>/<name>`.
- `layered:` instruction files read at every level that has one, farther first, instead of the nearest
  alone: `layered: [AGENTS]`.
- `added:` the instruction files a kind of turn adds to the briefing: `added: { swipe: [SWIPE], delete: [DELETE] }`.
- `instructions:` files added to the stack of every agent that reads instruction files
  (`instructions: [STYLE, house/canon.md]`), or per agent (`instructions: { gm: [house/rules.md] }`).
  An entry is an instruction file's name, or a path or glob in the agents' view.
- `pins:` files handed whole to an agent at the start of each of its runs:
  `pins: [{ file: persistent-workspace/plan.md, agent: keeper }]`.

`lead:` (a setting) names the definition that leads the chat's turns.

## Agent definitions (`<agents>/<name>.md`)

A YAML header between `---` lines, then the agent's instructions. RPH ships none: the lead and every
agent are yours.

```markdown
---
name: lead
description: The lead of a roleplay; gives the one reply the player sees.
model: default
effort: max
tools: [file_read, file_write, chat_read, lore_search, skill_load, tool_search, tool_use, delegate, reply_release]
reads: [rules]
given:
  - prompt:*
  - session:carry
  - briefing
---
You are the lead of this roleplay ...
```

| Field | What it says |
|---|---|
| `name`, `description` | Its name (the file's) and what it is for. |
| `model` | The connection it runs on, by name or id; `default` (or left out) is the user's default connection. |
| `effort` | How hard its model reasons: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; a level its model does not have is the nearest it has, so `max` is its highest; left out, the connection's own. |
| `tools_as` | How its tools are offered: `auto` (natively until the connection refuses them, then as text), `native`, `text`. |
| `tools` | The tools it holds from its first call. Any other tool it reaches through `tool_search` and `tool_use`. |
| `out_of_reach` | Families of tools it does not reach by searching. |
| `reads` | The instruction files of its stack, and `rules` for the always-on rules it is named in. Their order in the stack is fixed: `ALL-AGENTS`, the rules, `AGENTS`, `WORLD`, `SIMULATION`, `WRITING`, then other files, the definition, then `TURN`, `PRESET`. |
| `given` | What it is handed at the start of a run, by name (below). |
| `opening` | What it is handed once, when its session opens, by the same names. |
| `limits` | Its own limits: `calls`, `tokensIn`, `tokensOut`, `time` (s), `callTokensIn`, `callTokensOut`, `callTime` (s), `toolRounds`, `toolsPerAnswer`, `toolsAtOnce`, `messages`. |
| `writer` | The definition `write_reply` hands the prose to. |

The body is a template ([Templates](#templates)); a sub-agent's may name `{{agent}}`, `{{definition}}`
and `{{plays}}`.

Names `given:` and `opening:` take: `prompt:<name>` (`prompt:*` the whole prompt; `prompt:history[-30:]`;
`prompt:lore[e-112]`; `prompt:message[3]`; a slice by its marker), `session:carry` (what the session
carries from earlier turns), `briefing`, `file:<path>`, `chat:history[scene]`, `chat:history[-30:]`,
`chat:history[#120..#179]`, `lore:<id>`. Any other name is a view the host offers.

## Instruction files (`<NAME>.md`)

Plain markdown at a level's root, no header, never filled in: `ALL-AGENTS.md`, `AGENTS.md`, `WORLD.md`,
`SIMULATION.md`, `WRITING.md`, `TURN.md`, `PRESET.md`, or any name a definition's `reads:` gives.

## Skills (`<skills>/<name>/SKILL.md`)

The Agent Skills shape: a header with `name` and `description`, and a body. Only the name and the
description are in the prompt's index; an agent loads the body with `skill_load`.

## Rules (`<rules>/<name>.md`)

A header and a body, the text the rule puts in front of an agent. `.rules/examples/rule-fields.md`
(shipped) shows every field; a rule under `examples/` is listed and never in force.

- `description:`, and `agents:` (`all`, or a list of definitions: it must be there).
- `needs:` names the rule is in force only while each is: a rule, an instruction file, or `<kind>/<name>`.
- With no trigger the rule is **always on**: its text joins the stack of the agents it names. `turns:`
  hands it over only in the briefings of those kinds of turn instead.
- At most one **trigger**:
  - `condition:` a JavaScript regular expression, with `scope:` (`text`, `thinking`, `reply`,
    `arguments:<tool>` or `result:<tool>`, a glob, `*` for any), `case: ignore`, `interrupt: never`
    (left out, a match on what is being written stops the call) and `hold: true` (on a tool's
    arguments, the text comes back instead of running the tool).
  - `question:` a yes-or-no question put to a judging model about `scope:` (`text`, `thinking`,
    `reply`), with `judge:` (a connection) and `interrupt: always` (the agent waits for the answer).
    The judging model's prompt is `.prompts/judge.md`.
  - `at:` a moment, `turn-start`, `run-end` or `before-compaction`, with or without `fact:` (a test of
    a named fact) or `command:` (a command of yours asked yes or no, once the host switches it on).
  - `every:` a number of turns, with or without `fact:`.
- `repeat:` `once per turn` (left out), `once per session`, `after N turns`, `always`.

The facts a rule can test are RPH's own and the host's; the host's Rules page lists them.

## Prompt parts and tool descriptions (`.prompts/<name>.md`, `.tools/<name>.md`)

An optional header (any fields; `description` and `format` are read) and a body that is a template.
A part whose header says `format: lines` holds one `name: text` line per message; a line you delete is
a message that is not shown. Every text RPH sends a model besides your definitions comes from one of
these: the reply contract (`reply-contract.md`, whose header names the reply's tags), the briefing,
the judging model's prompt, the compaction prompt, the tools' answers (`tool-notices.md`) and the rest
of `guidance/.prompts/`. Each tool RPH offers is described by `.tools/<tool>.md`, and a family's guide
by `.tools/<family>.md`, handed over once a session when a search finds the family.

A host may ship parts RPH does not: `.prompts/tag-check.md` (a lines part) holds the simple turns a
tag check plays on a connection, `ask:` being what each turn asks besides the reply contract.

### Templates

`{{name.path}}` puts a field in; `{{#name}}…{{/name}}` shows its block when the field is there and not
empty (once per item of a list, `{{.}}` the item); `{{^name}}…{{/name}}` when it is absent or empty.
Nothing else. A line that holds only a block's tag leaves no line. A part's own header fields are the
outermost fields.

## Your own tools (`.tools/<name>.json`, `.tools/mcp.json`)

Nothing here runs until the host switches it on (in the folder host, `rph-folder <dir> allow <name>`),
and it waits again once what it runs changes.

A tool's manifest, one per file, the tool named by the file:

```json
{ "family": "dice", "takes": { "type": "object", "properties": { "sides": { "type": "number" } } }, "command": "python3 /srv/tools/dice.py", "timeout": 10 }
```

- `command`: a command line run as you, the arguments as JSON on its stdin; the JSON it prints is the
  result. Or `address`: an http(s) address the arguments are sent to as a JSON body, with `method`
  (`POST`, `PUT`, `PATCH`) and `headers`, each header naming the secret its value is kept under
  (`{ "Authorization": "weather-token" }`); a value is never written in a file.
- `takes`: a JSON schema of an object; `timeout`: seconds, else `tools.commandTimeout` / `tools.httpTimeout`.
- Its description for the model is `.tools/<name>.md` where there is one.

MCP servers, `.tools/mcp.json`, every level's (a nearer server replaces a farther one of its name):

```json
{ "servers": {
  "search": { "command": "uvx", "args": ["search-server"], "env": { "API_KEY": "search-key" }, "description": "Searches the web." },
  "notes": { "address": "https://example.org/mcp", "headers": { "Authorization": "notes-token" } } } }
```

A server starts, or is reached, the first time one of its tools is needed once it is switched on; its
tools are named `<server>_<tool>` and found by `tool_search` under the family of the server's name.

## Hooks (`hooks.yml`)

Your commands, run as you at a moment of a turn, with the moment's JSON on stdin.
`.hooks/examples/hooks.yml` (shipped) explains every moment and is never in force.

```yaml
before-tool:
  - name: sourced-writes
    command: sh /srv/hooks/check-source.sh
    timeout: 10
```

- Moments: `turn-start`, `before-tool`, `after-tool`, `before-release`, `after-release`, `run-end`,
  `session-close`, `before-compaction`, `job-start`, `job-end`.
- Each hook has a `name`, a `command` exactly as you would type it, and a `timeout` in seconds
  (else `hooks.timeout`). The hooks of a moment run one after another, the farthest level's first and
  each file in its order; a nearer hook replaces a farther one of its name; `off: [hooks/<name>]`
  switches one off. A hook runs only once the host has switched it on.
- The input always holds `hook` and `event`, and where the moment has them `scope` and `agent`;
  `before-tool` adds `tool`, `callId`, `args`, and `after-tool` the `result`.
- It answers with JSON on stdout: `{"decision": "block", "reason": "…"}` blocks; `{"context": "…"}`
  adds a line to what is told next; `{"input": {…}}` before a tool gives the arguments the call goes
  with. Exiting with `hooks.blockExit` (2) blocks too, its stderr the reason. Any other failure, an
  answer past `hooks.answerMax`, or a timeout blocks nothing and shows in the trace.
- The hooks before a tool run before any call of the model's message runs, so a slow one holds the
  message's other calls. A tool reached through `tool_use` is hooked as itself.

## Sessions

Each scene of a chat is a session; so is each sub-agent's run, each job's and each talk. A session is
a file of entries, `sessions/<session>/<session>.jsonl` in the chat's folder, one line an entry,
written by RPH alone, with each turn's folder beside it (`sessions/<session>/turns/<turn>/`: the
agents' `queries/`, `scratch/`, `output/` and `cache/`, and RPH's transcripts and kept requests).
What a turn carries from the turns before it is the request's `carry`: `continuing` (what was done, as
text), `records` (its record of each turn) or `nothing`. A session is compacted only when a call would
not fit, or when you ask (`sessions compact`); the turns a summary stands for are kept, and the summary
can be undone.
