# SDK

The SDK is the in-process integration surface for `@oh-my-pi/pi-coding-agent`.
Use it when you want direct access to agent state, event streaming, tool wiring, and session control from a Bun process.

If you need cross-language/process isolation, use RPC mode instead.

## Installation

```bash
bun add @oh-my-pi/pi-coding-agent
```

Requires Bun 1.3.14 or newer. Before the first model-backed prompt, configure
credentials for a provider or run a keyless local provider; see
[Providers](./providers.md). Session construction can succeed without an
available model, but prompting cannot.

## Entry points

The package root, `@oh-my-pi/pi-coding-agent`, is the complete embedding surface. It includes `createAgentSession` and the focused `/sdk` exports, plus lower-level session, auth, model, mode, extension, and tool APIs.

Import these core embedding APIs from the package root:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `AgentRegistry`
- `discoverAuthStorage`
- Discovery helpers (`discoverExtensions`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`, `discoverMCPServers`)
- Tool factory surface (`createTools`, `BUILTIN_TOOLS`, tool classes)

The narrower `@oh-my-pi/pi-coding-agent/sdk` subpath exports `createAgentSession`, its option/result types, `Settings`, `AgentRegistry`, discovery and system-prompt helpers, workspace-tree helpers, selected extension/MCP/tool types, and selected tool classes/factories. It does **not** export `SessionManager`, `AuthStorage`, or `ModelRegistry`; import those three from the package root as the examples below do.

## Quick start (auto-discovery defaults)

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

## What `createAgentSession()` discovers by default

`createAgentSession()` follows “provide to override, omit to discover”.

If omitted, it resolves:

- `cwd`: `getProjectDir()`
- `agentDir`: `~/.omp/agent` (via `getAgentDir()`)
- `authStorage`: `discoverAuthStorage(agentDir)`
- `modelRegistry`: `new ModelRegistry(authStorage)` + background `refreshInBackground()` when the registry is not provided
- `settings`: `await Settings.init({ cwd, agentDir })`
- `sessionManager`: `SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))` (file-backed)
- skills/rules/context files/prompt templates/slash commands/extensions/custom TS commands
- built-in tools via `createTools(...)`
- MCP tools (enabled by default; Exa MCP servers are folded into native Exa integration, and browser automation MCP servers are filtered when the built-in Eval browser prelude is enabled)
- LSP integration (enabled by default)
- `eventBus`: new `EventBus()` unless supplied

### Required vs optional inputs

Typically you must provide only what you want to control:

```ts
function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>;
```

- **Must provide**: nothing for a minimal session
- **Usually provide explicitly** in embedders:
  - `sessionManager` (if you need in-memory or custom location)
  - `authStorage` + `modelRegistry` (if you own credential/model lifecycle)
  - `model` or `modelPattern` (if deterministic model selection matters)
  - `settings` (if you need isolated/test config)

For multiple concurrent top-level sessions in one process, pass a private
`AgentRegistry` to each session. The default process-global registry admits
only one `"Main"` identity per generation.

## Session manager behavior (persistent vs in-memory)

`AgentSession` always uses a `SessionManager`; behavior depends on which factory you use.

### File-backed (default)

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

console.log(session.sessionFile); // absolute .jsonl path
```

- Persists conversation/messages/state deltas to session files.
- Supports resume/open/list/fork workflows.
- `session.sessionFile` is defined.

### In-memory

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

console.log(session.sessionFile); // undefined
```

- No filesystem persistence.
- Useful for tests, ephemeral workers, request-scoped agents.
- Session methods still work, but persistence-specific behaviors (file resume/fork paths) are naturally limited.

### Resume/open/list helpers

```ts
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

## Model and auth wiring

`createAgentSession()` uses `ModelRegistry` + `AuthStorage` for model selection and API key resolution.

If both `authStorage` and `modelRegistry` are supplied,
`modelRegistry.authStorage` MUST be the same instance; session creation rejects
divergent stores.

