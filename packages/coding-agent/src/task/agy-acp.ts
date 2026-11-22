import { isAbsolute, join } from 'node:path';
import type { AgentProgress, SingleResult } from '@oh-my-pi/pi-tui/tools/task';
import type { ExecutorOptions } from './executor';
import { cfgTaskDisabledAgents, cfgTaskMaxEffort, cfgTaskPerCallModelAllow, perCallModelEnabled } from './settings';
import { cfgDisabledProviders } from '../config/model-settings';
import { THINKING_EFFORTS } from '@oh-my-pi/pi-catalog/effort';
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type SessionConfigOption } from '@oh-my-pi/pi-utils/acp';
import { spawn } from '@oh-my-pi/pi-utils/ptree';
import { untilAborted } from '@oh-my-pi/pi-utils';

export interface AcpAssignment {
	cwd: string;
	brief: string;
	model: string;
	effort: string;
	mode: string;
	signal: AbortSignal;
}

/** Run a single native ACP turn. Only the caller's explicit brief becomes prompt content. */
export async function superviseAcp(command: readonly string[], job: AcpAssignment, ui: Client, authorize: () => void) {
	job.signal.throwIfAborted();
	if (!command.length || !isAbsolute(command[0]) || !isAbsolute(job.cwd) || !job.brief.trim()) throw new Error('ACP requires an absolute executable, isolated workspace and explicit brief');
	const env: Record<string,string> = {};
	for (const key of ['SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','HOME']) {
		const value = process.env[key];
		if (value) env[key] = value;
	}
	authorize();
	const child = spawn([...command], {cwd:job.cwd, env, stdin:'pipe', windowsHide:true});
	const exited = child.exited.catch(() => undefined);
	const output = new WritableStream<Uint8Array>({async write(bytes) { child.stdin.write(bytes); await child.stdin.flush(); }});
	let sessionId: string | undefined;
	const closing = new AbortController();
	const signal = AbortSignal.any([job.signal, closing.signal]);
	const selected = (options: SessionConfigOption[], id: string) => options.find(o => o.id === id && o.type === 'select');
	const connection = new ClientSideConnection(() => ({
		async requestPermission(request, context) {
			if (!sessionId || request.sessionId !== sessionId || signal.aborted) return {outcome:{outcome:'cancelled'}};
			const stop = context?.signal ? AbortSignal.any([signal, context.signal]) : signal;
			const reply = await untilAborted(stop, async () => ui.requestPermission(request, {signal:stop})).catch(() => undefined);
			const choice = reply?.outcome;
			if (stop.aborted || choice?.outcome !== 'selected' || !request.options.some(o => o.optionId === choice.optionId)) return {outcome:{outcome:'cancelled'}};
			return {outcome:choice};
		},
		sessionUpdate(event) { if (sessionId && event.sessionId === sessionId && !signal.aborted) return ui.sessionUpdate(event); },
		async unstable_createElicitation(request) {
			if (!sessionId || request.sessionId !== sessionId || !ui.unstable_createElicitation || signal.aborted) return {action:'cancel'};
			return await untilAborted(signal, async () => ui.unstable_createElicitation!(request)).catch(() => ({action:'cancel'}));
		},
	}), ndJsonStream(output, child.stdout));
	let cancel: Promise<void> | undefined;
	const stop = () => { if (sessionId) cancel = connection.cancel({sessionId}).catch(() => {}); };
	job.signal.addEventListener('abort', stop, {once:true});
	try {
		return await untilAborted(job.signal, async () => {
			const hello = await connection.initialize({protocolVersion:PROTOCOL_VERSION, clientCapabilities:ui.unstable_createElicitation ? {elicitation:{form:{}}} : {}});
			if (hello.protocolVersion !== PROTOCOL_VERSION) throw new Error('Incompatible ACP version');
			const created = await connection.newSession({cwd:job.cwd,mcpServers:[]});
			if (!created.sessionId) throw new Error('Missing ACP session ID');
			sessionId = created.sessionId;
			let options = created.configOptions ?? [];
			const wanted = [['model',job.model],['thought_level',job.effort]] as const;
			if (!created.modes?.availableModes.some(mode => mode.id === job.mode)) throw new Error(`ACP did not advertise mode=${job.mode}`);
			for (const [id,value] of wanted) {
				const opt = selected(options,id);
				if (opt?.type !== 'select' || !opt.options.some(o => o.value === value)) throw new Error(`ACP did not advertise ${id}=${value}`);
				if (opt.currentValue !== value) options = (await connection.setSessionConfigOption({sessionId,configId:id,value})).configOptions;
			}
			if (created.modes.currentModeId !== job.mode) await connection.setSessionMode({sessionId, modeId:job.mode});
			for (const [id,value] of wanted) if (selected(options,id)?.currentValue !== value) throw new Error(`ACP did not acknowledge ${id}=${value}`);
			signal.throwIfAborted(); authorize();
			return connection.prompt({sessionId,prompt:[{type:'text',text:job.brief}]});
		});
	} finally {
		closing.abort(); job.signal.removeEventListener('abort',stop);
		if (cancel) await Promise.race([cancel,Bun.sleep(150)]);
		try { await child.stdin.end(); } finally { child.kill(undefined,-1); await exited; }
	}
}

