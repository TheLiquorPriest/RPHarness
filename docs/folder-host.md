# The folder host

A host for RPH over one directory: point it at a folder and play a chat from the command line,
with no chat application. It is also what RPH's own tests run on.

## The directory

```
<dir>/files/                          the agents' tree: the global level
<dir>/files/config.yml                the global config and settings (docs/settings.md)
<dir>/files/.agents/ .skills/ .rules/ .hooks/ .prompts/ .tools/   your files of each kind (docs/files.md)
<dir>/files/defaults/                 the shipped level: RPH's own files, laid there by the first command
<dir>/files/chats/<character>/        a character level (agents/, rules/, skills/)
<dir>/files/chats/<character>/<chat>/ a chat level, the agents' root (agents/, rules/, skills/, hooks/, config.yml,
                                      persistent-workspace/, sessions/, PROMPT-MAP.md, LORE-INDEX.md)
<dir>/host/chats/<chat>/chat.json     the chat: { "character": "<folder>", "preset": null, "user": "<name>", "lore": ["<source>"] }
<dir>/host/chats/<chat>/system.md     what a turn's prompt opens with (the preset, the card); optional
<dir>/host/chats/<chat>/messages.jsonl  the chat's path, one message a line: { "id", "role", "name", "text", "hidden"?, "turn"? }
<dir>/host/lore/*.json                lore entries, one a file: { "id", "source", "title", "keys", "text" }
<dir>/host/facts.json                 the facts the host declares and their values by chat: { "defs": [], "values": {} }
<dir>/host/tools.json                 the tools manifest, unless --manifest names another
<dir>/host/config.json                the host's own limits and its web search's address
<dir>/host/permissions.json           each lane's auto, confirm or never, by chat or "*": { "*": { "world": "confirm" } }
<dir>/host/switches.json              what is switched on: written by `allow` and `deny` alone
<dir>/host/stores/<store>/            other stores archive_search reads (*.md, *.txt; ABOUT.md says what it is)
<dir>/host/records/<name>/            what gap_check searches besides chat and lore, by folder
<dir>/host/user/<hash>/               each user's connections, secrets, store and job records
<dir>/host/log.jsonl                  the log
```

`host/chats/<chat>/` also keeps each turn's given prompt (`turns/<turn>/`), what RPH told the host
(`events.jsonl`) and its trace (`trace.jsonl`, each run's streamed text in `deltas/`).

The tools manifest is `{ "tools": [ { "name", "family", "tier": "read"|"write"|"external", "lane"?, "description" or "descriptionFile", "parameters" (an object schema), "command"? } ] }`.
A tool with a `command` runs it as you with its arguments as JSON on stdin, once switched on; its JSON
answer is the result. From the command line only such tools run (a program that embeds the folder
host gives the others their handlers).

`host/config.json`: `{ "files": { "findLimit": 200, "grepBytes": 1048576, "grepLine": 1000, "listDepth": 1 }, "search": { "hits": 20, "snippet": 80 }, "tools": { "commandTimeout": 30, "answerMax": 1048576 }, "web": { "address": "https://…" } }`;
each left out keeps the number shown. The web searcher is asked `GET <address>?q=<words>&limit=<n>` and
answers a JSON list of `{ "url", "title", "snippet" }`.

## The command line

```
bun src/hosts/folder/cli.ts <dir> [--manifest <file>] [--chat <id>] [--user <name>] [--lead <definition>] [--carry continuing|records|nothing] <command>
```

(`rph-folder` once the package's `bin` names it.) The chat is `--chat`, or the one chat under
`host/chats/`; the user `--user`, or the one `chat.json` names, or the one the host keeps records for;
the lead `--lead`, or the `turn.lead` setting.

| Command | What it does |
|---|---|
| `say "<message>"` | Adds your message to the chat, plays a turn: the reply streams to stdout, progress lines to stderr, and is kept as the chat's next message. A turn that keeps no reply is dropped from the path and the command exits 1. |
| `swipe` | The last reply leaves the path (its notes are put back) and the turn is played again. |
| `jobs [list]` | Your jobs. `jobs start <agent> "<brief>"`, `jobs hold\|letgo\|again\|resume\|cancel <id>`, `jobs carry <id> [--calls N] [--tokens N] [--tokens-in N] [--tokens-out N] [--time S]`, `jobs answer <id> on\|end`. |
| `sessions [list]` | The chat's sessions. `sessions close`, `sessions reopen`, `sessions compact` (at the next turn) act on the scene's session. |
| `waiting` | Everything that runs a command or calls out, and where it stands: your files' hooks, rule commands, command and HTTP tools and MCP servers, the manifest's command tools, connections whose key waits. |
| `allow <name>`, `deny <name>` | The only way one of them is switched on (for exactly what it runs now) or off. |
| `answer` | The questions a lane set to Confirm waits on. `answer <call> yes\|no [reason]` answers one; the turn that asked goes on. |
| `connections` | Your connections, each with its newest tag check. |
| `connect <name> --provider <p> [--model m] [--base-url u] [--api a] [--auth key\|none] [--default]` | Adds a connection, or changes the one of that name, the key read from stdin: `printf %s "$KEY" \| … connect main --provider deepseek --model deepseek-chat`. Providers: `anthropic`, `openai`, `google`, `openrouter`, `deepseek`, `xai`, `groq`, `mistral`, `openai-compatible`, `anthropic-compatible` (the last two need `--base-url`). |
| `tagcheck <connection>` | Whether a connection keeps the reply's tags: plays the turns of your `.prompts/tag-check.md` on it and sets its `connections.<connection>.reply.form` in `files/config.yml`. |
| `secret <name>` | A secret your HTTP tools and MCP servers send, its value from stdin; nothing takes it away. |

Every command first lists your jobs, so a job a cut-off process left running is kept as interrupted
and said; and before it ends it waits for the jobs it left running (an interrupt leaves them to be
resumed with `jobs resume`).

A write to a lane set to `confirm` waits: the command prints the call and how to answer it from a
second terminal (`answer <call> yes`). Every other call of the same model message waits with it.