### Explicit wiring

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const available = modelRegistry.getAvailable();
if (available.length === 0)
  throw new Error("No authenticated models available");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model: available[0],
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(),
});
```

### Selection order when `model` is omitted

When no explicit `model`/`modelPattern` is provided:

1. restore model from existing session (if restorable + key available)
2. settings default model role (`default`)
3. an authenticated provider-default model in availability order (falling back to the first authenticated available model when no provider default is present)

If restore fails, `modelFallbackMessage` explains fallback.

### Auth priority

`AuthStorage.keys.get(...)` resolves in this order:

1. runtime override (`keys.setRuntime`, used by CLI `--api-key`)
2. config-sourced API key override (`models.yml` provider `apiKey`)
3. stored OAuth credential, including refresh when needed
4. API key persisted by a successful `/login`
5. provider environment variables
6. other stored API-key credential in `agent.db` / broker-backed storage

Configured values are resolved asynchronously through the registry-installed resolver; catalog construction does not execute credential commands. `ModelRegistry.getProviderHeaders(provider)` and `resolveModelHeaders(model, signal?)` return promises. For direct provider requests, await the latter instead of reading config-backed values from `model.headers`. The AI client's `stream()` and `streamSimple()` materialize `model.resolveHeaders` automatically for each request attempt, including authentication retries.

## Event subscription model

Subscribe with `session.subscribe(listener)`; it returns an unsubscribe function.

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "tool_execution_start":
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
  }
});
```

`AgentSessionEvent` includes core `AgentEvent` plus session-level events:

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `retry_fallback_applied` / `retry_fallback_succeeded`
- `model_changed`
- `thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder` / `todo_auto_clear`
- `irc_message`
- `notice`
- `goal_updated`

`agent_end` includes `messages`, optional telemetry fields, and
`isTerminal?: boolean`. When `isTerminal` is `false`, maintenance or async
delivery will resume the session before its true final settle. Subscribers that
use `agent_end` as a completion signal MUST wait for `isTerminal !== false`.
Treat an absent field as terminal for compatibility with older runtimes.

## Prompt lifecycle

`session.prompt(text, options?)` is the primary entry point.

Behavior:

1. optional command/template expansion (`/` commands, custom commands, file slash commands, prompt templates)
2. if currently streaming:
   - `streamingBehavior: "steer" | "followUp"` chooses how `prompt()` queues
   - extension `sendUserMessage(content)` defaults to steer when `deliverAs` is omitted
   - queued messages are preserved instead of throwing work away
3. if idle:
   - validates model + API key
   - appends user message
   - starts agent turn

Related APIs:

- `sendUserMessage(content, { deliverAs?, attribution? })`
- `steer(text, images?, { attribution? })`
- `followUp(text, images?, { synthetic?, attribution? })`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

`deliverAs: "aside"` (both APIs) delivers at the next agent step boundary without interrupting the current tool batch, instead of steering (which skips remaining tools) or waiting for the run to finish. When the session is idle both start a turn instead (in plan mode the custom message is folded into context without a turn).

## `AgentSession` lifecycle and disposal

Call `await session.dispose()` when the embedder is completely done with a session. `dispose()` starts disposal itself and is idempotent: repeated or concurrent calls receive the same teardown promise, so shutdown events and owned resources are not drained twice.

`beginDispose()` is the synchronous admission barrier for wrappers that must await their own teardown before calling `dispose()`. Call it before the wrapper's first `await`; otherwise deferred work can enter the gap. It immediately marks the session disposed, cancels memory startup, title generation, and auto-learn capture, clears queued yield/asides, stops advisor runtime, detaches aside delivery, and rejects new eval executions. Deferred session work checks the disposed state and is dropped or skipped. `beginDispose()` is also idempotent, and the later `dispose()` call remains required to finish asynchronous cleanup.

```ts
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

async function closeEmbeddedSession(
  session: AgentSession,
  closeHostInputAndUi: () => Promise<void>,
): Promise<void> {
  session.beginDispose(); // no new deferred work may enter after this point
  await closeHostInputAndUi();
  await session.dispose();
}
```

During asynchronous disposal, the session records and synchronously flushes its exit diagnostic, emits `session_shutdown` once, stops extension fallback timers, aborts retries, compaction, and the active agent turn, and gives post-prompt and auto-learn work bounded time to settle. It then tears down session-owned async jobs, eval kernels, browser tabs, native computer sessions, MCP connections, advisor state, and memory state concurrently. These subsystem drains are best-effort and bounded where applicable; failures are logged rather than preventing the remaining subsystem cleanup.

Only after work capable of appending session entries has settled does disposal clean up an empty moved session, close the `SessionManager`, close provider session state, disconnect the agent, and remove listeners. A failure from the final persistence cleanup or `SessionManager.close()` rejects the shared disposal promise; individual provider-session close failures are logged.

## Tools and extension integration

### Built-ins and filtering

- Built-ins come from `createTools(...)` and `BUILTIN_TOOLS`.
- `toolNames` requests named tools and can enable tools that are disabled by
  default; by itself it is **not** an allowlist.
- Set `restrictToolNames: true` to limit the session to the names in
  `toolNames`. Restricted sessions disable ambient MCP, extensions, custom
  commands, and LSP by default.
