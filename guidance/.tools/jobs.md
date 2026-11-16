---
description: How the job tools are called - job_start, job_list, job_read and job_cancel. It says how to call them, not when. Delete this file and an agent that holds one of them is given no such guide.
---
job_start starts an agent on a task in the background. `agent` is the definition's name and `brief` its whole task, as delegate takes them; `attach`, `plays` and `returns` are also as delegate takes them. The answer only says the job was started: the agent works on after this turn's reply, what it last writes is its report, kept with the job, and a later turn is told that it ended. To start an interrupted, failed or cancelled job again, give `repeats`, the job's id: its agent, task, attachments and limits are used, except what you give again.

    job_start {"agent": "researcher", "brief": "Read the lore about the harbour and list what it says of the tides."}

job_list takes no arguments and lists the chat's jobs, the latest first. job_read takes `job`, an id as job_start or job_list gave it, and gives the job in full, its report included. job_cancel takes `job` too, and stops one that has not ended. The three are found with tool_search.
