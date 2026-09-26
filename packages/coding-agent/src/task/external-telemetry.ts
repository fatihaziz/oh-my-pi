import { createHash } from "node:crypto";
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type Attributes, type Context, context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import {
	createTelemetryExportConfig,
	initTelemetryExport,
	isTelemetryExportEnabled,
	TELEMETRY_EXPORT_HOOKS,
	telemetryExportBase,
} from "../telemetry-export";

/** Parent telemetry a native worker process rebuilds; every field is plain data. */
export interface WorkerTelemetry {
	/** SHA-256 over the parent's `OTEL_*` environment; the worker must export to the same configuration. */
	environment: string;
	tracerName?: string;
	captureMessageContent?: boolean | "none" | "summary" | "full";
	attributes?: Attributes;
	agent?: { id?: string; name?: string; description?: string };
	conversationId?: string;
	/** W3C trace context of the parent's active span, so worker spans nest exactly as in-process ones do. */
	trace: Record<string, string>;
}

const TRANSFERABLE: Record<string, true> = {
	tracerName: true,
	captureMessageContent: true,
	attributes: true,
	agent: true,
	conversationId: true,
};

function otelEnvironment(): string {
	const entries = Object.entries(process.env)
		.filter(([key, value]) => key.startsWith("OTEL_") && value !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function rejectUntransferable(config: AgentTelemetryConfig, allowed: readonly string[]): void {
	for (const [key, value] of Object.entries(config)) {
		if (value === undefined || TRANSFERABLE[key] || allowed.includes(key)) continue;
		throw new Error(
			`Telemetry option "${key}" cannot cross the worker process boundary; refusing to launch with reduced native telemetry`,
		);
	}
}

/**
 * Describe the parent's telemetry for a worker process. Only OMP's OTLP export
 * config crosses: the worker re-registers the same exporters from the same
 * environment. Embedder tracers and hooks are closures and are refused.
 */
export function exportWorkerTelemetry(config: AgentTelemetryConfig): WorkerTelemetry {
	const base = telemetryExportBase(config);
	if (!base || !isTelemetryExportEnabled()) {
		throw new Error(
			"Only OMP's OTLP telemetry can cross the worker process boundary; refusing to launch with reduced native telemetry",
		);
	}
	rejectUntransferable(base, []);
	rejectUntransferable(config, TELEMETRY_EXPORT_HOOKS);
	const trace: Record<string, string> = {};
	propagation.inject(context.active(), trace);
	return {
		environment: otelEnvironment(),
		tracerName: config.tracerName,
		captureMessageContent: config.captureMessageContent,
		attributes: config.attributes ? { ...config.attributes } : undefined,
		agent: config.agent ? { ...config.agent } : undefined,
		conversationId: config.conversationId,
		trace,
	};
}

/** Parent telemetry rebuilt inside a worker, with the parent's active trace context. */
export interface ImportedWorkerTelemetry {
	config: AgentTelemetryConfig;
	context: Context;
}

/** Rebuild the parent's telemetry inside a worker; rejects when this process would export elsewhere. */
export async function importWorkerTelemetry(telemetry: WorkerTelemetry): Promise<ImportedWorkerTelemetry> {
	if (otelEnvironment() !== telemetry.environment) {
		throw new Error(
			"Worker OpenTelemetry environment differs from the parent; refusing to launch with divergent telemetry",
		);
	}
	await initTelemetryExport();
	const config = isTelemetryExportEnabled()
		? createTelemetryExportConfig({
				tracerName: telemetry.tracerName,
				captureMessageContent: telemetry.captureMessageContent,
				attributes: telemetry.attributes,
				agent: telemetry.agent,
				conversationId: telemetry.conversationId,
			})
		: undefined;
	if (!config) {
		throw new Error(
			"Worker could not register the parent's OTLP exporters; refusing to launch without native telemetry",
		);
	}
	return { config, context: propagation.extract(ROOT_CONTEXT, telemetry.trace) };
}
