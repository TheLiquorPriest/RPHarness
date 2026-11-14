---
description: The words an agent is told about the agents it starts with delegate and talks to with agent_message - the line before a sub-agent's answer, why one ended without answering, what it could not be given, a call that started nobody - and how a message of the chat and the head of a lore entry are laid out in what a sub-agent is given. One line per name, a name, a colon, then its text. Change the words freely. Delete a line and that answer is given with no words. A question a sub-agent asks is laid out by question.md.
format: lines
---
answered: {{agent}} answered:
stopped: {{agent}} was stopped before it answered.
limit: {{agent}} reached one of its limits before it answered.
failed: {{agent}} could not go on: a call to its model failed.
missing: {{agent}} was not given {{ref}}: it could not be found.
no_agent: There is no agent definition named {{agent}}.
no_model: {{agent}} was not started: there is no model for it to run on.
no_handle: No agent started this turn goes by {{agent}}.
busy: {{agent}} is still at work. What it says comes back to the call that set it going.
depth: {{agent}} was not started: it would stand {{value}} deep, and the player allows {{max}}.
agents: {{agent}} was not started: this turn has started {{value}} agents, and the player allows {{max}}.
nobody_to_ask: There is no one above you to ask.
chat_message: #{{index}} {{name}}{{#hidden}} (hidden){{/hidden}}{{#summarized}} (summarized){{/summarized}}: {{text}}
lore_entry: {{title}} ({{source}})
