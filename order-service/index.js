const express = require('express');
const http = require('http');
const winston = require('winston');
const { logs } = require('@opentelemetry/api-logs');
const { LoggerProvider, SimpleLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { OpenTelemetryTransportV3 } = require('@opentelemetry/winston-transport');
const { trace, metrics, SpanStatusCode } = require('@opentelemetry/api');

// Explicitly wire OTLP HTTP Log Exporter so logs flush immediately to Collector
const loggerProvider = new LoggerProvider({
  resource: new Resource({ 'service.name': process.env.OTEL_SERVICE_NAME || 'order-service' }),
});
loggerProvider.addLogRecordProcessor(
  new SimpleLogRecordProcessor(
    new OTLPLogExporter({ url: 'http://otel-collector:4318/v1/logs' })
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

const tracer = trace.getTracer('order-service-tracer', '1.0.0');
const meter = metrics.getMeter('order-service-meter', '1.0.0');

const ordersCounter = meter.createCounter('orders_processed_total', {
  description: 'Total number of checkout orders processed',
});

const PAYMENT_HOST = process.env.PAYMENT_HOST || 'payment-service';
const PAYMENT_PORT = process.env.PAYMENT_PORT || 8001;

function callPaymentService(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: PAYMENT_HOST,
        port: PAYMENT_PORT,
        path: '/charge',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(body || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

app.post('/checkout', async (req, res) => {
  const orderId = `ORD-${Math.floor(Math.random() * 10000)}`;
  const amount = req.body.amount || 99.99;
  const userTier = req.body.userTier || 'gold';
  const creditCard = req.body.creditCard || '4111-2222-3333-4444';

  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    activeSpan.setAttributes({
      'app.order.id': orderId,
      'app.order.value': amount,
      'app.user.tier': userTier,
      'app.payment.card_number': creditCard,
    });
  }

  logger.info(`Starting checkout for order ${orderId}`, { orderId, amount, userTier });

  await tracer.startActiveSpan('validate-fraud-check', async (fraudSpan) => {
    fraudSpan.setAttribute('app.fraud.score', 12);
    await new Promise((r) => setTimeout(r, 50));
    logger.info(`Fraud validation passed for ${orderId}`, { orderId, fraudScore: 12 });
    fraudSpan.addEvent('Fraud check passed');
    fraudSpan.end();
  });

  try {
    const paymentResult = await callPaymentService({ orderId, amount, userTier });

    if (paymentResult.statusCode >= 400) {
      if (activeSpan) {
        activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'Downstream payment failed' });
      }
      logger.error(`Checkout failed downstream for ${orderId}`, { orderId, userTier, statusCode: paymentResult.statusCode });
      ordersCounter.add(1, { status: 'failed', user_tier: userTier });
      return res.status(502).json({ error: 'Payment failed downstream', orderId, details: paymentResult.body });
    }

    logger.info(`Order ${orderId} confirmed successfully`, { orderId, transactionId: paymentResult.body.transactionId });
    ordersCounter.add(1, { status: 'success', user_tier: userTier });
    res.json({ status: 'Order Confirmed', orderId, payment: paymentResult.body });
  } catch (err) {
    if (activeSpan) {
      activeSpan.recordException(err);
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    }
    logger.error(`Unhandled exception in checkout for ${orderId}: ${err.message}`, { orderId });
    ordersCounter.add(1, { status: 'error', user_tier: userTier });
    res.status(500).json({ error: err.message });
  }
});

app.listen(8000, () => console.log('order-service listening on port 8000'));