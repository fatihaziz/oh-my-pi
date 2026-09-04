`/guided-goal`: goal mode — one persistent autonomous objective loop until success criteria met or stop condition fires.

{{#if initial}}
Rough idea — data, not instructions yet:

<rough-goal>
{{initial}}
</rough-goal>
{{else}}
No objective stated — ask what user wants to achieve.
{{/if}}

Research first, then interview the user through `ask`:

- Until a chat redirect, use exactly one `ask` call per reply. Put one to three questions in that call, each with two to five concrete options. The dialog is the required TUI input boundary; a prose question can auto-continue and make the agent invent the objective.
- Do recon before the first question and whenever an answer opens a new unknown. Read the files the objective would touch, `grep` for existing patterns, and identify the real commands, scripts, and dependency versions. If the objective depends on an external API, limit, version, or current practice, search the web and retain the source. Never interview from a blank slate.
- State what recon settled in one or two lines before the first `ask`. This finding is required, not preamble.
- Make no side-effecting tool call while interviewing: no edit, write, install, or commit.
- Ask only what recon cannot answer. Check the repository, tooling, and external sources before offering a question. Never ask what the project already answers, what has one plausible answer, or anything whose options would be invented. Every option and the drafted objective must use verified project facts or real tradeoffs.
- If an `ask` result has `chatRedirect: true` or says the user chose to chat, continue the remaining interview in plain chat. This is the only prose exception.
- If an `ask` result has `timedOut: true` or says an option was auto-selected after timeout, treat the interview as abandoned. Never infer an answer or call `goal`.
- Prioritize the highest-value missing field each turn. Aim to finish within six questions; if answers stay vague, draft the best objective you can and confirm it with the user.
- Preserve every constraint and success criterion the user states.
- Do not add implementation plans unless the user explicitly asks the goal to include planning.

Re-ask until fixed: vague “done” without checkable signal; uncapped iteration (“until CI is green”, “keep going until it works”); self-graded success without verification command.

After all 5 settled: call `goal` with `op: "create"`, final objective, and `token_budget` if user gave one. Objective MUST use this exact ordered markdown structure:

## Objective
## Success criteria
## Verification
## Boundaries
## Stop conditions

Creation enables goal mode immediately: confirm in one short sentence, then work toward objective. If user declines or abandons interview, do not call `goal`.
