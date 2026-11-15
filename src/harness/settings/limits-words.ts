// The limits on one turn, as the Settings page names each and says what it is for.
export const LIMITS_WORDS = {
  "limits.turn.calls": { name: "Calls in a turn", about: "Model calls all the agents of one turn may make between them." },
  "limits.turn.tokensIn": { name: "Tokens sent in a turn", about: "Tokens sent to models across all the agents of one turn." },
  "limits.turn.tokensOut": { name: "Tokens written in a turn", about: "Tokens models write across all the agents of one turn." },
  "limits.turn.time": { name: "Time for a turn", about: "Seconds one turn may take, all its agents' work included." },
  "limits.turn.depth": { name: "Sub-agent depth", about: "How deep sub-agents may go: at 1 only the lead starts them, at 2 they may start their own, at 0 none is started." },
  "limits.turn.agents": { name: "Sub-agents in a turn", about: "Sub-agents one turn may start in all." },
};
