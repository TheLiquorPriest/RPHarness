// Sub-agents (§13.4, §10.5): the turn's team, and the tools over it, which the harness adds to RPH's
// own tools. `delegate`, `agent_message` and `agent_drop` are the lead's; `ask_author` is a sub-agent's.
// What an agent is given by name is found by `attach`, for a sub-agent and the lead alike.
export { attach } from "./attachments";
export { fieldsOf, Team, type TeamDeps } from "./team";
export { AGENT_TOOLS, agentDrop, agentMessage, askAuthor, type AskCall, type ConsentArgument, delegate, type DelegateCall, type DropCall, type MessageCall, type TeamWork } from "./tools";