- Restricted children retain hooks/providers from the parent's
  `preloadedPreparedExtensions`, rebound to their own session. Contributed tools
  cannot extend or replace the restricted tool set, even when registered later.
- In a restricted session, SDK-supplied `customTools` are excluded unless
  `allowRestrictedCustomTools: true` and their names also appear in
  `toolNames`.
- Hidden tools (for example `yield`) are opt-in unless required by options.

```ts
const { session } = await createAgentSession({
  toolNames: ["read", "grep", "glob", "write"],
  restrictToolNames: true,
  requireYieldTool: true,
});
```

### Extensions

- `extensions`: inline `ExtensionFactory[]`
- `additionalExtensionPaths`: load extra extension files
- `disableExtensionDiscovery`: disable ambient scanning; explicit paths and
  inline factories still load
- `preloadedExtensions`: reuse an extension set loaded early by the same
  session-owning process. Never pass loaded extension instances from a parent
  to another session; use `preloadedPreparedExtensions` so each session gets its
  own `ExtensionAPI` binding.
- `preloadedPreparedExtensions`: already-imported factories to rebind, including
  in restricted children; does not reevaluate the module graph.
- `extensionRoots`: a live owner-root provider for child discovery and revival.
  Its explicit roots, discovery mode, and configured roots take precedence over
  the child's local extension-loading inputs.

### Runtime tool set changes

`AgentSession` supports runtime activation updates:

- `getActiveToolNames()`
- `getAllToolNames()`
- `setActiveToolsByName(names)`
- `refreshMCPTools(mcpTools)`

System prompt is rebuilt to reflect active tool changes.

## Discovery helpers

Use these when you want partial control without recreating internal discovery logic:

- `discoverAuthStorage(agentDir?)`
- `discoverExtensions(cwd?)`
- `discoverSkills(cwd?, _agentDir?, settings?)`
- `discoverContextFiles(cwd?, _agentDir?, disabledExtensions?)`
- `discoverPromptTemplates(cwd?, agentDir?)`
- `discoverSlashCommands(cwd?)`
- `discoverCustomTSCommands(cwd?, agentDir?)`
- `discoverMCPServers(cwd?)`
- `buildSystemPrompt(options?)`

## Subagent-oriented options

For SDK consumers building orchestrators (similar to task executor flow):

- `outputSchema`: passes structured output expectation into tool context
- `outputSchemaMode`: selects permissive or strict structured-output enforcement
- `requireYieldTool`: forces `yield` tool inclusion
- `taskDepth`: recursion-depth context for nested task sessions
- `parentTaskPrefix`: artifact naming prefix for nested task outputs
- `bindProcessState`: `false` for helper sessions spawned on a host session's behalf (see below)

These are optional for normal single-agent embedding.

Process-wide state that follows one settings instance — setting effects (theme, request limits, the fallback credential-redaction switch) and discovery provider toggles — is held by every top-level session on its own `settings` until it is disposed. With several live sessions the newest holder drives it, and disposing a session hands it back to the previous holder. Sessions with `parentTaskPrefix`/`taskDepth` or `bindProcessState: false` never take it. Independently of the holder, each session's own provider requests redact credential-shaped tokens per that session's `secrets.enabled`.

### Foyer external executor (fork-specific)

This fork exposes `registerExternalSubagentExecutor` and
`createExternalSubagentExecutor` for an external process owner. This is not an
upstream-supported plugin contract. The adapter retains native task policy,
parent callbacks, shared Eval and memory services, registry events and telemetry.
It refuses unsupported service configurations before dispatch. An unavailable
owner is an error, not permission to run a local substitute.

The owner launches `omp __omp_worker_subagent` and keeps its stdin open. One host
owns one native child identity. Its readiness frame has protocol
`omp-native-executor`, version `1`, and the capabilities `workspace_v1`,
`parent_relay_v1`, `peer_registry_v1`, `operator_controls_v1` and `terminal_v1`. Require the
applicable capability before using its commands.
Input commands are plain JSONL bounded by the native 64 MiB logical-frame limit. Output uses the
native RPC v2 encoder, including chunked frames; input is not an `rpc_chunk`
reassembly channel.

`parent_relay_v1` adds `executor_models`, `executor_event` and
`executor_progress` for a native child bound in the receiving parent.
`executor_models` returns available chat models and supported efforts at or
below the parent's configured ceiling. It does not export credentials.
The owner relays nested events/progress to that native parent, not directly to
the root registry. `executor_registry` mirrors a direct child without echoing
the same registry update upstream. Custom-tool updates retain their command
ID; `executor_tool_cancel` acknowledges the cancellation request, not the
completion of the underlying callback. A cancelled native owner request keeps
its bounded response slot until the owner settles it.