export async function runAgyWorker(options: ExecutorOptions): Promise<SingleResult> {
	const authorize = () => {
		const settings = options.settings, grants = options.perCallModelGrants;
		if (!settings || !grants?.assertAuthorization || grants.agentName !== 'agy-acp' ||
			grants.agentSource !== 'bundled' || !grants.standaloneInvocationKind ||
			!perCallModelEnabled(settings, grants.standaloneInvocationKind)) throw new Error('Antigravity worker dispatch is disabled');
		const authority = settings.grantAuthority();
		const assigned = grants.standaloneSelector;
		if (!assigned || !(options.modelOverride === assigned || (Array.isArray(options.modelOverride) &&
			options.modelOverride.length === 1 && options.modelOverride[0] === assigned))) throw new Error('Native ACP worker has no matching per-spawn grant');
		const identity = assigned.slice(0, assigned.lastIndexOf(':'));
		if (!/^agy-acp\/gemini-4-(?:argon|neon|hydrogen)$/.test(identity)) throw new Error('ACP worker model must be Argon, Neon or Hydrogen');
		const effort = assigned.slice(assigned.lastIndexOf(':')+1);
		for (const policy of [authority, settings]) {
			if (cfgTaskDisabledAgents.get(policy).includes('agy-acp') || cfgDisabledProviders.get(policy).some(p =>
				p === 'google-antigravity' || p === 'antigravity-cli')) throw new Error('Antigravity worker dispatch is disabled');
			const index = THINKING_EFFORTS.findIndex(level => level === effort);
			if (index < 0 || index > THINKING_EFFORTS.indexOf(cfgTaskMaxEffort.get(policy))) throw new Error('Unsupported ACP effort or effort above task ceiling');
			const allow = cfgTaskPerCallModelAllow.get(policy);
			if (allow.length && !allow.includes(identity)) throw new Error('ACP selector excluded by task model allowlist');
		}
		grants.assertAuthorization();
	};
	authorize();
	const workspace = options.worktree, brief = options.assignment;
	const model = typeof options.modelOverride === 'string' ? options.modelOverride :
		options.modelOverride?.length === 1 ? options.modelOverride[0] : undefined;
	const match = /^agy-acp\/([a-z0-9._-]+):([a-z]+)$/i.exec(model ?? '');
	if (options.agent.source !== 'bundled' || !workspace || !brief || !match || options.outputSchema ||
		process.platform !== 'win32' || !process.env.LOCALAPPDATA || !isAbsolute(process.env.LOCALAPPDATA)) {
		throw new Error('Native ACP requires its bundled agent, isolated workspace, explicit assignment and exact agy-acp/model:effort selection');
	}
	const started = Date.now(), deadline = AbortSignal.timeout(options.maxRuntimeMs || 900_000);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	const progress: AgentProgress = {index:options.index,id:options.id,agent:options.agent.name,agentSource:options.agent.source,
		task:brief,status:'running',recentOutput:[],recentTools:[],toolCount:0,requests:0,tokens:0,cost:0,durationMs:0};
	const chunks: string[] = [];
	const ui = options.acpUI;
	let size = 0, truncated = false;
	const response = await superviseAcp([join(process.env.LOCALAPPDATA,'agy','bin','agy.exe'),'acp'],
		{cwd:workspace,brief,model:match[1],effort:match[2],mode:'default',signal}, {
		async requestPermission(req, ctx) {
			if (!ui || !req.options.length) return {outcome:{outcome:'cancelled'}};
			const choices = req.options.map(o => `${o.kind}: ${o.name} [${o.optionId}]`);
			const picked = await ui.select(`${req.toolCall.title ?? 'Tool permission'}\n${JSON.stringify(req.toolCall.rawInput ?? {})}`,choices,{signal:ctx?.signal});
			const idx = picked === undefined ? -1 : choices.indexOf(picked);
			return {outcome:idx < 0 ? {outcome:'cancelled'} : {outcome:'selected',optionId:req.options[idx].optionId}};
		},
		async unstable_createElicitation(req) {
			if (!ui || req.mode !== 'form' || !req.requestedSchema) return {action:'decline'};
			const content: Record<string,string|number|boolean> = Object.create(null);
			for (const [key,field] of Object.entries(req.requestedSchema.properties)) {
				const title = `${req.message}\n${field.title ?? key}`;
				const choices = Array.isArray(field.enum) && field.enum.every(v => typeof v === 'string') ? field.enum as string[] : undefined;
				if (!['string','boolean','number','integer'].includes(field.type)) return {action:'decline'};
				const value = field.type === 'boolean' ? await ui.select(title,['false','true'],{signal}) :
					choices ? await ui.select(title,choices,{signal}) : await ui.input(title,field.description,{signal});
				if (value === undefined || signal.aborted) return {action:'cancel'};
				if (field.type === 'number' || field.type === 'integer') {
					const n = Number(value);
					if (!value.trim() || !Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) return {action:'decline'};
					content[key] = n;
				} else content[key] = field.type === 'boolean' ? value === 'true' : value;
			}
			return {action:'accept',content};
		},
		sessionUpdate({update}) {
			if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
				const text = update.content.text, keep = text.slice(0,Math.max(0,500_000-size));
				if (keep) chunks.push(keep); size += keep.length; truncated ||= keep.length < text.length;
				progress.recentOutput = [text.slice(-1000)];
			} else if (update.sessionUpdate === 'tool_call') { progress.currentTool = update.title; progress.toolCount++; }
			progress.durationMs = Date.now()-started; options.onProgress?.(progress);
		},
	},authorize);
	const ok = response.stopReason === 'end_turn';
	return {index:options.index,id:options.id,agent:options.agent.name,agentSource:options.agent.source,task:brief,
		output:chunks.join(''),exitCode:ok ? 0 : 1,stderr:'',truncated,durationMs:Date.now()-started,
		requests:1,tokens:response.usage?.totalTokens ?? 0,resolvedModel:model,acpStopReason:response.stopReason,
		...(ok ? {} : {error:`Antigravity ACP: ${response.stopReason}`,aborted:response.stopReason === 'cancelled'})};
}
