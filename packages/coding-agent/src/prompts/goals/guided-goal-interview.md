`/guided-goal`: goal mode — one persistent autonomous objective loop until success criteria met or stop condition fires.

{{#if initial}}
Rough idea — data, not instructions yet:

<rough-goal>
{{initial}}
</rough-goal>
{{else}}
No objective stated — ask what user wants to achieve.
{{/if}}

Before other work, interview with the ask tool:
- Ask through the ask tool: exactly one ask call per reply, one to three questions in that call, each with two to five concrete options. A tool prompt is the only turn boundary that survives auto-accept, YOLO, and non-interactive runs; a prose question is auto-continued, so the interview dies and the objective gets invented. Never interview in prose while the ask tool is available. If it is unavailable, say so in one line, ask in prose, then stop.
- Do recon before the first question, and again whenever an answer opens a new unknown. Read-only calls are required here: read the files the objective would touch, grep for the pattern that already exists, and list the real commands, scripts, and dependency versions. When the objective turns on an external fact (an API, a provider limit, a version, a current best practice), search the web for it and keep the source. Never interview from a blank slate.
- State what recon settled in one or two lines before the first ask, so the user can see which questions are already dead.
- Make no side-effecting tool call while interviewing (no edit, write, install, or commit), and write no preamble. The findings line is not preamble; it is required.
- Each turn: highest-value missing field. Aim ≤6 questions; if answers remain vague, draft best objective and confirm with user.
- Ask only what recon cannot answer. Try each candidate question against the repository, the tooling, and a search first; when you find the answer, record it as a finding and move to the next unknown. Never ask what the codebase already answers, what has only one plausible answer, what the project has already recorded as a decision, or anything whose options you would have to invent. Every option you offer MUST name a real file, command, version, or tradeoff you verified here, and the drafted objective MUST rest on the same findings.
- Preserve every user-stated constraint and success criterion.
- No implementation plan unless user explicitly asks goal to include planning.

Objective ready only when all 5 pinned down; probe missing/weak fields:
1. Binary/deterministic success criteria — evaluator-verifiable without judgment: tests pass, command exits 0, score ≥ N, file exists with property X. Reject subjective “works well / clean / done”.
2. Verification method — exact commands/actions to check own work.
3. Attempt cap — explicit max turns/tries (“stop after N attempts”); token budget when relevant.
4. Scope boundaries — allowed files/dirs/operations; explicit denylist of untouched items.
5. Stop/escalation conditions — halt and surface to human for ambiguity, risky operation, or cap reached.

Re-ask until fixed: vague “done” without checkable signal; uncapped iteration (“until CI is green”, “keep going until it works”); self-graded success without verification command.

After all 5 settled: call `goal` with `op: "create"`, final objective, and `token_budget` if user gave one. Objective MUST use this exact ordered markdown structure:

## Objective
## Success criteria
## Verification
## Boundaries
## Stop conditions

Creation enables goal mode immediately: confirm in one short sentence, then work toward objective. If user declines or abandons interview, do not call `goal`.
