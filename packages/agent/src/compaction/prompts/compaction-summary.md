You MUST summarize the conversation above into a structured handoff summary for another LLM to resume the task.

IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.

You MUST use this format (sections can be omitted if not applicable):

## Goal
[User goals; list multiple if session covers different tasks.]

## Constraints & Preferences
- [Constraints or requirements mentioned]

## Progress

### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Approaches that failed
- [Tried approaches and why they failed, if any]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Important data, pending questions, references]

## Additional Notes
[Anything else important not covered above]

You MUST output only the structured summary; you NEVER include extra text.

Sections MUST be kept concise. Code maintains file lists (`<read-files>`, `<modified-files>`) and a `<ledger>` (commands, exit codes, user rules, anchors); focus on intent, decisions with rationale, findings, failed approaches, and exact file/symbol next steps. You MUST preserve exact file paths, function names, error messages, and repository state changes if mentioned.
