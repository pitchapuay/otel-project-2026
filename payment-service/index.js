const express = require('express');
const winston = require('winston');
const { logs } = require('@opentelemetry/api-logs');
const { LoggerProvider, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { OpenTelemetryTransportV3 } = require('@opentelemetry/winston-transport');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');

const loggerProvider = new LoggerProvider({
  resource: new Resource({ 'service.name': process.env.OTEL_SERVICE_NAME || 'payment-service' }),
});
const otlpBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://otel-collector:4318';
const authHeader = process.env.GRAFANA_CLOUD_BASIC_AUTH
  ? { Authorization: `Basic ${process.env.GRAFANA_CLOUD_BASIC_AUTH}` }
  : {};
loggerProvider.addLogRecordProcessor(
  new SimpleLogRecordProcessor(
    new OTLPLogExporter({ url: `${otlpBase}/v1/logs`, headers: authHeader })
  )
);
logs.setGlobalLoggerProvider(loggerProvider);

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

const meter = metrics.getMeter('payment-service-meter', '1.0.0');
const paymentDurationHistogram = meter.createHistogram('payment_duration_ms', {
  description: 'Duration of payment gateway processing in milliseconds',
  unit: 'ms',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.post('/charge', async (req, res) => {
  const startTime = Date.now();
  const { orderId, amount, userTier } = req.body;
  const roll = Math.random();
  const activeSpan = trace.getActiveSpan();

  if (activeSpan) {
    activeSpan.setAttributes({
      'app.order.id': orderId,
      'app.payment.amount': amount,
    });
  }

  logger.info(`Processing payment charge for ${orderId}`, { orderId, amount, userTier });

  if (roll < 0.2) {
    logger.warn(`Payment gateway latency spike (2000ms) for ${orderId}`, { orderId });
    if (activeSpan) activeSpan.addEvent('Payment gateway throttling detected - waiting 2000ms');
    await sleep(2000);
  }

  if (roll >= 0.2 && roll < 0.3) {
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
app.listen(PORT, () => console.log(`Payment-service listening on port ${PORT}`));