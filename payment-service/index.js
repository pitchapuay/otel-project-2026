const express = require('express');
const winston = require('winston');
const { logs } = require('@opentelemetry/api-logs');
const { LoggerProvider, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { OpenTelemetryTransportV3 } = require('@opentelemetry/winston-transport');
const { trace, SpanStatusCode } = require('@opentelemetry/api');

// Shared OTLP configuration (works with local Collector AND Grafana Cloud)
const serviceName = process.env.OTEL_SERVICE_NAME || 'payment-service';
const resource = new Resource({ 'service.name': serviceName });
const otlpBase = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318').replace(/\/$/, '');
const authHeader = process.env.GRAFANA_CLOUD_BASIC_AUTH
  ? { Authorization: `Basic ${process.env.GRAFANA_CLOUD_BASIC_AUTH}` }
  : {};

// Explicit LoggerProvider
const loggerProvider = new LoggerProvider({ resource });
loggerProvider.addLogRecordProcessor(
  new SimpleLogRecordProcessor(
    new OTLPLogExporter({ url: `${otlpBase}/v1/logs`, headers: authHeader })
  )
);
logs.setGlobalLoggerProvider(loggerProvider);

// Explicit MeterProvider (flushes every 5s directly to /v1/metrics)
const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${otlpBase}/v1/metrics`, headers: authHeader }),
      exportIntervalMillis: 5000,
    }),
  ],
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new OpenTelemetryTransportV3(),
  ],
});

const app = express();
app.use(express.json());

// Bind directly to our explicit meterProvider to avoid auto-register conflicts
const meter = meterProvider.getMeter('payment-service-meter', '1.0.0');
const paymentDurationHistogram = meter.createHistogram('payment_duration_ms', {
  description: 'Duration of payment gateway processing in milliseconds',
  unit: 'ms',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/charge', async (req, res) => {
  const startTime = Date.now();
  const { orderId, amount, userTier, simulate = 'random' } = req.body;
  const roll = Math.random();
  const activeSpan = trace.getActiveSpan();

  if (activeSpan) {
    activeSpan.setAttributes({
      'app.order.id': orderId,
      'app.payment.amount': amount,
      'app.demo.mode': simulate,
    });
  }

  logger.info(`Processing payment charge for ${orderId}`, { orderId, amount, userTier, simulate });

  const shouldDelay = simulate === 'slow' || (simulate === 'random' && roll < 0.2);
  const shouldFail = simulate === 'error' || (simulate === 'random' && roll >= 0.2 && roll < 0.3);

  if (shouldDelay) {
    logger.warn(`Payment gateway latency spike (2000ms) for ${orderId}`, { orderId });
    if (activeSpan) activeSpan.addEvent('Payment gateway throttling detected - waiting 2000ms');
    await sleep(2000);
  }

  if (shouldFail) {
    const error = new Error(`Payment gateway timeout while charging $${amount} for ${orderId}`);
    logger.error(`Payment declined: ${error.message}`, { orderId, amount, userTier });

    if (activeSpan) {
      activeSpan.recordException(error);
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }

    const duration = Date.now() - startTime;
    paymentDurationHistogram.record(duration, { status: 'failed', user_tier: userTier || 'unknown' });
    return res.status(500).json({ status: 'declined', reason: error.message });
  }

  const duration = Date.now() - startTime;
  paymentDurationHistogram.record(duration, { status: 'success', user_tier: userTier || 'unknown' });
  logger.info(`Payment charged successfully for ${orderId}`, { orderId, durationMs: duration });

  res.json({ status: 'charged', transactionId: `TXN-${Date.now()}`, orderId, amount });
});

const PORT = process.env.PORT || 8001;
app.listen(PORT, () => console.log(`payment-service listening on port ${PORT}`));