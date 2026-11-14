// Sub-agents (§13.4, §10.5): the turn's team, and the three tools over it, which the harness adds
// to RPH's own tools. `delegate` and `agent_message` are the lead's; `ask_author` is a sub-agent's.
export { type AgentSettings, DEFAULT_AGENT_SETTINGS, readAgentSettings } from "./settings";
export { Team, type TeamDeps } from "./team";
export { AGENT_TOOLS, agentMessage, askAuthor, type AskCall, type ConsentArgument, delegate, type DelegateCall, type MessageCall, type TeamWork } from "./tools";