`peer_registry_v1` keeps remote peers addressable without assigning their
lifecycle to the worker. Before `start` or `workspace_prepare`, send
`executor_peers` with `{agentId, sessionFile, peerRoot, peers}`. `sessionFile`
is the exact child transcript; `peerRoot` is the root parent transcript.
Each peer is `{generation, ref}` with native registry identity, display name,
kind, parent ID, status and transcript. Subsequent `executor_peer` commands
carry `{change, peer}` for native registration, status, metadata or removal.
The host rejects foreign roots and changed generations, and never replaces
its local session or owned-child mirrors.

Worker mailbox sends emit `peer_send` owner requests with the authenticated
worker ID, target ID/generation/transcript, native message and delivery options.
The owner must verify both identities against the same live root and return
the target's native delivery receipt. It must use `IrcBus.deliver` at the root
or the target host's `send` command, not a fabricated transcript or a parent
prompt forwarding the message. Peer refs cannot be parked, revived or released
by the sending worker's lifecycle manager. Owner EOF removes the peer routes.

`operator_controls_v1` adds two bounded operator actions:

- `send` accepts `options.activeOnly: true`. Delivery requires a currently
  streaming native session. It never revives an idle worker or buffers a failed
  delivery for a later turn. Check the native receipt; only `injected` confirms
  delivery to the current turn.
- `follow_up` accepts `modelSelection: {provider, id, thinkingLevel?}` after
  explicit operator approval. The host validates the exact available model and
  supported effort against its native policy. It updates only that session's
  model and thinking history, not global routing. Parking and revival preserve
  the approved selection. Unavailable models and clamped efforts fail before
  prompting; a replaced session must receive the selection again.

The external owner must fence the parent generation, reject overlapping
operations, and keep Stop available. A failed isolated turn must record its
native integration skip before a follow-up. A rejected integration is not
fixed by changing models: expose retained work and an escape instead of
offering a follow-up that repeats the same blocked inputs.
An exception from the native follow-up operation is captured as a failed turn,
using the same artifact capture as the initial turn. Its partial work remains
in the isolated checkout and is not applied to the parent. After the recorded
integration skip, a corrected follow-up can reuse that work.

`terminal_v1` attaches a real `InteractiveMode` to the worker's existing
`AgentSession`. It does not spawn, resume a second session, replay `session_start`,
or start a provider turn. The owner sends `terminal_attach` with `agentId`,
an alphanumeric/hyphen `viewId` (1-80 characters), `cols` (2-500) and `rows`
(2-300). The response reports the native agent, session ID, transcript and PID.
ANSI arrives as `terminal_output` frames carrying `agentId`, `viewId` and `data`.
`terminal_input` accepts at most 64 KiB of UTF-8 per frame. `terminal_resize`,
`terminal_visible` and `terminal_detach` retain the same identity fence.
Hidden views stop rendering; detach releases only the TUI, not the worker.

Text submission emits an owner `terminal_submit` callback with the view ID,
agent ID, text and `streamingBehavior` (`steer` or `followUp`). The owner applies
its existing approval, usage, lease and workspace checks. For an active turn,
`terminal_message` preserves the selected queue behavior and rejects an idle
session. For an idle worker, use the existing approved `follow_up` operation.
The hosted UI follows focused-agent command policy; model/effort changes stay
with the owner. Image submissions currently return an explicit unsupported
error and preserve the editor draft. Completion/error notifications use the
injected terminal transport and cannot write control bytes into executor JSONL.


For isolated execution, use this sequence:

| Command | Required data | Result and boundary |
|---|---|---|
| `workspace_plan` | `plan: {agentId, leaseId, cwd, sessionFile, merge, apply}` | Returns the source repository, planned `cwd`/`worktree`, and native checkpoint path. `leaseId` is a fresh UUID; `merge` is `patch` or `branch`. Planning does not materialize a workspace. |
| Owner admission | Owner-controlled metadata | Canonicalize and reserve the returned path before preparation. Return that path to the parent adapter so shared Eval binds to the worker directory. The native host is not a scheduler or lease database. |
| `workspace_prepare` | The normal `start` payload, including resolved options, settings and authorized model | Validates the child, transcript and reserved directory; materializes native isolation and waits at a start barrier. No agent turn runs yet. Existing workspace or checkpoint namespaces are refused. |
| `workspace_run` | `agentId` | Releases the barrier, runs the native executor, waits for owned cleanup, captures changes and returns the native result. One-shot workspaces are removed only after capture. |
| `workspace_integrate` | `agentId` | Integrates the host's captured result under the reserved policy. The caller cannot supply a replacement result. The owner must serialize integrations into the same repository. Replays return the recorded outcome within this host. |
| `follow_up` | The normal follow-up payload and `agentId` | Requires the preceding integration to be settled and the native child to remain live. Captures a separate turn artifact set. Failed integration must be resolved or the workspace released before reuse. |
| `workspace_release`, `release`, `cancel`, or owner EOF | `agentId` for explicit controls | Cancels a prepared/running turn, drains the native lifecycle, captures final changes and releases the workspace. Failed capture or uncertain teardown retains the workspace and reports its path. The external owner still fences the process tree and confirms exit. |

