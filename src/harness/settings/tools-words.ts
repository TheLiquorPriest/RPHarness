export const TOOLS_WORDS = {
  "results.clipChars": { name: "Length of a tool's answer", about: "The most characters of a tool's answer, its reports with it, that the model reads, where you set one; without it an answer is cut only where it would not fit the call. The whole answer is kept in a file." },
  "tools.search": { name: "Tools a search gives", about: "Tools one tool_search gives when the agent asks for no number." },
  "tools.gap.hits": { name: "Hits a gap check takes", about: "Hits gap_check takes from each place it searches when the agent asks for no number." },
  "tools.perCall": { name: "The most one tool call takes", about: "Messages chat_read gives, entries lore_read reads, hits a search asks each place for, and messages a stretch of the chat an agent is given holds." },
  "tools.schemaShownChars": { name: "Schema shown with a call that does not fit", about: "Characters of a tool's schema shown whole in the answer to a call that does not fit it; a longer schema is left out of that answer." },
  "tools.fixedTokens": { name: "Size of an agent's tool list", about: "Tokens an agent's fixed list of tools, as its requests carry it, should stay under; a list over it is marked in the live view and on the Turn page, and still runs." },
  "tools.commandTimeoutSeconds": { name: "Time a command tool may take", about: "Seconds one of your command tools may run when its manifest names no timeout; past them it is stopped and the agent is told." },
  "tools.httpTimeoutSeconds": { name: "Time an HTTP tool may take", about: "Seconds one of your HTTP tools may wait for its address's answer when its manifest names no timeout; past them the call is given up and the agent is told." },
  "tools.maxAnswerBytes": { name: "The most read of a tool's answer", about: "Bytes read of what a command tool, an HTTP tool or an MCP server answers; past them the answer is cut and the agent is told." },
};
