---
description: How the tools that read, find and write files are called - file_read, file_find and file_write. It says how to call them, not when. Delete this file and an agent that holds one of them is given no such guide.
---
Paths are the files as the agents see them, from the chat's folder; the other levels are under their own names, such as `@global/`.

file_find looks: `by` is `list` (what is in a folder), `glob` (paths that match `pattern`) or `grep` (lines that match `pattern`, a regular expression unless `literal` is true). `path` is where to look, `depth` how deep a list goes, `limit` how many results. When a search stopped before it looked everywhere, its last line says why. file_read reads one file, or the lines from `start` to `end`, counted from 1.

    file_find {"by": "grep", "pattern": "harbour", "glob": "**/*.md"}
    file_read {"path": "persistent-workspace/notes.md", "start": 1, "end": 40}

file_write changes one file where agents may write: the notes folder and this turn's own folders. `op` is `write` (make or replace it whole), `append`, `edit` (`old` is the text to replace exactly as the file has it, `new` what goes in its place, `all` true to replace it everywhere) or `delete`. The answer says what changed and shows what the file now says, so no read is needed after it.

    file_write {"path": "persistent-workspace/notes.md", "op": "edit", "old": "dusk", "new": "dawn"}

A write that waits for the player's answer, because the player set it to Confirm, holds the other calls of its message until the answer comes. Such a write is best sent alone or last.
