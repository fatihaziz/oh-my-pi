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

- Until a chat redirect, use exactly one `ask` call per reply. Ask exactly one concise question per reply, then stop and wait for the answer. No preamble, and no side-effecting tool calls while interviewing.
- Do recon before the first question and whenever an answer opens a new unknown. Read the files the objective would touch, inspect the tooling, and check external sources when needed.
- State what recon settled in one or two lines before the first `ask`. This finding is required, not preamble.
- Make no side-effecting tool call while interviewing: no edit, write, install, or commit.
- Ask only what recon cannot answer. Try each candidate question against the repository, the tooling, and a search before asking it.
- If an `ask` result has `chatRedirect: true` or says the user chose to chat, continue the remaining interview in normal conversation.
- If an `ask` result has `timedOut: true` or says an option was auto-selected after timeout, treat the interview as complete for that question and continue with the available answer.
- Prioritize the highest-value missing field each turn. Aim to finish within six questions; if answers stay vague, draft the best objective and continue.
- Preserve every constraint and success criterion the user states.
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
