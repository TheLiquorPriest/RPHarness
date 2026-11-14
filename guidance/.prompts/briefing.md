---
description: The layout of the briefing the lead is given at the start of every turn. Each part appears only when there is something to show. The host's own parts come in the order the host gives them, each under its own name. Take a part out and it is no longer shown. It lays facts out; it asks for nothing.
---
# Briefing for this turn

- This turn: {{turn.kind}}{{#turn.speaker}}, replying as {{turn.speaker}}{{/turn.speaker}}.
{{#asked}}
- The player asked for: {{.}}
{{/asked}}
{{#prefill}}

The reply already begins with these words. The chat application puts them in front of whatever is written:

{{prefill}}
{{/prefill}}
{{#since}}

## Since the last turn

{{#since.items}}
- {{.}}
{{/since.items}}
{{/since}}
{{#files_changed}}

## Files changed since this session opened

{{files_changed}}
{{/files_changed}}
{{#files_added}}

## Added for this turn

{{files_added}}
{{/files_added}}
{{#rules_due}}

## From your rules

{{rules_due}}
{{/rules_due}}
{{#blocks}}

## {{name}}

{{text}}
{{/blocks}}
{{#prompt_notices}}

## The prompt

{{prompt_notices}}
{{/prompt_notices}}
{{#turn_files}}

This turn's files are in {{turn_files}}
{{/turn_files}}
