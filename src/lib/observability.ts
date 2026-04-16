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
import { setLangfuseTracerProvider, startObservation, startActiveObservation } from '@langfuse/tracing';
import { propagateAttributes } from '@langfuse/core';
import { trace as otelTrace, type Span as OTelSpan } from '@opentelemetry/api';

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

  // Register the provider globally AND install an async context manager so
  // propagateAttributes() can pass sessionId/tags through to child spans
  // across `await` boundaries. Without this, propagated attributes never
  // reach the root trace record in Langfuse.
  provider.register();
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

  const observation = startObservation(name, {
    input: options?.input,
    metadata: { ...options?.metadata, tags: options?.tags },
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
 * Uses the OTel tracer so spans automatically nest under the active context
 * set by startActiveObservation in runSearchTrace. Langfuse's startObservation
 * does NOT read OTel context, so using it here would create orphaned traces.
 *
 * Returns a handle with update() and end() methods.
 * When observability is disabled, returns a no-op handle.
 */
export function startSpan(
  name: string,
  options?: { input?: Record<string, unknown>; metadata?: Record<string, unknown> },
): IObservationHandle {
  if (!enabled) return NOOP_HANDLE;

  const tracer = otelTrace.getTracer('langfuse-sdk');
  const span: OTelSpan = tracer.startSpan(name);

  if (options?.input) {
    span.setAttribute('langfuse.span.input', JSON.stringify(options.input));
  }
  if (options?.metadata) {
    span.setAttribute('langfuse.span.metadata', JSON.stringify(options.metadata));
  }

  return {
    update: (data: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(data)) {
        span.setAttribute(
          `langfuse.span.${key}`,
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      }
    },
    end: () => span.end(),
  };
}

// =============================================================================
// Search-specific helpers (Phase 2)
// =============================================================================

export type SearchMode = 'vector' | 'keyword' | 'hybrid' | 'hybrid+rerank';

export interface IStartSearchTraceProps {
  mode: SearchMode;
  query: string;
  environment?: string;
  sessionId?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Open a root trace for a search operation.
 *
 * Attaches environment (prod/eval/dev), sessionId, tags, input, metadata so
 * the Langfuse dashboard can slice traces by any of those dimensions.
 *
 * Returns a handle with update() and end() methods. The caller is expected to
 * call .update({ output: {...} }) before .end() to record resultCount, cacheHit,
 * topResultIds, etc. No-op when observability is disabled.
 */
/**
 * Run a search operation inside an open Langfuse trace.
 *
 * Wraps `work` in a `propagateAttributes` context so sessionId, tags, and
 * environment are attached to the root trace as first-class indexed fields
 * (not metadata). All spans created inside `work` inherit that context.
 *
 * Langfuse's SDK only exposes this via a callback pattern — there is no
 * imperative "open context, return handle, close later" API. Hence the HOF.
 *
 * When observability is disabled, `work` runs with a no-op handle and no
 * tracing overhead.
 */
export async function runSearchTrace<T>(
  props: IStartSearchTraceProps,
  work: (trace: IObservationHandle) => Promise<T>,
): Promise<T> {
  if (!enabled) return work(NOOP_HANDLE);

  return propagateAttributes(
    {
      sessionId: props.sessionId,
      tags: ['search', props.mode],
    },
    async (): Promise<T> => {
      // startActiveObservation (not startObservation) makes this the ACTIVE
      // OpenTelemetry span, so any spans created inside `work` nest under it
      // instead of being emitted as orphan top-level traces.
      return startActiveObservation('search', async (observation): Promise<T> => {
        // sessionId and tags are accepted at runtime but not in LangfuseSpanAttributes.
        // propagateAttributes sets them in OTel context (metadata), but observation.update
        // is needed to promote them to first-class indexed fields on the trace record.
        observation.update({
          input: props.input ?? { query: props.query },
          metadata: props.metadata,
          environment: props.environment,
          ...({ sessionId: props.sessionId, tags: ['search', props.mode] } as Record<string, unknown>),
        });
        const handle: IObservationHandle = {
          update: (data: Record<string, unknown>) => observation.update(data),
          end: () => observation.end(),
        };
        return work(handle);
      });
    },
  );
}

/**
 * Emit a completed span with pre-computed duration.
 *
 * Used for sub-steps whose timing was measured elsewhere (e.g., the three
 * retrieve.* sub-spans derived from the Postgres timing sidecar). Unlike
 * startSpan, this does not return a handle. The span opens and closes
 * immediately, carrying the measured duration as attributes.
 *
 * Uses OTel tracer so spans nest under the active context (same reason as
 * startSpan). The startTime parameter backdates the span to align with the
 * measured window.
 *
 * No-op when observability is disabled.
 */
export function recordChildSpan(
  name: string,
  startMs: number,
  endMs: number,
  attributes?: Record<string, unknown>,
): void {
  if (!enabled) return;

  const tracer = otelTrace.getTracer('langfuse-sdk');
  const span: OTelSpan = tracer.startSpan(name, { startTime: startMs });

  span.setAttribute('langfuse.span.metadata', JSON.stringify({
    ...attributes,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    synthetic: true,
  }));

  span.end(endMs);
}
