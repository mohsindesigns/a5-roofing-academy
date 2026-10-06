import type { Logger } from 'pino';

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string | undefined;
  logger: Logger;
}

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

/**
 * Starts OpenTelemetry tracing when an OTLP endpoint is configured. Packages are loaded lazily so
 * services without an exporter pay no startup cost. HTTP, PostgreSQL and Redis spans are captured.
 */
export async function startTelemetry(options: TelemetryOptions): Promise<TelemetryHandle> {
  if (!options.otlpEndpoint) return { shutdown: async () => undefined };

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { HttpInstrumentation },
    { PgInstrumentation },
    { IORedisInstrumentation },
    { resourceFromAttributes },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-ioredis'),
    import('@opentelemetry/resources'),
  ]);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.version': options.serviceVersion ?? '0.0.0',
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${options.otlpEndpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => req.url?.startsWith('/health') ?? false,
      }),
      new PgInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });
  sdk.start();
  options.logger.info({ endpoint: options.otlpEndpoint }, 'OpenTelemetry tracing enabled');
  return { shutdown: () => sdk.shutdown() };
}
