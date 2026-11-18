---
description: The lines shown in the chat's thinking block while a turn is being worked on. One kind of line per row, a name, a colon, then its text. Change the words freely. Delete a row and that kind of line is no longer shown. The row named still is the one that keeps a long silent turn alive; without it, the chat application may give up on a turn that shows nothing for long. The row named retrying is shown when a call to a model failed and is made again; `is.<kind>` says what broke it (connection, timeout, overloaded, server, other), `seconds` the wait before the next try, `next` that try's number and `most` the most tries there will be.
format: lines
---
started: Reading the turn.
tool: {{tool}}
rule: A rule of yours fired: {{rule}}.
writing: Writing.
hook_waits: Waiting for a hook of yours to see the reply.
retrying: A call to the model failed ({{#is.connection}}the connection was lost{{/is.connection}}{{#is.timeout}}it timed out{{/is.timeout}}{{#is.overloaded}}the provider is busy{{/is.overloaded}}{{#is.server}}the provider's server failed{{/is.server}}{{#is.other}}the provider failed{{/is.other}}). Trying again in {{seconds}}s, try {{next}} of {{most}}.
still: Still working ({{elapsed}}).
