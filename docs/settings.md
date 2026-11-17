# Settings

Every setting RPH reads, as a config file writes it (`config.yml` at the global level, or a chat's): a
dotted key is nested YAML (`limits.turn.calls: 40` is `limits:\n  turn:\n    calls: 40`). A nearer
level's value stands over a farther one's. `~` sets none where a setting takes it. A value a setting
does not take is logged and its default holds; a key RPH does not read is logged. `<connection>` stands
for a connection's name or id, `<definition>` for an agent definition's name.

A host lists these from `rp-harness/helpers` (`SETTINGS`: each key, what it takes, its default, its
name and what it is for) and checks a value with `checkSettingValue`; RPE shows them on its Settings
page, and the per-connection ones on its Connections page.

Levels: every level where none is named; `shipped, global` means a chat's own file cannot set it.

## `limits`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `limits.turn.calls` | whole ≥ 1 | no limit | all | **Calls in a turn.** Model calls all the agents of one turn may make between them. |
| `limits.turn.tokensIn` | whole ≥ 1 | no limit | all | **Tokens sent in a turn.** Tokens sent to models across all the agents of one turn. |
| `limits.turn.tokensOut` | whole ≥ 1 | no limit | all | **Tokens written in a turn.** Tokens models write across all the agents of one turn. |
| `limits.turn.time` | whole ≥ 1 | no limit | all | **Time for a turn.** Seconds one turn may take, all its agents' work included. |
| `limits.turn.toolRounds` | whole ≥ 1 | no limit | all | **Tool rounds in a turn.** Answers that call tools, across all the agents of one turn; past it the turn's work ends at this limit. |
| `limits.turn.depth` | whole ≥ 0 | 2 | all | **Sub-agent depth.** How deep sub-agents may go: at 1 only the lead starts them, at 2 they may start their own, at 0 none is started. |
| `limits.turn.agents` | whole ≥ 0 | no limit | all | **Sub-agents in a turn.** Sub-agents one turn may start in all. |
| `limits.turn.agentsAtOnce` | whole ≥ 1 | 3 | all | **Sub-agents at once.** Sub-agents of one run at work at the same time; one more waits for a place, first come first served. |
| `limits.toolsAtOnce` | whole ≥ 1 | 4 | all | **Tool calls at once.** An answer's tool calls that run at the same time, for an agent whose definition sets none of its own; one more waits for a place. |
| `limits.repeats` | whole ≥ 2 | 10 | all | **Same call in a row.** The same tool call with the same arguments this many times in a row, with nothing written by any agent between, ends that agent's work at this limit. |
| `limits.cachedWeight` | number ≥ 0, ≤ 1 | 0.1 | all | **Weight of a cached token.** What a token read again from a provider's cache counts for against every limit on tokens sent, from 0 to 1: an agent's, a turn's, a job's and a day's. |
| `limits.day.tokens` | whole ≥ 1 | no limit | all | **Tokens in a day.** Tokens, sent and written, that all your agents may spend over any 24 hours, turns and jobs alike; past it no call is made. |
| `limits.answerFloor` | whole ≥ 1 | 256 | all | **Least room for an answer.** Tokens an answer must have left at least, across every limit on tokens written; with less, no call is made and the work ends at the limit. |

## `agents`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `agents.<definition>.effort` | off \\| minimal \\| low \\| medium \\| high \\| xhigh \\| max | as its definition says | all | **Effort.** How hard this agent's model reasons, in place of its definition's effort: off to max; a level its model does not have is the nearest it has. `~`: its connection's. |
| `agents.<definition>.limits.calls` | whole ≥ 1 | as its definition says | all | **Calls.** Model calls this agent may make in one stretch of its work; past it its work ends at this limit. `~`: no limit. |
| `agents.<definition>.limits.tokensIn` | whole ≥ 1 | as its definition says | all | **Tokens sent.** Tokens this agent's calls may send in one stretch of its work. `~`: no limit. |
| `agents.<definition>.limits.tokensOut` | whole ≥ 1 | as its definition says | all | **Tokens written.** Tokens this agent's model may write in one stretch of its work. `~`: no limit. |
| `agents.<definition>.limits.time` | whole ≥ 1 | as its definition says | all | **Time.** Seconds one stretch of this agent's work may take. `~`: no limit. |
| `agents.<definition>.limits.callTokensIn` | whole ≥ 1 | as its definition says | all | **Tokens sent in a call.** Tokens one call of this agent may send, as estimated before it is sent. `~`: no limit. |
| `agents.<definition>.limits.callTokensOut` | whole ≥ 1 | as its definition says | all | **Tokens written in a call.** Tokens the answer to one call of this agent may take. `~`: no limit. |
| `agents.<definition>.limits.callTime` | whole ≥ 1 | as its definition says | all | **Time for a call.** Seconds one call of this agent may take, apart from the wait on a silent answer. `~`: no limit. |
| `agents.<definition>.limits.toolRounds` | whole ≥ 1 | as its definition says | all | **Tool rounds.** Answers of this agent that call tools, in one stretch of its work. `~`: no limit. |
| `agents.<definition>.limits.toolsPerAnswer` | whole ≥ 1 | as its definition says | all | **Tool calls in an answer.** Tool calls one answer of this agent may make; the calls past it are answered and not run. `~`: no limit. |
| `agents.<definition>.limits.toolsAtOnce` | whole ≥ 1 | as its definition says | all | **Tool calls at once.** This agent's tool calls of one answer that run at the same time; one more waits for a place. `~`: as limits.toolsAtOnce says. |
| `agents.<definition>.limits.messages` | whole ≥ 0 | as its definition says | all | **Messages after its first answer.** Messages this agent may be sent after its first answer, as a sub-agent; one past it is answered and the agent is not run. `~`: no limit. |

## `usage`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `usage.keptRuns` | whole ≥ 1 | 1000 | shipped, global | **Runs whose usage is kept.** Finished runs whose calls and tokens can still be asked for, a restart between; past it the oldest goes. |

## `jobs`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `jobs.atOnce` | whole ≥ 1 | 2 | all | **Jobs at once.** Jobs that run at the same time, across all your chats; a job started past it waits for a place. |
| `jobs.perDay` | whole ≥ 1 | no limit | all | **Jobs in a day.** Jobs that may be started in a day. |
| `jobs.perRun` | whole ≥ 0 | no limit | all | **Jobs one run may start.** Jobs the agents of one run, a turn's or a job's, may start; 0 starts none. |
| `jobs.tokensPerDay` | whole ≥ 1 | no limit | all | **Job tokens in a day.** Tokens, sent and written, that all your jobs may spend in a day; past it no job starts, and a running job stops at its next call. |
| `jobs.connections.<connection>.atOnce` | whole ≥ 1 | no limit of its own | all | **Jobs at once on a connection.** Jobs on this connection that run at the same time. |
| `jobs.connections.<connection>.perDay` | whole ≥ 1 | no limit of its own | all | **Jobs in a day on a connection.** Jobs on this connection that may be started in a day. |
| `jobs.run.calls` | whole ≥ 1 | no limit | all | **Calls in a job's run.** Model calls all the agents of one job's run may make between them. |
| `jobs.run.tokensIn` | whole ≥ 1 | no limit | all | **Tokens sent in a job's run.** Tokens sent to models across all the agents of one job's run. |
| `jobs.run.tokensOut` | whole ≥ 1 | no limit | all | **Tokens written in a job's run.** Tokens models write across all the agents of one job's run. |
| `jobs.run.time` | whole ≥ 1 | no limit | all | **Time for a job's run.** Seconds one job's run may take. |
| `jobs.run.agents` | whole ≥ 0 | no limit | all | **Sub-agents in a job's run.** Sub-agents the agents of one job's run may start in all; 0 starts none. |
| `jobs.keepDays` | whole ≥ 1 | 90 | all | **Days a job is kept.** Days the record of a job is kept; the older ones are removed when the next job starts. |

## `lead`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `lead` | text | the asking agent's own | shipped, global, chat | **The Author.** The definition that leads the chat's turns, the Author: in a job, its connection judges a rule's question where neither the rule nor rules.judge names one. |

## `calls`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `calls.silentAfter` | whole ≥ 1 | 300 | all | **Silent answer ends after.** Seconds an answer that has begun may go with nothing from its server before it is ended. |
| `calls.providerWait` | whole ≥ 1 | 60 | shipped, global | **Provider wait.** Seconds a provider has to answer a connection's test or list its models. |
| `calls.signInOpen` | whole ≥ 1 | 600 | shipped, global | **Sign-in stays open.** Seconds a sign-in to a provider stays open for you to finish it. |
| `calls.testRoom` | whole ≥ 1 | 64 | shipped, global | **Test call's room.** Tokens a connection's test call lets its answer take. |
| `calls.listMost` | whole ≥ 1 | 8 | shipped, global | **Most of a model list read.** Megabytes of a server's list of its models that are read; a longer list is refused. |
| `calls.quoted` | whole ≥ 1 | 80 | shipped, global | **Address quoted in a refusal.** Characters of a media address that the words of a refused request quote. |
| `calls.signInWordsKept` | whole ≥ 0 | 600 | shipped, global | **Failed sign-in's words kept.** Seconds the words of why a sign-in did not finish are kept to be shown. |
| `calls.wordsMost` | whole ≥ 1 | 2000 | shipped, global | **Length of failure words.** Characters of a provider's or a call's failure words that are kept; the rest is cut. |
| `calls.secretFloor` | whole ≥ 1 | 8 | shipped, global | **Length a secret is looked for at.** Characters from which a key or a header's value is taken out of a provider's words wherever it stands; a shorter one is taken out where it stands as a word of its own. A key shorter than this is refused. |
| `calls.retryWait` | whole ≥ 0 | 1 | shipped, global | **Wait before a retry.** Seconds before a failed call is made again the first time; each wait after is twice the one before. |
| `calls.retries` | whole ≥ 0 | 2 | shipped, global | **Retries of a failed call.** Times a call that failed before any answer came is made again, where its connection sets no number of its own. |
| `calls.cacheRetention` | none \\| short \\| long | short | shipped, global | **Prompt cache retention.** How long a provider is asked to keep a prompt in its cache: none, short or long. |
| `calls.toolRefusalMinutes` | whole ≥ 1 | 60 | shipped, global | **Native tools tried again after.** Minutes a connection's model that refused native tools is offered them as text; then native tools are tried again. |
| `calls.effortRefusalMinutes` | whole ≥ 1 | 60 | shipped, global | **Refused thinking level tried again after.** Minutes a connection's model that refused a thinking level is sent the next level down it has at once; then the refused level is tried again. |

## `throttles`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `throttles.connections.<connection>.requestsPerMinute` | whole ≥ 1 | no limit | shipped, global | **Requests a minute on a connection.** Calls sent on this connection over any minute, across every agent, turn and job; one past it waits for room. |
| `throttles.connections.<connection>.tokensPerMinute` | whole ≥ 1 | no limit | shipped, global | **Tokens a minute on a connection.** Tokens sent and written on this connection over any minute; a call waits for room, and one bigger than the whole minute is not made. |
| `throttles.connections.<connection>.atOnce` | whole ≥ 1 | as every connection | shipped, global | **Calls at once on a connection.** Calls on this connection under way at the same time; one past it waits in line, first come first served. |
| `throttles.atOnce` | whole ≥ 1 | no limit | shipped, global | **Calls at once on any connection.** Calls under way at the same time on each connection that sets no number of its own. |

## `embedding`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `embedding.connection` | text | no search by meaning | shipped, global | **Embedding connection.** The connection, by its name or id, that makes the vectors a search by meaning compares; none: nothing is searched by meaning. Its provider must offer embeddings (OpenAI, Google Gemini, Mistral, an OpenAI-compatible server). |
| `embedding.model` | text | none named | shipped, global | **Embedding model.** The model on the embedding connection that makes the vectors, such as text-embedding-3-small; the connection's own chat model makes none. |
| `embedding.batch` | whole ≥ 1 | 64 | shipped, global | **Texts per embedding request.** Texts sent in one request for their vectors; more go in further requests. |

## `tokens`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `tokens.charsPerToken` | number ≥ 0.5 | 3.2 | all | **Characters per token.** Characters counted as one token when a prompt is measured before its provider counts it: whether a call fits, when to compact, and the trace's figures. |

## `sampling`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `sampling.<definition>.temperature` | number ≥ 0, ≤ 2 | the provider's own | all | **Temperature.** The temperature every call of this agent is made with; unset, its provider's own. |
| `sampling.<definition>.top_p` | number ≥ 0, ≤ 1 | the provider's own | all | **Top P.** The top P every call of this agent is made with, where its provider takes one; unset, its provider's own. |
| `sampling.<definition>.top_k` | whole ≥ 0 | the provider's own | all | **Top K.** The top K every call of this agent is made with, where its provider takes one; unset, its provider's own. |
| `sampling.<definition>.frequency_penalty` | number ≥ -2, ≤ 2 | the provider's own | all | **Frequency penalty.** The frequency penalty every call of this agent is made with, where its provider takes one; unset, its provider's own. |
| `sampling.<definition>.presence_penalty` | number ≥ -2, ≤ 2 | the provider's own | all | **Presence penalty.** The presence penalty every call of this agent is made with, where its provider takes one; unset, its provider's own. |
| `sampling.<definition>.repetition_penalty` | number ≥ 0 | the provider's own | all | **Repetition penalty.** The repetition penalty every call of this agent is made with, where its provider takes one; unset, its provider's own. |

## `reply`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `reply.form` | tags \\| two-step | tags | all | **Reply form.** How a connection marks its reply: with tags, or in two steps for a connection that does not keep them. |
| `reply.forms.<connection>` | tags \\| two-step | as reply.form says | all | **Reply form of a connection.** The reply form of this connection, in place of the one every connection takes. |
| `reply.check.turns` | whole ≥ 1 | 30 | all | **Turns a tag check plays.** Simple turns a tag check plays on a connection to see whether it keeps the reply's tags. |
| `reply.check.kept` | whole ≥ 1 | 28 | all | **Turns that must keep the tags.** Turns of a tag check that must come back with the reply and the intent record in their tags for the connection to be given the tag form; fewer give it the two-step form. |
| `reply.streamAnyway` | names | none | all | **Two-step connections that stream.** Two-step connections whose replies are shown as they are written, not when their message ends. |
| `reply.heldSentences` | whole ≥ 0 | 1 | all | **Sentences held back.** Sentences the reply is held back by while a rule that interrupts covers it. |
| `reply.tailSentences` | whole ≥ 1 | 3 | all | **Sentences shown again.** Sentences of what was already shown that go with the line an agent goes on under after a rule stopped it. |
| `reply.leadSampling` | own \\| preset | own | all | **The lead's sampling.** Whether the lead samples as its own model does, or as the chat's preset says. |

## `progress`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `progress.show` | all \\| least | all | all | **Progress lines.** All the progress lines in the chat's thinking block, or the least: only the line that keeps a silent turn alive. |
| `progress.silence` | whole ≥ 1, ≤ 540 | 60 | all | **Silence before a progress line.** Seconds of nothing shown before a progress line goes to the chat's thinking block; at most nine minutes, since a generation that shows nothing for ten is ended. |

## `results`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `results.clip` | whole ≥ 1 | no ceiling | all | **Length of a tool's answer.** The most characters of a tool's answer, its reports with it, that the model reads, where you set one; without it an answer is cut only where it would not fit the call. The whole answer is kept in a file. |

## `tools`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `tools.search` | whole ≥ 1 | 8 | all | **Tools a search gives.** Tools one tool_search gives when the agent asks for no number. |
| `tools.gapCheck` | whole ≥ 1 | 20 | all | **Hits a gap check takes.** Hits gap_check takes from each place it searches when the agent asks for no number. |
| `tools.perCall` | whole ≥ 1 | 100 | all | **The most one tool call takes.** Messages chat_read gives, entries lore_read reads, hits a search asks each place for, and messages a stretch of the chat an agent is given holds. |
| `tools.schemaShown` | whole ≥ 0 | 600 | all | **Schema shown with a call that does not fit.** Characters of a tool's schema shown whole in the answer to a call that does not fit it; a longer schema is left out of that answer. |
| `tools.fixedTokens` | whole ≥ 1 | 8000 | all | **Size of an agent's tool list.** Tokens an agent's fixed list of tools, as its requests carry it, should stay under; a list over it is marked in the live view and on the Turn page, and still runs. |
| `tools.commandTimeout` | whole ≥ 1 | 30 | all | **Time a command tool may take.** Seconds one of your command tools may run when its manifest names no timeout; past them it is stopped and the agent is told. |
| `tools.httpTimeout` | whole ≥ 1 | 30 | all | **Time an HTTP tool may take.** Seconds one of your HTTP tools may wait for its address's answer when its manifest names no timeout; past them the call is given up and the agent is told. |
| `tools.answerMax` | whole ≥ 1 | 1048576 | all | **The most read of a tool's answer.** Bytes read of what a command tool, an HTTP tool or an MCP server answers; past them the answer is cut and the agent is told. |

## `mcp`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `mcp.startTimeout` | whole ≥ 1 | 30 | all | **Time an MCP server may take to start.** Seconds one of your MCP servers may take to start, or to answer at its address, and list its tools; past them it is stopped and its tools are not offered this time. |
| `mcp.callTimeout` | whole ≥ 1 | 60 | all | **Time an MCP tool may take.** Seconds one call of an MCP server's tool may take; past them the call is given up and the agent is told. |

## `hooks`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `hooks.timeout` | whole ≥ 1 | 30 | all | **Time a hook may take.** Seconds one of your hooks may take where hooks.yml names no timeout of its own; past them it is stopped, blocks nothing, and is shown as timed out. |
| `hooks.blockExit` | whole ≥ 1 | 2 | all | **Exit code that blocks.** The exit code with which a hook blocks, its error output as the reason; any other failing code blocks nothing and is shown as failed. |
| `hooks.answerMax` | whole ≥ 1 | 1048576 | all | **Most of a hook's answer read.** Bytes read of what a hook answers; an answer past them is cut, blocks nothing, and is shown as failed. |
| `hooks.reasonChars` | whole ≥ 1 | 2000 | all | **Most of a hook's reason kept.** Characters of a hook's error output kept as its reason or as why it failed; the last of them are kept. |

## `rules`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `rules.window` | whole ≥ 1 | the whole text | all | **What a pattern looks at.** Characters a rule's pattern looks at at a time, the newest of what is written and stretches of a tool's arguments or result; none: the whole text. |
| `rules.patternTime` | whole ≥ 1 | 50 | all | **Time a rule's pattern may run.** Milliseconds one rule's pattern may run on one text; past it the run is stopped, counts as no match, and is shown on the Turn page. |
| `rules.interrupt` | stop \\| remind | stop | all | **A stream rule that interrupts.** What a stream rule that interrupts does: stop the call where it matched, or remind the agent after it instead. |
| `rules.interrupts.<connection>` | stop \\| remind | as rules.interrupt says | all | **A stream rule that interrupts, on a connection.** Stop or remind, for one connection whose stopped reply cannot go on cleanly. |
| `rules.judge` | text | the Author's connection | shipped, global | **Connection that judges questions.** The connection that answers a rule's question, by its name or id, where the rule names none. |
| `rules.commandTimeout` | whole ≥ 1 | 10 | all | **Time a rule's command may take.** Seconds a rule's command may take to answer yes or no; past them it is stopped and the rule is shown as unable to work, never as a no. |

## `trace`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `trace.requests` | first \\| all \\| none | first | all | **Requests kept.** Which model calls have what they were sent kept in the turn's folder: each agent's first, all of them, or none. |

## `live`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `live.backlog` | whole ≥ 1 | 5000 | all | **Live view backlog.** Items of one run a page following it live may have yet to take; past that, the page is cut off and told so, and no run waits on a slow page. |

## `prompt`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `prompt.signatureHead` | whole ≥ 1 | 64 | all | **Start a slice is known by.** Characters at the start of a slice's text that the prompt map keeps, to find the slice again in a later prompt. A map learned under another value is still found. |

## `compaction`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `compaction.reserve` | whole ≥ 0 | 16384 | all | **Room kept for the answer.** Tokens kept free for the answer: a run is compacted when any call of any agent would not fit its model's window less this. |
| `compaction.keepTurns` | whole ≥ 0 | 3 | all | **Turns kept whole.** The newest of a session's earlier turns that a summary never stands for. |
| `compaction.records` | whole ≥ 1 | 6000 | all | **Records before folding.** Tokens of records the records mode carries before a compaction folds them into the summary. |
| `compaction.saveCalls` | whole ≥ 1 | 1 | all | **Calls before a compaction.** Model calls the lead makes at the moment before a compaction; the tools of the last of them run, and nothing after them. |
| `compaction.overflowTries` | whole ≥ 0 | 1 | all | **Tries after a too-long refusal.** Times in a row a call the provider refused as too long is compacted and sent again; past them the run ends as the provider answered. |
| `compaction.keepRecent` | whole ≥ 0 | 20000 | all | **Newest work kept whole.** Tokens of a run's newest calls and results kept as they are when its own older calls are summarized. |

## `sessions`

| Key | Takes | Default | Levels | What it is |
|---|---|---|---|---|
| `sessions.carried` | names | scratch/scene.md | all | **Scratch files a scene keeps.** Files of a turn's scratch/ the session's cache keeps as they stand: each turn starts with the newest on its path, and its own version becomes the standing one at its end. Empty: nothing is carried. |
| `sessions.held` | whole ≥ 0 | 8 | all | **Sessions kept read.** Sessions whose file stays read in memory between their turns, so a turn starts without reading it again; past this many, the one used least recently is let go and read whole when next asked for. |
| `sessions.page` | whole ≥ 1 | 50 | all | **Sessions a page.** Sessions listed in one page of the Sessions page when it asks for no number. |
