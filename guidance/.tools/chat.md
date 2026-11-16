---
description: How the tools that read and search the chat are called - chat_read and chat_search. It says how to call them, not when. Delete this file and an agent that holds one of them is given no such guide.
---
chat_read reads messages in full, whether or not they are in the prompt. Positions count the chat's first message as 0. Give a stretch by `from` and `to` (both included), by `from_id` and `to_id` where you have message ids, or `last` for the last so many. One read gives at most as many messages as its answer says; read on with another call for the rest. A hidden message is marked, and where the chat's setting keeps hidden text from agents its words are not given.

    chat_read {"from": 120, "to": 130}
    chat_read {"last": 10}

chat_search searches the whole chat by `query`, names and words, and gives each message found with its position, its id, who wrote it and the words around the match; `limit` caps how many. Read a hit in full with chat_read.
