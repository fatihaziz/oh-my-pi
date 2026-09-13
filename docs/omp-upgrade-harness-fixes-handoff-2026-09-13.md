# OMP Upgrade, Harness Fixes, and Foyer DeepSeek Swarm: Handoff

Date: 2026-09-13

## Installed OMP completion record

OMP 18.1.18 now includes the reviewed harness fixes. The separate Foyer workstream
below remains owned by its existing session; this upgrade did not change Foyer.

| Surface | Verified state |
| --- | --- |
| Release integration | `tmp/upstream-unified-18.1.18`, branch `unified-patch-18.1.18`, base commit `21e6d6c2bf` plus uncommitted P19 changes and carried ACP repair `a6eb9d9753` |
| Upstream contribution | [PR #11885](https://github.com/can1357/oh-my-pi/pull/11885), reviewed repair commit `46eaab41f8` |
| Source regressions | 390 passed across AI, agent-core, and coding-agent focused suites after repairs |
| Installed-source regressions | 109 passed, zero failed, 183 assertions across argument recovery, session guards, and bounded Read tests using global installed imports |
| Installation | Canonical two-section sync passed; `omp --version` reports `omp/18.1.18`; `omp --smoke-test` reports `smoke-test: ok` |
| Patch verification | All 13 markers present, including P19; installed CLI worker smoke passed |
| Patch-engine regression | 18 tests passed, including restoration when saving a failed-build diagnostic raises ENOSPC |
| Preserved output policy | Canonical, BALANCED snapshot, and generated live config retain spill threshold 50 KB, tail 500 lines, and width 768 columns |

P15 preserves complete todo state through checkpoint rewind, including append,
status, blocker, clear, and disk reload. P16 preserves bounded source selections
without bypassing large-output safety. P17 keeps enabled lifecycle tools typed and
returns schemas for malformed device calls. P18 distinguishes observations,
previews, and applied mutations and detects bounded repeated unchanged cycles.

P19 adds bounded argument-schema feedback without echoing rejected payloads.
Pre-dispatch validation failures carry structured metadata, distinct from tool
execution failures. Invalid calls across different operations share a per-user-request
budget owned by the existing tool-call-loop threshold: one recovery instruction
at the threshold, then a terminal stop after another threshold of invalid calls.
Successful intervening calls do not erase that budget. A new user request resets
it; disabling the existing guard disables this protection. No model routing,
dependencies, or required configuration changed.

The captured DeepSeek failure trace produced recovery at assistant turn 37 and
stopped at turn 79 of 170 in offline replay, before the large corrupted payloads.
Historical validation errors were tagged from their recorded harness rejection
prefix for this replay only; production uses structured dispatch metadata.
This is prevention evidence, not a claim that the original task completed faster.
The three installed-source suites passed despite Bun's existing directory-mismatch
diagnostic. Affected package lint and type checks passed after correcting the new
test's schema type; no whole-repository green claim is made.

The adjacent vault audit and its original installation JSON remain records of the
previous P15-P18 delivery. This P19 record supersedes their current-patch inventory.

All six robot review findings were addressed: productive work breaks stale loop
counts, completed AST applications count as mutations, stop-time reminders rearm
independently, new repetition episodes receive their own warning, changelog entries
carry attribution, and lifecycle exposure has an explicit rationale.

S1 and P14 remain. P6/P7 are retired by owner decision; upstream `/guided-goal`
remains. Do not carry PR #8187 or fork PR #1 into future upgrades.

Verification limits: checks use offline mock transports, not a provider benchmark.
An accidentally selected root test script reached ten Windows-specific failures
outside the changed packages; this is not a whole-repository green claim. The
focused installed checks passed despite a Bun directory-mismatch diagnostic.
Existing running processes were not replaced or assumed to load the new bundle.

The audit's Markdown, rendered HTML, and adjacent installation evidence record
the current result. Earlier evidence and replay JSON retain the 18.1.15 baseline.
The historical instructions below explain the original request, not remaining OMP
implementation work. Preserve the independent Foyer plan and its missing
`Promote cited usage snapshot fixture` obligation for the owning session.

## Historical starting request

The original handoff began with the output-policy correction complete and the
upgrade, harness fixes, PR, and installation unfinished. The completion record
above supersedes that OMP status.

The user authorized:

> Update OMP, patch the still-relevant defects, create a PR if the fixes remain relevant and needed, then apply the patch locally through the usual procedure.

The user then prioritized an immediate correction of canonical output policy, Foyer BALANCED policy, and generated live configuration. That correction was completed and verified. The user's latest request is this full handoff in the fork.

This handoff also preserves the earlier **Foyer-managed DeepSeek swarm / direct Pi harness** direction. That product migration is a separate workstream from the immediate OMP upgrade. Its source plan, ownership decisions, shared-context requirements, compatibility gates, and unimplemented status are recorded below. Do not interpret the current OMP delegation ban as cancellation of that future Foyer architecture.

### Original first actions

1. Confirm the session is rooted at `D:/__CODING/open-source/forks/oh-my-pi`. Inspect its Git state, remotes, relevant worktrees, and current patch registry before editing. This was not possible from the previous session's Git tools.
2. Read `skill://omp-fork-upstream-rebase`, `skill://omp-fork-add-patch-behavior`, and the fork's loaded context. Use the existing patch engine; do not duplicate it in the vault.
3. Recheck the latest stable release and upstream implementations. The last observed release was `v18.1.18`; installed OMP, the vault pin, and the patch base were `18.1.15`.
4. Preserve P14 and classify the already-red engine tests before fixing them. The observed marker inventory contains ten markers, while two tests still expect the older inventory.
5. Follow the continuation and acceptance sections below through upstream PR relevance, local application, and installed-runtime proof.

No further approval is needed to perform the requested upgrade, relevant fixes, scoped PR, and local installation. Do not publish unrelated local work. Preserve the separate Foyer swarm direction below without silently adding its product implementation to the OMP upgrade or deleting it from the longer-term objective.

## Broader context: Foyer-managed DeepSeek swarm

### Source and status

| Source | What it establishes |
| --- | --- |
| `D:/__CODING/personal/__my-vault/foyer/docs/pi-harness-plan.md` | Canonical direct-Pi migration plan; read this before implementing Foyer's swarm |
| `D:/__CODING/personal/__my-vault/foyer/docs/pi-harness-plan.html` | Rendered architecture and acceptance plan |
| Foyer transcript L30, `2026-09-12T08:33:06.230Z` | User requested global OMP subagents disabled now, direct Pi consumption with Go-owned lifecycle, and preservation of OMP settings/auth/statistics |
| Foyer transcript L344, `2026-09-12T08:42:42.909Z` | User named future `deepseek-4.1-flash` workers, raised tool/shared-context loss, and prioritized execution speed plus visible agent requests/progress in Foyer |

The plan labels the direct harness **not implemented**. Its recorded completed work is the global worker pause and rendered architecture plan. This handoff does not independently claim the current Foyer implementation has since shipped that runtime; inspect current source and evidence before making such a claim.

The later repository-restructuring work is not proof of swarm completion. Preserve the user's separate centralized Registry/storage decision while moving packages; do not redesign persistence or undo the migration merely because the future supervisor has different responsibilities.

### User direction versus plan recommendations

| Topic | User direction / fixed requirement | Plan recommendation or verification still needed |
| --- | --- | --- |
| Lifecycle | Foyer Go directly manages agents through Pi, not OMP's internal subagent executor | A small JavaScript Pi SDK host per active logical agent, connected through pipes |
| Workers | Future DeepSeek-4.1-Flash workers; execution speed and control matter | Plan display name is DeepSeek-V4.1-Flash; it records `deepseek-flash` as the API identifier. Revalidate provider/catalog/auth mapping before sending requests |
| Strong coordinator | Keep intelligent coordination, context, and integration rather than a large unmanaged worker roster | Plan recommends the existing `openai-codex/gpt-6-astra:high` orchestrator seat; this is not authorization to add a new global OMP role |
| Worker effort | Optimize time to an accepted result, not appearance of activity | Plan proposes explicit low effort as the first measured candidate and comparison with non-thinking for mechanical tasks; do not assume effort labels transfer across providers |
| Compatibility | Keep OMP settings/auth and continue contributing statistics to OMP | Prove narrow adapters; do not assume directory formats, credential interfaces, tools, or session schemas are interchangeable |
| Shared information | Preserve objective, corrections, task context, and useful findings between agents | Versioned task packets, directed messages, per-worker session history, and the existing Mnemopi authority |
| Visibility | Show real requests and agent/tool progress directly in Foyer | A task roster plus selected-agent request/activity/result detail, not a terminal renderer per worker |

Provider names and API behavior above are **recorded plan findings**, not a fresh provider verification by this handoff repair. The source plan cites official DeepSeek documentation for the API ID, effort behavior, and tool-history requirements. Recheck those details, Pi's pinned model support, the existing account, and actual provider round trips during implementation.

### Authority boundary: future Foyer workers are not enabled OMP subagents

| Component | Owns | Does not own |
| --- | --- | --- |
| Operator | Objective, corrections, allowed work, stop decision | Manual forwarding between workers |
| Strong orchestrator | Decomposition, task-local context, dependency order, integration, final acceptance | Unrestricted process spawning or admission |
| DeepSeek worker | One bounded task, approved tools, changed files and evidence-backed handoff | Nested delegation, unrelated files, or accepting final integration |
| Foyer Go | Admission, dependency checks, worktree leases, scheduling, process trees, attempt/generation state, event routing | Provider conversation semantics or a second OAuth refresh loop |
| Pi SDK host | Conversation/tool loop, provider streaming, compaction, native Pi transcript/session | Foyer's product lifecycle or automatic creation of other agents |
| OMP retained services | Settings/credential ownership, provider usage and statistics ingestion | Scheduling or running Foyer-managed agent sessions |

The orchestrator can submit structured scheduling proposals to a Foyer-owned command; Go validates and admits them. Workers do not receive that scheduling capability. Ordinary authorized work does not gain an extra approval dialog. Existing external/destructive-action restrictions still apply.

**Keep global OMP delegation disabled during the current upgrade.** Do not add DeepSeek to the global OMP model-role guard or re-enable `task`, Eval agent factories, or workpool to simulate the planned swarm. The future Foyer scheduler is a different authority, not a renamed OMP `task` tool. Shell access is not an OS sandbox; do not claim arbitrary process creation has been prevented merely by hiding a tool.

Selected architecture: **Foyer Go -> direct Pi SDK host -> provider**, with narrow compatibility adapters to OMP-owned settings/auth/statistics. The host does not launch OMP or import OMP's coding-agent runtime. A supported OMP AI/auth library or credential-only service may be reused without making OMP the lifecycle owner. A new Go implementation of the LLM/tool loop and an OMP RPC/SDK execution wrapper were not selected.

### Shared context, tools, and concurrency

- Preserve the current objective and accepted corrections in a versioned packet containing `goalRevision`, `taskId`, `attemptId`, `baseRevision`, file ownership, exact acceptance, relevant decisions, approved tools, model, and effective effort.
- Keep the worker's task-local Pi history on resume. Record subsequent steering explicitly; do not silently regenerate old context under changed settings. Publish findings once with provenance and notify dependent tasks rather than broadcasting every result.
- A changed accepted constraint invalidates affected pending packets; running work receives directed steering or stops. Results based on an obsolete revision cannot integrate without reconciliation. Test correction delivery, unaffected-worker continuity, and crash/resume.
- Use distinct worktrees for parallel writers and serialize integration. Start directly for small tasks; dispatch only independent work that benefits after context transfer and integration. Bound admission by Foyer limits, ready dependencies, provider allowance, and available worktrees. No generic warm pool or cross-task session reuse without measured need and proven reset.
- Pi retains coding-tool capability, but OMP's anchored edits, multi-format Read, LSP, Browser, Eval, MCP/internal URIs, skills, and memory integrations do not automatically transfer. Inventory and prove the required adapters. A task requiring an unavailable tool stays with a capable actor or gets the adapter first; do not silently replace it with a weaker shell approximation. Mnemopi remains the long-term memory authority.

Do not send the entire conversation to every worker or reduce the handoff to a context-free one-liner. Shared context is a required product behavior, not an optional performance optimization. Avoid a new shared scratchpad, distributed message bus, or second memory database.

### Live request and progress contract

The source plan corrects one premise: OMP already has worker text-delta events, and Foyer derives a roster from transcripts. Streaming through OMP is not inherently impossible. Direct Pi ownership was selected for lifecycle/UI control, not because OMP emits no events.

Foyer should show the objective/run state, worker task/model/effort and current activity, the redacted assembled request/context packet, real tool arguments/progress/results, changed files, acceptance evidence, and statistics-export status. Request, activity, and result are distinct states. Do not fabricate completion percentages or expose credentials to the WebView.

Correlate partial message content by `contentIndex`, tools by `toolCallId`, and every event by attempt/host generation and sequence. Do not parse partial tool arguments as completed JSON. Completed messages replace provisional assembled content. Acknowledgement and `agent_end` are not task acceptance; the plan uses the session's settled boundary and then checks the task's acceptance. Revalidate exact event names against the pinned Pi SDK.

Continuously drain host pipes. Batch display updates rather than writing a SQLite row or Wails event for every token. Preserve terminal events/current snapshots across reconnect and ignore stale-generation events. Cumulative streaming usage must not be summed as multiple billable responses. A slow UI must not block provider execution.

### Settings, credentials, statistics, and failure recovery

| Contract | Required behavior |
| --- | --- |
| Configuration | Translate applicable OMP roles, model catalog/overrides, tool/resource policy, and effective effort into an immutable per-attempt snapshot. Unknown required mappings are visible compatibility failures, not silent model substitutions |
| Credentials | Reuse the existing OMP credential owner; prove existing-account selection, refresh/concurrency, custom endpoints/headers, and continued OMP access afterward. No second login by default, secret copying, raw credential-row reads by Go, or new refresh loop |
| Tool history | The plan records DeepSeek's prior `reasoning_content` requirement for tool conversations. Preserve required provider transport history inside the adapter; prove a multi-turn tool round trip plus compaction/resume. Do not copy internal reasoning into shared packets |
| Statistics | Keep Pi transcripts separate; export completed usage through an OMP-compatible transcript/outbox with stable identities. Let OMP ingest; never write its derived stats database directly or count native and projected records twice |
| Usage replay | Ingest twice and crash between publication/acknowledgement; totals must remain unchanged. Preserve real usage on cancellation and represent missing cost as unknown. Execution completion and pending statistics export are separate |
| Lifecycle | Go owns start/steer/abort/stop/resume/close and full process-tree cleanup. Persist identity before launch, preserve worktree changes, do not auto-replay uncertain side effects, and never run one attempt in both legacy and Pi runtimes |

The existing provider-allowance view using `omp usage --json` is different from locally consumed usage recorded by `omp stats --json`. Preserve both roles. Do not point Pi's agent directory at `~/.omp/agent` and call that compatibility.

### Separate Foyer implementation sequence

These are the unimplemented product phases from the canonical Pi plan, not replacements for the ten OMP upgrade tasks later in this handoff.

| Phase | Scope | Observable release gate |
| --- | --- | --- |
| Compatibility tracer | One real DeepSeek worker through a direct Pi host, one versioned context packet, real streamed tool action, existing OMP settings/auth, usage export | No OMP coding-agent execution in the process path; real response/tool result visible; response counted once in OMP stats |
| Lifecycle owner | Integrate Go host control and attempt persistence into driver/planner/store seams | Start, steering, cancellation, failure, crash and resume; no orphan process or duplicate attempt |
| Full caller cutover | Office/member launch, Goals, panes, Telegram/remote controls and shared session metadata | Every supported entry point uses the same Go lifecycle; preserve member identity, authorization, history/copy/interrupt behavior; no hidden OMP fallback |
| Compatibility completion | Tool/key/resource matrix, Mnemopi seam, directed context, request inspector, durable export | No required capability dropped; corrections and resumed context work; replay preserves totals and credentials |
| Product release | Current SPEC/design/docs, removal of obsolete managed-OMP execution paths, integrated build and native evidence | Background Wails proof plus versioned portable executable and installer; preserve the previous release and data for rollback |

The source plan names `orchestrator_driver.go`, `orchestrator_planner.go`, `orchestrator_store.go`, `orchestrator_files.go`, `pty.go`, `sessions.go`, `agents.go`, profile/usage consumers, and `SPEC.md` as seams. Those paths predate the ongoing restructuring; resolve their current locations instead of recreating obsolete root files.

The tracer proves the interface before multiplying workers; it is not permission to ship a reduced migration. Compare old versus direct host with the same model, effort, prompt, tools, worktree, context, and acceptance. Compare model choices separately. Measure time to accepted result, process memory/CPU, startup, tool latency, context duplication, tokens/cost, and repair work across representative repeated runs. User-supplied quota/roster screenshots are interaction references, not reproducible benchmarks.

### How this constrains the OMP upgrade

Fix OMP now because it remains the current working harness and retained compatibility owner. Do not postpone todo preservation/output fidelity until the swarm exists. Preserve compatible auth/settings/statistics interfaces and the local Foyer companion bridge during the rebase. Upstream only generic relevant fixes, not Foyer-specific scheduling or private product context.

Completion of the OMP upgrade does **not** mean the DeepSeek swarm is implemented. Completion of the current global delegation pause does **not** forbid the future separately managed Foyer workers. Preserve both statements in any next handoff or status report.

## State at handoff

| Surface | Observed state | Evidence or consequence |
| --- | --- | --- |
| Output policy | Corrected in canonical config and BALANCED; live config generated by sync | All three values agree; exact command and hash below |
| Installed CLI | `omp/18.1.15` | Output of `omp --version` |
| Vault installation pin | `18.1.15` | `___claude-fatih/env.yml`, `ompInstall.version` |
| Unified patch base | `18.1.15` | Fork `scripts/omp-reapply-patches.py`, `UNIFIED_BASE_VERSION` |
| Latest stable release | `v18.1.18` when queried | `gh api repos/can1357/oh-my-pi/releases/latest --jq .tag_name`; recheck before selecting the release |
| Patch-engine tests | 17 run, 15 pass, 2 fail | Pre-existing P14-related fixture/expectation failures; exit 1 |
| Harness fixes | Design and current-behavior reproductions only | No fix implementation or installation was performed in the prior session |
| PR | Not created | Upstream relevance and current PR states have not been rechecked for this upgrade |
| Fork Git state | Not inspected | Git tool rejected the external fork cwd from the vault-rooted session |
| Foyer working tree | Not changed by this audit/policy task | It has a separate active writer; do not overlap it |

### Why work stopped

The previous session was rooted at `D:/__CODING/personal/__my-vault`. Its `git_read` tool rejected the fork:

```text
Refused: cwd "D:/__CODING/open-source/forks/oh-my-pi" is outside the session directory D:\__CODING\personal\__my-vault
```

A permitted `git_read rev-parse --show-toplevel` returned the vault root. This was a tool scope restriction, not a Git repository failure, signing failure, installation failure, or need for a new clone. File reads and this handoff write were possible. A session rooted in the fork should use its normal Git tools and inspect state before acting.

No fork commit, fetch, rebase, source edit, PR, or patch-engine application was performed during the attempted upgrade. This handoff is the only new fork file written by this session. Do not assume the fork itself is clean: other work may exist, and its status remains unknown.

## Completed immediate output-policy correction

| Setting | Previous override | Current value |
| --- | ---: | ---: |
| `tools.artifactSpillThreshold` | 1 KB | 50 KB |
| `tools.artifactTailLines` | 5 | 500 |
| `tools.outputMaxColumns` | 120 | 768 |

These are existing schema defaults, not a newly invented tuning profile.

| Role | Path | Action already performed |
| --- | --- | --- |
| Canonical output policy | `D:/__CODING/personal/__my-vault/___claude-fatih/omp/agent/config.yml` | Three values changed through Edit |
| Foyer profile policy | `D:/__CODING/personal/__my-vault/___claude-fatih/omp/agent/foyer-profiles/balanced.json` | Same values changed through Edit |
| Generated live config | `C:/Users/GNERyze/.omp/agent/config.yml` | Generated by the established sync script, not edited directly |

Command already run from `D:/__CODING/personal/__my-vault/___claude-fatih`:

```sh
uv run scripts/sync-to-global.py --only omp-config --force
```

Result: exit 0. The plan pushed the newer canonical config to global and saved `config.yml.syncbak`. Config and agent files were verified. Canonical and live config had identical SHA-256:

```text
453ee9638cac9df5ab3b8153211a9fbe581a168ee8a43ee9e1d16be55224c990
```

The previous session also read all three policy copies after sync and verified `50 / 500 / 768`. Preserve these values through the upgrade and future BALANCED application. The worker-routing guard did not contain or own these three fields when searched; do not add a second policy owner.

The audit report still describes `1 / 5 / 120` as the policy that caused the captured behavior. That is historical evidence, not the current desired configuration. Update the report's deployment/status sections after implementation without deleting the old comparison.

## Source-of-truth map

| Concern | Authority |
| --- | --- |
| Fork checkout | `D:/__CODING/open-source/forks/oh-my-pi` |
| Patch engine, conflicts, rollback | Fork `scripts/omp-reapply-patches.py` |
| Unified source patch | Fork `scripts/omp-unified.patch` |
| Installation version | Vault `___claude-fatih/env.yml`, `ompInstall.version` |
| Installation and sync policy | Vault `___claude-fatih/scripts/sync-to-global.py` |
| Installed package observed | `E:/CACHE/Bun/install/global/node_modules/@oh-my-pi/pi-coding-agent` |
| Installed sibling packages | Same `@oh-my-pi` directory, including `pi-ai` and `pi-catalog` |
| Current release integration worktree | Fork `tmp/upstream-unified-18.1.15`; inspect before touching |
| Future release worktree | Derive its path and branch from the selected release using the upgrade skill |
| Audit deliverables | Vault `docs/foyer-transcript-audit-2026-09-12.*` |

The fork owns patch checks and conflict resolution. The vault owns the pin and sync policy. Never create a vault copy of the patch engine, edit the installed source as the primary fix, or assume the fork's main checkout is the patch-base source tree.

### Skills needed at the relevant steps

| Step | Skill |
| --- | --- |
| Release upgrade, rebase, installation | `omp-fork-upstream-rebase` |
| New local behavior in unified patch | `omp-fork-add-patch-behavior` |
| Minimal implementation | `ponytail` |
| Behavioral regression proof | `proving-work` |
| Commit and signing | `git-commit`; chain to `fix-gpg` if signing fails |
| Render the updated audit | `docmd` |

OMP worker delegation remains globally disabled. Main performs this upgrade's implementation. Do not enable OMP workers, an advisor, or a different global model-routing policy to address this task. The separately planned Foyer-managed DeepSeek workers are covered above and are not activated by this handoff.

## Audit evidence already collected

Read the report first; use the evidence JSON for exact record locators and source hashes. Do not load the whole transcript unless a question requires it.

| Artifact | Absolute path |
| --- | --- |
| Canonical report | `D:/__CODING/personal/__my-vault/docs/foyer-transcript-audit-2026-09-12.md` |
| Rendered report | `D:/__CODING/personal/__my-vault/docs/foyer-transcript-audit-2026-09-12.html` |
| Derived evidence, call index, todo snapshots, source hashes | `D:/__CODING/personal/__my-vault/docs/foyer-transcript-audit-2026-09-12.evidence.json` |
| Installed-source experiment results | `D:/__CODING/personal/__my-vault/docs/foyer-transcript-audit-2026-09-12.replay.json` |

The report passed docmd grammar/render checks and background browser verification: nine sections, desktop width 1440, mobile width 390, no page overflow, valid local evidence links, both themes, section navigation, visible keyboard focus, reduced motion, and no broken assets or leak-phrase matches.

### Frozen transcript identity

Directory:

```text
C:/Users/GNERyze/.omp/agent/sessions/--D--__CODING-personal-__my-vault-foyer--/
```

Filename:

```text
2026-09-12T08-29-38-464Z_01a094bc-8720-7000-a861-9aeab39cfed5.jsonl
```

Snapshot: 4,476 JSONL records, 15,609,627 bytes, cutoff `2026-09-12T16:08:52.358Z`. SHA-256:

```text
f8741124ec06a5ef243c117863ef764d22ef7b4403caca9e36b05ac296c99cb6
```

The session was active, so later whole-file hashes can differ. Restructuring evidence starts at record 718. The evidence JSON also retains the earlier 10:32:37 snapshot identity. Do not report the old 6/58 state as current or claim the full run was continuously stalled.

### Findings that remain factual regardless of upstream changes

| Finding | Recorded evidence |
| --- | --- |
| Long run | 6h 21m 52s from approval to cutoff, including 1h 53m 26s explicitly interrupted and 5m 16s waiting for a storage answer |
| Call volume | 1,358 restructuring tool calls; 1,025 Read/Grep/Glob calls, or 75.5% |
| Model attribution | Astra 106 calls; Luna 1,252 calls. Later Luna work includes 119 Edit calls and 70 Bash calls, so the early stall is not the whole run |
| Python | 24 Python Eval calls during restructuring, all inspected bodies reading/validating data; zero new `.py` Write targets and no observed Python-driven Go rewrites |
| Latest Foyer proof captured | Selected root tests report 148 passing; this is not a full-suite or release pass |
| Latest visible todo state | 22 completed, 35 open, 57 total; one obligation from the 58-item recorded scope disappeared |

Latest selected Foyer command captured, not rerun by the audit:

```sh
gofmt -w supervisor_compat.go orchestrator_planner.go &&
go test ./internal/ptyhost &&
go test -run 'Test(Supervisor|Orch|Planner|RPC)' -count=1 .
```

Its result is at L4382, with 17.55-second wall time. The explicit interruption is supported by assistant `aborted` at L4377 and companion `interrupted`/`working` state changes at L4378/L4379. Do not attribute that interval to provider inference.

## Permanent fixes to recheck against the selected upstream release

The following behavior was verified against installed 18.1.15 source. Nine relevant files matched byte-for-byte between the installed packages and the 18.1.15 merge worktree; hashes are in the evidence JSON. Recheck each defect against the new stable release and current upstream PR base before implementing or publishing. If upstream already fixes one, prove that behavior, record its disposition, and avoid duplicating the patch.

### P0: Preserve todo state through exploration rewind

**Observed loss:** `Promote cited usage snapshot fixture` was appended inside a checkpoint. No remove/drop/re-init operation followed, but the task disappeared after rewind.

| Event | JSONL record | Result |
| --- | --- | --- |
| Initial todo list | L726 call / L728 result | 57 tasks |
| Fixture obligation appended | L1205 call / L1211 result | 58 tasks; fixture present |
| Rewind | L1316 call / L1319 report | Branch rewound to an earlier checkpoint |
| Next todo result | L2218 | 57 tasks; fixture absent |
| Latest canonical todo result | L3998 | 22 completed, 35 open, fixture absent |

18.1.15 source path:

- `packages/coding-agent/src/session/agent-session.ts`, `AgentSession.#applyRewind`, around lines 8373-8421.
- `packages/coding-agent/src/session/todo-tracker.ts`, `syncFromBranch`.
- `packages/coding-agent/src/tools/todo.ts`, `getLatestTodoPhasesFromEntries`, around lines 177-198.

`#applyRewind` calls `branchWithSummary`, rebuilds the active messages, then calls `todo.syncFromBranch`. The reducer reads the last surviving todo result/user todo edit on that shortened branch. No current todo snapshot is carried in the branch summary.

**Reproduction already run:** actual installed `SessionManager.inMemory`, `branchWithSummary`, and `getLatestTodoPhasesFromEntries`: one original task, checkpoint, append second task, rewind and recover -> **2 tasks become 1**. This proves the primitive path; extend the integrated AgentSession regression for the implementation.

**Preferred fix:** capture the complete current todo phases before branching; store them in the existing branch-summary details atomically; recover them through the existing todo reducer. Preserve phase order, exact content, status, and blockers. An explicit empty snapshot must stay empty. Scope preservation to exploration checkpoint/rewind, not explicit user history branching, which should retain historical semantics. Do not add another state file or impersonate a user edit entry.

Regression seam: `packages/coding-agent/test/agent-session-checkpoint-rewind-branch.test.ts` plus `test/tools/todo.test.ts`. Cover append, complete, block, clear, reload, and explicit-history-branch distinction. Do not auto-complete a task or assume moved files mean acceptance passed.

### P1: Preserve bounded source output

The completed configuration correction removes the worst overrides, but the shared output wrapper can still summarize a deliberately bounded source slice a second time.

18.1.15 source:

- `packages/coding-agent/src/tools/output-meta.ts`, `getSpillConfig`, `spillLargeResultToArtifact`, `wrapToolWithMetaNotice`.
- `packages/coding-agent/src/tools/read.ts`, bounded selection metadata and ordinary/raw line rendering.
- `packages/coding-agent/src/config/settings-schema.ts`, existing output defaults.

The old wrapper spills above 1 KB and uses `maxLines = tailLines * 2`, `maxHeadLines = tailLines`. With the old tail value of five, it keeps five head/five tail lines. It already exempts artifact reads; do not implement a duplicate artifact-read exemption. Ordinary Read views also cap columns; raw mode already skips that column clipping, but raw file slices can still hit the generic post-tool spill.

**Reproduction already run:** actual installed wrapper, a 3,872-byte/56-line source fixture with a required declaration in the middle:

| Policy | Middle visible | Lines elided | Artifacts |
| --- | --- | ---: | ---: |
| Old 1 KB / 5-line policy | No | 46 | 1, containing the wrapper's full input |
| Existing schema defaults | Yes | 0 | 0 |

**Preferred fix:** let Read own bounded source paging. Use trusted structured provenance to prevent a second generic elision pass on an explicit source selection that satisfies Read's existing byte/line safety limits. Preserve huge-file, huge-line, unbounded-output, foreign-tool, and artifact safety limits. Oversized selections need deterministic recovery ranges, not an implication that omitted bytes were shown.

Regression seams: existing Read/output tests, `test/tools/read-artifact-large.test.ts`, and `test/tools/output-caps.test.ts`. Verify the required middle declaration, bounded raw fidelity, huge input caps, artifact-save failure behavior, and no re-spilling of existing artifact reads.

### P2: Keep lifecycle tools typed and directly exposed

Four `write xd://rewind` calls sent prose instead of JSON and failed with the same parser error. Those errors are at L1063, L1314, L1393, and L1420.

18.1.15 `packages/coding-agent/src/tools/xdev.ts` contains `XDEV_KEEP_TOP_LEVEL` with `todo`, `ask`, `grep`, and `web_search`. Checkpoint/rewind are not retained there. Their arguments travel as JSON inside `write.content` even though native schemas already exist.

**Preferred fix:** retain enabled checkpoint and rewind as typed top-level tools through the existing exposure policy. Reuse schemas and execution handlers; preserve enable/disable behavior and lifecycle invariants. For remaining devices, include the expected schema in parse errors as the validation-error path already does. Do not guess malformed arguments or silently execute repaired input.

Regression seams: `test/write-xdev-dispatch.test.ts`, existing checkpoint tests, and SDK tool-exposure coverage. Recheck upstream support before adding anything.

### P3: Make progress and repetition protection outcome-aware

18.1.15 source:

- `packages/coding-agent/src/session/todo-tracker.ts`, `onToolResult`, `takeMidRunNudge`.
- `packages/coding-agent/src/session/agent-session.ts`, synchronous tool-result accounting and the existing later `semanticToolResult` decoding.
- `packages/coding-agent/src/session/stream-guards.ts`, `LoopGuards`.
- `packages/ai/src/utils/tool-call-loop-guard.ts`, `ToolCallLoopGuard`.

Current accounting treats successful Bash/Eval/Edit/Write/AST tool names as mutations. Read-only Python and `write xd://lsp` can therefore consume mutation-based reminder budgets. Reads do not increment that counter. Merely calling Todo resets the counter before semantic success/state comparison. Mid-run reminder count is capped per cycle.

**Experiments already run:** 100 successful Read results -> zero nudges; 36 successful Write results -> two nudges. These fixtures describe the current tracker, not desired reminder frequency.

The repeated-call guard hashes complete batches and catches only consecutive identical batches. It already ignores the intent field. A changed selector, alternating tool, or changed batch resets the match. Replaying 1,008 captured assistant responses through the installed detector produced zero detections.

**Preferred change:** reuse semantic device decoding at the accounting boundary. Distinguish observation, known source changes, verification, and unknown effects. Rearm reconciliation on actual successful canonical todo-state change, not view/error/no-op. Extend the existing detector with bounded recurring-operation/outcome tracking, using existing policy ownership rather than a second configurable watchdog.

Safety constraints for enforcement:

- Suppress duplicate execution only when resource freshness is established. Changed files, selectors, results, objectives, network state, or unknown command effects must remain actionable.
- Do not force Edit, hide required tools, auto-close Todo, count shell success as acceptance, or block legitimate read-only research.
- A duplicate can reuse a still-valid prior result/recovery range. Otherwise allow the fresh operation and issue one specific redirect per detected episode, not repeated generic warnings.
- Keep progress state coherent through checkpoint/rewind. A new memory system, advisor, or worker is not required.

Regression seams: `test/agent-session-todo-mid-run-nudge.test.ts`, `test/agent-session-tool-call-loop-guard.test.ts`, and the existing AI guard tests. Prove alternating unchanged cycles and the fresh-evidence exceptions; do not settle for a wording assertion.

## Preserve every existing local behavior

Registry observed in `scripts/omp-reapply-patches.py`:

| Marker | Behavior | Publication boundary |
| --- | --- | --- |
| S1 | Session-switch thinking effort | Carried upstream PR #8029; recheck merged state |
| P1 | getLoader JSON/TOML/text assets | Local only |
| P6 | Guided-goal ask-tool interview | Carried upstream PR #8187; recheck merged state |
| P7 | Guided-goal recon-first | Fork PR fatihaziz/oh-my-pi#1; not an upstream payload |
| P8 | Hidden Windows editor shell | Local only |
| P9 | Guard a launcher that exits successfully without opening the editor | Upstreamable; preserve unless upstream equivalent is proven |
| P11 | OpenRouter usage in `omp usage` | Upstreamable; preserve |
| P12 | Codex HTTP failure context in pi-ai | Upstreamable; preserve |
| P13 | Astra mandatory reasoning in pi-catalog | Upstreamable; preserve and regenerate compiled catalog if changed |
| P14 | Foyer companion session bridge | Local only; preserve |

P14 source is `packages/coding-agent/src/session/companion.ts`; its current bundle marker is `foyer-companion-v1`. The registry describes the authoritative final-settle snapshot and supported resolver for an open ask dialog. Do not delete P14 to make old tests pass.

P3 is retired because the thinking label is upstream-native. P5 fresh-session vibe autostart is retired by user decision. Fresh sessions start normally; vibe remains explicit. Do not resurrect either while carrying an old worktree's deltas.

### Pre-existing engine-test failure

Command already run from the fork:

```sh
uv run python -m unittest scripts.test_omp_reapply_patches
```

Observed result: **17 tests, 2 failures, exit 1**.

- `test_all_markers_missing_on_pristine_bundle` expects `[S1, P1, P6, P7, P8, P9, P11, P12, P13]`, but the current engine also contains P14.
- `test_all_markers_present_on_patched_bundle` fails `all(r['present'] for r in results)` against its patched fixture.

Classify these as pinned pre-existing marker-test drift, not a regression from the output-policy edit. Inspect the fixtures and current registry before repair. Preserve actual marker detection coverage, especially rollback integrity; do not remove a behavior or weaken a meaningful assertion to get green.

## Ordered continuation

### Upgrade and integration

1. Inspect fork/worktree status and remotes once. Preserve user changes. Recheck stable release, carried PR merged fields, engine base, vault pin, installed version, and package mappings independently.
2. Use a fresh release-based integration worktree as the upgrade skill prescribes. Resume an existing matching unfinished integration only after inspecting it; never reset or reuse a worktree based on a different release.
3. Carry registered behavior at source/test seams, resolving conflicts as combined contracts. Do not copy old whole files over new upstream source or carry fork tooling into the source delta.
4. Recheck P0-P3 against the release and upstream PR base. Record each as still needed, already fixed with proof, or requiring a revised seam. Implement every still-relevant requested behavior with regression evidence.
5. Complete integration checks, generate the unified patch, update the engine base/mappings/markers as needed and the vault pin, then publish only the warranted upstream changes.

Use the upgrade skill's exact dependency/native-binary procedure. For TypeScript-only work, use the matching published Windows native binary rather than compiling unrelated Rust. A native file at the right path is not proof of version compatibility; the loader has a release-specific sentinel. Preserve Astra's `none -> low` reasoning behavior on the separate Codex transport and regenerate canonical KDL into compiled catalog JSON if catalog policy changes.

### Upstream PR relevance and scope

The user authorized a PR **if still relevant and needed**, not automatic publication of the whole fork.

- Check upstream release/main and existing issues/PRs before duplicating a fix. Closed does not mean merged.
- Use a clean focused PR branch. Include only upstream-relevant source, behavioral tests, and required changelog entries.
- Exclude the local patch engine, its tests, unified patch payload, fork registry section, vault config/profile changes, Foyer-specific P14 behavior, and this handoff from an upstream PR unless that PR explicitly concerns one of them.
- Preserve local-only behavior in the installed unified patch even when it does not belong upstream.
- Do not publish unrelated existing vault commits, force-push main/master, skip hooks/signing, or claim a PR exists without its URL. If upstream already fixed a defect, report the evidence instead of opening a duplicate.

### Local application

Patch application belongs to the fork engine. Installation and pin application belong to the vault sync script. After the release integration and patch generation are ready, run from the vault sync root:

```sh
uv run scripts/sync-to-global.py --only omp-local,omp-cli-patches --force
```

`omp-local` is the installation selector. It is not the configuration selector. The completed output-policy correction used `omp-config` separately; preserve that distinction.

If regenerated same-version source is already patched, follow the skill's previous-patch reverse/apply procedure. Preserve backups, inspect the existing helper's all-package behavior, and let the engine own conflict checks and rollback. Do not force a patch onto diverged installed source or modify shipped files as the primary fix.

Installed proof from the fork:

```sh
uv run scripts/omp-reapply-patches.py --dry-run
omp --version
omp --smoke-test
```

All retained markers must be present, version must equal the selected pin, and the smoke must pass. Also exercise the changed behavior against the installed runtime; markers alone do not prove todo preservation, output fidelity, native tool exposure, or loop protection. Test in a background-safe isolated session, not by driving the user's desktop or altering the active Foyer writer.

A running process may retain old loaded JavaScript. Do not confuse that with a failed installation or tell the user to restart the CLI. A new isolated installed-runtime proof is required.

## Acceptance and final delivery

| Deliverable | Required evidence |
| --- | --- |
| Upgrade | Selected stable tag, matching installed version and vault/engine pins |
| Preserved local behavior | Every retained marker present after installation; changed behavior exercised |
| P0 todo preservation | Append/status/blocker/clear/reload pass; explicit history branching remains correct |
| P1 output fidelity | Required middle declaration returned on first bounded read; huge input and artifact safety still pass |
| P2 typed lifecycle | Advertised enabled tools validate native arguments; disabled tools stay disabled; malformed device input never executes |
| P3 progress/repetition | Read-only transport cannot masquerade as mutation; real state change rearms reconciliation; stale cycles and fresh-evidence exceptions pass |
| Engine integrity | Marker tests reconciled without dropping P14; multi-package rollback regression remains green |
| Profile consistency | Canonical, BALANCED, and generated live output policy remain 50 KB / 500 lines / 768 columns after sync/profile application |
| Upstream publication | Focused PR URL with clean scope, or explicit evidence that upstream already fixes the relevant defect |
| Audit update | Source Markdown and regenerated HTML distinguish historical reproductions, completed fixes, installed proof, and remaining risks |

Run narrow checks for changed seams, then the integration gates once. Relevant existing check entry points include `bun run check:ts`, the focused test files above, and the engine unittest command. Use the actual selected release's package scripts and established harnesses; do not invent a new test framework or a source-text test merely to obtain a green count.

A new implementation regression must be repaired. A pinned baseline red must remain explicitly identified; it is not a release pass. No provider-speed claim is supported by the current reproductions. Measure matched post-fix slices by recovery calls, repeat errors, and edit-to-proof-to-todo transitions before claiming faster execution.

### Recovery of the already-lost Foyer obligation

The harness fix prevents new loss but cannot infer a task missing from old branch state. The known missing obligation is `Promote cited usage snapshot fixture`. In the owning Foyer session, add it back only if absent and preserve its incomplete state until consumer migration/proof is complete. Keep the 22 recorded completed tasks. Do not mark the fixture task complete merely because its SQLite file was moved.

This recovery is separate from implementing the OMP fix. Do not overlap Foyer's active writer or silently remove the obligation from the handoff.

## Pending task ledger

Immediate policy tasks are completed. The ten original upgrade tasks remain unfinished; their previous blocked status was due to the old session directory, not a decision to abandon them. Rehydrate them in a fork-rooted session and advance them from actual evidence.

### Upgrade

- [ ] Inspect current upstream release and local patch state.
- [ ] Update pinned OMP and rebase existing local patches.

### Fixes

- [ ] Recheck todo preservation defect against updated upstream.
- [ ] Recheck bounded output fidelity against updated upstream.
- [ ] Recheck lifecycle tool exposure against updated upstream.
- [ ] Recheck semantic progress and repetition guards upstream.
- [ ] Implement remaining relevant fixes with regression proof.

### Publication

- [ ] Create focused upstream pull request when still warranted.

### Installation

- [ ] Apply unified patch through established local synchronization.
- [ ] Verify installed runtime behavior and update audit evidence.

## Boundaries that must survive the handoff

- The user wants a permanent harness fix, not more instructions pasted into the active session, a global Python ban, or an unproven model switch.
- OMP delegation stays disabled during this work. Main owns upgrade implementation and verification. Preserve the separate Foyer-managed DeepSeek swarm plan; do not confuse the two execution authorities.
- Preserve unrelated dirty work, existing local-only patches, signing, and rollback. Never stash/reset/discard working-tree changes or bypass hooks.
- No foreground desktop input, forced process shutdown, secret extraction, `.env` access, or direct live-config edits.
- Keep this handoff out of upstream PRs. Keep private transcript contents and user-specific operational context out of public issue/PR bodies; publish minimal synthetic reproductions instead.

The prior session completed the policy correction, audit, experiments, and this handoff. It did not complete or claim completion of the upgrade, permanent harness fixes, or Foyer's direct-Pi DeepSeek swarm. The swarm context was recovered from the original user messages and canonical Pi plan after the user identified its omission from the initial handoff.
