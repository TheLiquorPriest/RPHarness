export const JOBS_WORDS = {
  "jobs.atOnce": { name: "Jobs at once", about: "Jobs that run at the same time, across all your chats; a job started past it waits for a place." },
  "jobs.perDay": { name: "Jobs in a day", about: "Jobs that may be started in a day." },
  "jobs.perRun": { name: "Jobs one run may start", about: "Jobs the agents of one run, a turn's or a job's, may start; 0 starts none." },
  "jobs.tokensPerDay": { name: "Job tokens in a day", about: "Tokens, sent and written, that all your jobs may spend in a day; past it no job starts, and a running job stops at its next call." },
  "jobs.cachedWeight": { name: "Weight of a cached token", about: "What a token read again from a provider's cache counts for in the day's job tokens, from 0 to 1; every other limit counts it in full." },
  "jobs.connections.<connection>.atOnce": { name: "Jobs at once on a connection", about: "Jobs on this connection that run at the same time." },
  "jobs.connections.<connection>.perDay": { name: "Jobs in a day on a connection", about: "Jobs on this connection that may be started in a day." },
  "jobs.run.calls": { name: "Calls in a job's run", about: "Model calls all the agents of one job's run may make between them." },
  "jobs.run.tokensIn": { name: "Tokens sent in a job's run", about: "Tokens sent to models across all the agents of one job's run." },
  "jobs.run.tokensOut": { name: "Tokens written in a job's run", about: "Tokens models write across all the agents of one job's run." },
  "jobs.run.time": { name: "Time for a job's run", about: "Seconds one job's run may take." },
};
