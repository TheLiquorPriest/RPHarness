---
description: How the tools that start other agents and talk to them are called - delegate, ask_author, agent_message and agent_drop. It says how to call them, not when. Delete this file and an agent that holds one of them is given no such guide.
---
delegate starts an agent from its definition. `agent` is the definition's name. `brief` is its whole task: it sees nothing of your conversation, only the brief and what you attach. `attach` is a list of strings, each naming one thing to give it in full: `file:<path>`, `chat:history[scene]`, `chat:history[-30:]`, `chat:history[#120..#179]`, `lore:<id>`, `prompt:<name>`, or the name of a view of the story the system offers. Several delegate calls in one message run at the same time. What comes back is what the agent last said, with the name it goes by this turn (such as gm-1); agent_message and agent_drop take that name as `agent`.

    delegate {"agent": "gm", "brief": "Rule whether Wren can swim the channel at night.", "attach": ["chat:history[-30:]", "lore:e-12"]}

agent_message goes on with an agent that stopped, from where it stopped; if it asked a question, the message is the answer. Only to allow it to invent something, add `consent`: `topic` (what may be invented) and, where you have them, `bounds` and `gap_check` (the id of the gap check it rests on).

agent_drop takes back everything the named agent wrote this turn. An agent still at work cannot be dropped.

ask_author is for an agent that was given a task: `question` in full and, in `searched`, what you looked for and where. The answer comes back to the same call.
