export const AGENTS_WORDS = {
  "agents.<definition>.effort": { name: "Effort", about: "How hard this agent's model reasons, in place of its definition's effort: off to max; a level its model does not have is the nearest it has." },
  "agents.<definition>.limits.calls": { name: "Calls", about: "Model calls this agent may make in one stretch of its work; past it its work ends at this limit." },
  "agents.<definition>.limits.tokensIn": { name: "Tokens sent", about: "Tokens this agent's calls may send in one stretch of its work." },
  "agents.<definition>.limits.tokensOut": { name: "Tokens written", about: "Tokens this agent's model may write in one stretch of its work." },
  "agents.<definition>.limits.time": { name: "Time", about: "Seconds one stretch of this agent's work may take." },
  "agents.<definition>.limits.callTokensIn": { name: "Tokens sent in a call", about: "Tokens one call of this agent may send, as estimated before it is sent." },
  "agents.<definition>.limits.callTokensOut": { name: "Tokens written in a call", about: "Tokens the answer to one call of this agent may take." },
  "agents.<definition>.limits.callTime": { name: "Time for a call", about: "Seconds one call of this agent may take, apart from the wait on a silent answer." },
  "agents.<definition>.limits.toolRounds": { name: "Tool rounds", about: "Answers of this agent that call tools, in one stretch of its work." },
  "agents.<definition>.limits.toolsPerAnswer": { name: "Tool calls in an answer", about: "Tool calls one answer of this agent may make; the calls past it are answered and not run." },
  "agents.<definition>.limits.toolsAtOnce": { name: "Tool calls at once", about: "This agent's tool calls of one answer that run at the same time; one more waits for a place." },
  "agents.<definition>.limits.messages": { name: "Messages after its first answer", about: "Messages this agent may be sent after its first answer, as a sub-agent; one past it is answered and the agent is not run." },
};
