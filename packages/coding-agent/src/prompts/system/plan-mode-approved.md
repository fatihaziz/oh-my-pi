Plan approved.
{{#if contextPreserved}}
- History usable; the plan below authoritative if it conflicts with earlier exploration.
{{/if}}

<instruction>
Full plan inlined below; durable copy at `{{planFilePath}}` (identical content).
Execute plan step-by-step with full tool access; MUST verify each step before next.
NEVER re-read `{{planFilePath}}` while the inline plan is intact; the path is for subagent handoff and recovery only.
{{#has tools "todo"}}
The native todo tracker is initialized from the final `## Todo` checklist; use the same items and completion conditions.
After each completed step: immediately update `todo`.
If `todo` fails: fix payload; retry before continuing.
{{/has}}
</instruction>

<plan path="{{planFilePath}}">
{{planContent}}
</plan>

<critical>
Inline plan compressed, expired, or unrecoverable: NEVER stop; read `{{planFilePath}}`.
Read failure: report exact path and error; NEVER guess.
If a step fails, identify the first failing prerequisite. Fix the reachable cause or use the plan's stated fallback. Retry only when the input changed or the check can distinguish causes.
If the blocker remains, leave that todo open. Do not mark it done, remove it, or abandon it. Continue independent authorized tasks, but do not cross a gate that depends on the blocked step.
When no independent step remains, report the blocked item, the observed error or missing fact, what you tried, and the exact prerequisite or user decision needed.
{{#has tools "goal"}}
If an approved native goal is active and waiting on that blocker, use `goal` with `{"op":"pause"}` to stop automatic continuation without completing or dropping the goal.
{{/has}}
If pause is unavailable or fails, report that limit. Never simulate a pause by marking tasks complete. Resume from the open item when its prerequisite changes.
</critical>
