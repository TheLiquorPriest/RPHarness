export const COMPACTION_WORDS = {
  "compaction.reserve": { name: "Room kept for the answer", about: "Tokens kept free for the answer: a run is compacted when any call of any agent would not fit its model's window less this." },
  "compaction.keepTurns": { name: "Turns kept whole", about: "The newest of a session's earlier turns that a summary never stands for." },
  "compaction.records": { name: "Records before folding", about: "Tokens of records the records mode carries before a compaction folds them into the summary." },
  "compaction.saveCalls": { name: "Calls before a compaction", about: "Model calls the lead makes at the moment before a compaction; the tools of the last of them run, and nothing after them." },
  "compaction.overflowTries": { name: "Tries after a too-long refusal", about: "Times in a row a call the provider refused as too long is compacted and sent again; past them the run ends as the provider answered." },
  "compaction.keepRecent": { name: "Newest work kept whole", about: "Tokens of a run's newest calls and results kept as they are when its own older calls are summarized." },
};
