---
description: The words an agent is told by the job tools. job_start - that the job was started; what its agent was not given, a line for each name nobody could find; that the player has switched jobs off; that the player's limit on jobs in a day, or on the jobs one turn or one job may start, was reached; that jobs have spent the tokens the player allows them in a day; that no agent and task were given. job_start, job_read and job_cancel - that there is no job of the id named in this chat. job_start - that the job named to start again is not one that can be. job_list - a line for each job, a line when there are none, a line when more are left out. job_read - the job's state, its task, what its agent was not given, and its report or that it has none. job_cancel - that the job was stopped, that it had ended already, or that the player started it. One line per name, a name, a colon, then its text. Change the words freely. Delete a line and that answer is given with no words; on some connections the model is then shown its provider's own note that the tool gave nothing, such as "(no tool output)". Why no agent could be started is said in the words of delegation.md.
format: lines
---
started: Job {{job}} was started: {{agent}} works on it in the background{{#queued}} once a place is free{{/queued}}.
missing: {{agent}} was not given {{ref}}: it could not be found.
day_limit: No job was started: {{value}} jobs were started today{{#connection}} on {{connection}}{{/connection}}, and the player allows {{max}}.
run_limit: No job was started: this {{#job}}job{{/job}}{{^job}}turn{{/job}} has started {{value}} jobs, and the player allows {{max}}.
day_tokens: No job was started: what jobs sent and wrote today counts as {{value}} tokens, and the player allows {{max}}.
off: No job was started: the player has switched jobs off.
no_task: No job was started: it needs an agent and a task, or the job to start again.
no_job: There is no job {{id}} in this chat.
not_again: Job {{id}} is {{state}}: only a job that was interrupted, failed or cancelled can be started again.
none: No job has been started in this chat.
listed: {{id}}: {{agent}}, {{state}}{{#repeats}}, started again from {{repeats}}{{/repeats}}. {{brief}}
more: {{count}} are listed; older jobs are left out.
read: Job {{id}}: {{agent}}, {{state}}{{#repeats}}, started again from {{repeats}}{{/repeats}}{{#limit}}, stopped at its limit on {{limit}}{{/limit}}.
brief: Task: {{brief}}
report: Report: {{report}}
no_report: It has no report.
cancelled: Job {{id}} was stopped.
cancel_ended: Job {{id}} had ended already: it is {{state}}.
not_yours: Job {{id}} was started by the player, and the player stops it.
