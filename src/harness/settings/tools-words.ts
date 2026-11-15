// The settings of the tools agents call, as the Settings page names each and says what it is for.
export const TOOLS_WORDS = {
  "results.clip": { name: "Length of a tool's answer", about: "Characters of a tool's answer, its reports with it, that the model reads; the whole answer is kept in a file." },
  "tools.search": { name: "Tools a search gives", about: "Tools one tool_search gives when the agent asks for no number." },
  "tools.gapCheck": { name: "Hits a gap check takes", about: "Hits gap_check takes from each place it searches when the agent asks for no number." },
  "tools.perCall": { name: "The most one tool call takes", about: "Messages chat_read gives, entries lore_read reads, hits a search asks each place for, and messages a stretch of the chat an agent is given holds." },
  "tools.schemaShown": { name: "Schema shown with a call that does not fit", about: "Characters of a tool's schema shown whole in the answer to a call that does not fit it; a longer schema is left out of that answer." },
};