`inspect` includes the workspace phase, turn, cause, retained path and integration
outcome. `park` preserves native parked-session behavior; it does not exit the
host process. A 3D/2D presentation change must not send lifecycle commands.

Checkpoints and per-turn patches live below the native parent artifact directory
at `.workspaces/<leaseId>/`. They contain isolation baselines, artifact references
and operation outcomes, not a second conversation store. Final release artifacts
remain referenced after registry removal. A checkpoint interrupted during
integration is uncertain: inspect the repository and captured artifacts rather
than automatically replaying it in a new host.

Capture includes failed and cancelled work, but such a result is not
automatically applied. Partial root/nested integration and failed parent-WIP
restoration report failure. `changesApplied` describes native integration; it
does not accept an Office task or replace the operator's review gate.

On Windows, ownership uses the native host PID without a POSIX `ps` probe.
The external owner must retain its OS process handle and containment boundary;
the marker alone is not a generation or PID-reuse guard.

## `createAgentSession()` return value

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: Array<{
    name: string;
    status: "connecting" | "ready" | "error" | "available";
    fileTypes: string[];
    error?: string;
  }>;
  eventBus: EventBus;
};
```

Use `setToolUIContext(...)` only if your embedder provides UI capabilities that tools/extensions should call into.

## Startup performance

`createAgentSession()` runs two background optimizations to overlap I/O with the rest of session setup:

- **Model-host preconnect.** As soon as the model is resolved, the SDK fires a best-effort `fetch.preconnect(model.baseUrl)` so DNS + TCP + TLS + HTTP/2 to the provider's host happens in parallel with extension/skill load, tool registry build, and system-prompt assembly. The first real `fetch(...)` then reuses the warm connection, saving 100–300 ms on transcontinental hops (e.g. residential IP → `api.anthropic.com`). Implementation lives in `preconnectModelHost()` in `packages/coding-agent/src/sdk.ts`. If `fetch.preconnect` is unavailable (non-Bun runtime) or the call throws, the optimization is silently skipped — never a hard dependency. Applies to every mode (interactive, print, RPC, ACP).
- **Conditional LSP warmup.** Startup LSP servers (those returned by `discoverStartupLspServers(cwd)`) are only warmed when **all** of these hold:
  - `enableLsp !== false` on the session options, **and**
  - `options.hasUI === true` (interactive TUI), **and**
  - the `lsp.lazy` setting is disabled (it defaults to `true`).

  With `lsp.lazy` enabled — the default — no language servers are launched at startup at all; each server cold-starts on first use, i.e. when the agent invokes the `lsp` tool or an edit/write touches a file whose extension matches the server's `fileTypes`. Print / script / RPC / ACP invocations (`hasUI=false`) skip the warmup regardless of the setting: they don't render the warmup status indicator and typically finish before the language servers would stabilize, so warming them just spends CPU parsing big `initialize` responses concurrently with the LLM stream consumer and jitters perceived latency. Tools that actually need an LSP server still spin one up on demand through `getOrCreateClient()` — only the _startup_ warmup is skipped. The returned `lspServers` field in `CreateAgentSessionResult` is still populated for UI sessions in lazy mode — recognized servers are discovered (no processes spawned) and reported with status `"available"` so the welcome screen and `/status` can list them; it is `undefined` only when `enableLsp === false` or `hasUI === false`. Turning `lsp.lazy` off mid-session (via `/settings` or any `settings.set()`/reload) runs the same warmup once for those servers, updating their status in place and emitting the usual `lsp:startup` event.

## Minimal controlled embed example

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
  "compaction.enabled": true,
  "retry.enabled": true,
});

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  sessionManager: SessionManager.inMemory(),
  toolNames: ["read", "grep", "glob", "edit", "write"],
  enableMCP: false,
  enableLsp: true,
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Find all TODO comments in this repo and propose fixes.");
await session.dispose();
```
