export const LIMITS_WORDS = {
  "limits.turn.calls": { name: "Calls in a turn", about: "Model calls all the agents of one turn may make between them." },
  "limits.turn.tokensIn": { name: "Tokens sent in a turn", about: "Tokens sent to models across all the agents of one turn." },
  "limits.turn.tokensOut": { name: "Tokens written in a turn", about: "Tokens models write across all the agents of one turn." },
  "limits.turn.time": { name: "Time for a turn", about: "Seconds one turn may take, all its agents' work included." },
  "limits.turn.toolRounds": { name: "Tool rounds in a turn", about: "Answers that call tools, across all the agents of one turn; past it the turn's work ends at this limit." },
  "limits.turn.depth": { name: "Sub-agent depth", about: "How deep sub-agents may go: at 1 only the lead starts them, at 2 they may start their own, at 0 none is started." },
  "limits.turn.agents": { name: "Sub-agents in a turn", about: "Sub-agents one turn may start in all." },
  "limits.turn.agentsAtOnce": { name: "Sub-agents at once", about: "Sub-agents of one run at work at the same time; one more waits for a place, first come first served." },
  "limits.toolsAtOnce": { name: "Tool calls at once", about: "An answer's tool calls that run at the same time, for an agent whose definition sets none of its own; one more waits for a place." },
  "limits.repeats": { name: "Same call in a row", about: "The same tool call with the same arguments this many times in a row, with nothing written by any agent between, ends that agent's work at this limit." },
  "limits.cachedWeight": { name: "Weight of a cached token", about: "What a token read again from a provider's cache counts for against every limit on tokens sent, from 0 to 1: an agent's, a turn's, a job's and a day's." },
};
