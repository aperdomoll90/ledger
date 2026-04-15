// observability.ts
// Langfuse tracing integration for pipeline observability.
//
// Provides trace/span helpers for instrumenting Ledger's ingestion pipeline.
// When Langfuse env vars are absent, all functions no-op silently.
// Ledger works identically with or without observability enabled.
//
// Built on OpenTelemetry (OTel), the industry-standard tracing protocol.
// Langfuse acts as the trace collector and dashboard. The OTel foundation
// means switching to Datadog, Grafana Tempo, or Jaeger requires swapping
// the exporter, not the instrumentation.

import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation, propagateAttributes } from '@langfuse/tracing';

// =============================================================================
// State
// =============================================================================

let provider: NodeTracerProvider | null = null;
let enabled = false;

// =============================================================================
// No-op objects (returned when observability is disabled)
// =============================================================================

export interface IObservationHandle {
  update: (data: Record<string, unknown>) => void;
  end: () => void;
}

const NOOP_HANDLE: IObservationHandle = {
  update: () => {},
  end: () => {},
};

// =============================================================================
// Init / Shutdown
// =============================================================================

/**
 * Initialize Langfuse observability.
 * Returns true if enabled, false if skipped (missing env vars).
 *
 * Call once at CLI startup. Safe to call multiple times (idempotent).
 */
export function initObservability(): boolean {
  if (enabled) return true;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;

  if (!publicKey || !secretKey) return false;

  provider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        publicKey,
        secretKey,
        baseUrl: baseUrl ?? 'http://localhost:9100',
        environment: process.env.NODE_ENV ?? 'development',
        exportMode: 'batched',
        flushAt: 10,
        flushInterval: 2,
      }),
    ],
  });

  setLangfuseTracerProvider(provider);
  enabled = true;
  return true;
}

/**
 * Flush pending traces and shut down the provider.
 * Call before process exit to ensure all traces are sent.
 */
export async function shutdownObservability(): Promise<void> {
  if (!provider) return;
  await provider.forceFlush();
  await provider.shutdown();
  provider = null;
  enabled = false;
}

/**
 * Check if observability is currently enabled.
 */
export function isObservabilityEnabled(): boolean {
  return enabled;
}

// =============================================================================
// Trace / Span helpers
// =============================================================================

/**
 * Start a new trace (root-level observation).
 * Use for top-level operations like document ingestion.
 *
 * Returns a handle with update() and end() methods.
 * When observability is disabled, returns a no-op handle.
 */
export function startTrace(
  name: string,
  options?: { tags?: string[]; metadata?: Record<string, unknown>; input?: Record<string, unknown> },
): IObservationHandle {
  if (!enabled) return NOOP_HANDLE;

  if (options?.tags || options?.metadata) {
    propagateAttributes({
      tags: options.tags,
      metadata: options.metadata,
    });
  }

  const observation = startObservation(name, {
    input: options?.input,
    metadata: options?.metadata,
  });

  return {
    update: (data: Record<string, unknown>) => observation.update(data),
    end: () => observation.end(),
  };
}

/**
 * Start a span (child observation within a trace).
 * Use for pipeline steps like chunking, enrichment, embedding, DB write.
 *
 * Returns a handle with update() and end() methods.
 * When observability is disabled, returns a no-op handle.
 */
export function startSpan(
  name: string,
  options?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> },
): IObservationHandle {
  if (!enabled) return NOOP_HANDLE;

  const observation = startObservation(name, {
    input: options?.input,
    metadata: options?.metadata,
  });

  return {
    update: (data: Record<string, unknown>) => observation.update(data),
    end: () => observation.end(),
  };
}
