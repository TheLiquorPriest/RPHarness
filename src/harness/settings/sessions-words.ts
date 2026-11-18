export const SESSIONS_WORDS = {
  "sessions.carried": { name: "Scratch files a scene keeps", about: "Files of a turn's scratch/ the session's cache keeps as they stand: each turn starts with the newest on its path, and its own version becomes the standing one at its end. Empty: nothing is carried." },
  "sessions.held": { name: "Sessions kept read", about: "Sessions whose file stays read in memory between their turns, so a turn starts without reading it again; past this many, the one used least recently is let go and read whole when next asked for." },
  "sessions.page": { name: "Sessions a page", about: "Sessions listed in one page of the Sessions page when it asks for no number." },
  "sessions.maxUnwrittenMiB": { name: "Most session lines held unwritten", about: "Mebibytes of session lines held in memory, every session's, while their files cannot be written (a full disk, a folder taken away, a host that refuses), to go out with the next write that lands. Past them, a turn or a job whose own session file cannot be written is stopped and ends failed, saying why; what is held stays held." },
};
