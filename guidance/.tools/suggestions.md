---
description: How suggest is called. It says how to call it, not when. Delete this file and an agent that holds the tool is given no such guide.
---
suggest puts one proposed change before the player. Name what it is for with exactly one of `file` (a file's path as the agents see the files), `lore` (the id of a lore entry) and `new_lore` (true, for a new entry); give the proposed `text` and the `reason`. The player accepts it, changes it or dismisses it, and the call changes nothing itself.

    suggest {"file": "WORLD.md", "text": "The harbour freezes in winter.", "reason": "The story has said so twice."}
