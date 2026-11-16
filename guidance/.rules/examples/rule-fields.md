---
# Example. Not in force while it sits in `examples/`. It names every field a rule's header takes, with what each takes, what it is when left out, and which trigger it goes with. A rule fires on one thing, so a rule of your own keeps one of `condition`, `question`, `at` and `every`, and the fields that go with it.
description: What the rule is for, in a sentence. The Rules page shows it. A rule with no trigger at all is read in the briefing of the turns `turns` names, and asks for nothing of its own accord.
# Who the rule is for. It must be there: `all`, or a list of agent definitions by name.
agents: [author, gm]
# Files that must be in force for the rule to be: an instruction file by its name (WORLD), or a rule, skill or other file by its folder and name (rules/perceptions). The rule goes out of force with the file. None when left out.
needs: [WORLD]
# With no trigger: the situations the rule is handed over for in the briefing, such as swipe. Left out, it is given for every turn.
turns: [swipe]
# TRIGGER, a pattern. A JavaScript regular expression, looked for in what `scope` names while it is written. A pattern that cannot be parsed refuses the rule; one that runs past `rules.patternTime` (50 milliseconds) counts as no match.
condition: "\\bsuddenly\\b"
# Goes with `condition`. `ignore` lets upper and lower case count as the same; left out, case counts.
case: ignore
# Goes with `condition` and `question`. What the rule looks at: `text`, `thinking`, `reply`, `arguments` or `result`, the last two of a tool by a pattern of its name (`arguments:world_*`), or a list of them.
scope: [reply, arguments:file_write]
# TRIGGER, a question. Asked yes or no of a judging model about what `scope` names; the rule fires on yes.
question: Does the reply speak for the player's character?
# Goes with `question`. The name of the connection the judging model runs on; left out, the agent's own.
judge: cheap
# TRIGGER, a moment. `turn-start`, `run-end` or `before-compaction`. It may carry a `fact`.
at: run-end
# Goes with `at` or `every`. A fact of the turn and a test of it, such as `todo.open > 0` or `limits.left <= 2`: the rule fires only while it holds.
fact: todo.open > 0
# TRIGGER, a count of turns. A whole number: the rule fires every that many turns. It may carry a `fact`.
every: 10
# How often it may fire. `once per turn` when left out, or `once per session`, `after 6 turns`, or `always`.
repeat: once per turn
# Goes with `condition` and `question`. `always` stops the writing at once when it fires (the default for a pattern), `never` lets it finish and speaks after it (the default for a question).
interrupt: never
# Goes with `condition` on a tool's `arguments`. `true` holds the call until the rule has had its say; `false` when left out.
hold: false
---
This text goes to the agent when the rule fires. Say what happened and what is wanted of it, in a line or two.
