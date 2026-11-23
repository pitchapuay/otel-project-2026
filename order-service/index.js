const express = require('express');
const http = require('http');
const https = require('https');
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
const serviceName = process.env.OTEL_SERVICE_NAME || 'order-service';
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

const tracer = trace.getTracer('order-service-tracer', '1.0.0');

// Bind directly to our explicit meterProvider to avoid auto-register conflicts
const meter = meterProvider.getMeter('order-service-meter', '1.0.0');
const ordersCounter = meter.createCounter('orders_processed_total', {
  description: 'Total number of checkout orders processed',
});

const PAYMENT_HOST = process.env.PAYMENT_HOST || 'payment-service';
const PAYMENT_PORT = process.env.PAYMENT_PORT || 8001;
const PAYMENT_URL = process.env.PAYMENT_URL || `http://${PAYMENT_HOST}:${PAYMENT_PORT}/charge`;

function callPaymentService(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL(PAYMENT_URL);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request(
      url,
      {
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

// Lightweight Browser Demo UI (GET /)
const DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenTelemetry Live Demo — Order & Payment Lab</title>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { margin: 0; padding: 32px 16px; background: #0f172a; color: #e2e8f0; }
    .container { max-width: 820px; margin: 0 auto; }
    h1 { margin: 0 0 6px; font-size: 1.6rem; color: #f8fafc; }
    .subtitle { margin: 0 0 24px; color: #94a3b8; font-size: 0.95rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
    .controls { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; color: #cbd5e1; flex: 1; min-width: 140px; }
    input, select { padding: 9px 12px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #f8fafc; font-size: 0.95rem; }
    .buttons { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    button { padding: 11px 14px; border: none; border-radius: 6px; font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: opacity 0.15s; }
    button:hover { opacity: 0.9; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-ok { background: #10b981; color: #052e16; }
    .btn-slow { background: #f59e0b; color: #451a03; }
    .btn-err { background: #ef4444; color: #fff; }
    .btn-bulk { background: #3b82f6; color: #fff; }
    .log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .log-header h2 { margin: 0; font-size: 1rem; }
    .btn-clear { background: #334155; color: #cbd5e1; padding: 6px 12px; font-size: 0.8rem; }
    #results { display: flex; flex-direction: column; gap: 8px; max-height: 420px; overflow-y: auto; }
    .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px; border-radius: 6px; background: #0f172a; border-left: 4px solid #64748b; font-size: 0.88rem; }
    .row.ok { border-left-color: #10b981; }
    .row.slow { border-left-color: #f59e0b; }
    .row.err { border-left-color: #ef4444; }
    .badge { padding: 2px 7px; border-radius: 4px; font-weight: 700; font-size: 0.78rem; }
    .ok .badge { background: #064e3b; color: #6ee7b7; }
    .slow .badge { background: #78350f; color: #fde68a; }
    .err .badge { background: #7f1d1d; color: #fca5a5; }
    .trace { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; color: #93c5fd; cursor: pointer; background: #1e293b; padding: 3px 7px; border-radius: 4px; border: 1px solid #334155; }
    .trace:hover { background: #334155; }
    .empty { color: #64748b; font-size: 0.9rem; text-align: center; padding: 24px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>OpenTelemetry Microservices Demo</h1>
    <p class="subtitle">Trigger live distributed traces, custom Prometheus metrics, and correlated Loki logs across <code>order-service</code> &rarr; <code>payment-service</code>.</p>

    <div class="card">
      <div class="controls">
        <label>Order Amount ($)
          <input id="amount" type="number" value="149.99" step="0.01" min="1" />
        </label>
        <label>Customer Tier
          <select id="userTier">
            <option value="gold">gold</option>
            <option value="silver">silver</option>
            <option value="platinum" selected>platinum</option>
          </select>
        </label>
      </div>
      <div class="buttons">
        <button class="btn-ok" onclick="sendOrder('normal')">Normal Order (200 OK)</button>
        <button class="btn-slow" onclick="sendOrder('slow')">Slow Order (+2s Latency)</button>
        <button class="btn-err" onclick="sendOrder('error')">Force Error (502 Fail)</button>
        <button class="btn-bulk" id="bulkBtn" onclick="sendBulk()">Bulk Mixed Traffic (10x)</button>
      </div>
    </div>

    <div class="card">
      <div class="log-header">
        <h2>Live Request Results (click any Trace ID to copy)</h2>
        <button class="btn-clear" onclick="clearLogs()">Clear</button>
      </div>
      <div id="results"><div class="empty">Click a button above to generate telemetry...</div></div>
    </div>
  </div>

  <script>
    const resultsEl = document.getElementById('results');

    function clearLogs() {
      resultsEl.innerHTML = '<div class="empty">Click a button above to generate telemetry...</div>';
    }

    function copyTrace(el, traceId) {
      navigator.clipboard.writeText(traceId);
      const orig = el.textContent;
      el.textContent = 'Copied!';
      setTimeout(() => (el.textContent = orig), 1000);
    }

    async function sendOrder(simulate, customAmt, customTier) {
      if (resultsEl.querySelector('.empty')) resultsEl.innerHTML = '';

      const amount = customAmt ?? parseFloat(document.getElementById('amount').value || 99.99);
      const userTier = customTier ?? document.getElementById('userTier').value;
      const start = performance.now();

      try {
        const res = await fetch('/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, userTier, simulate, creditCard: '4532-9999-8888-7777' })
        });
        const data = await res.json();
        const ms = Math.round(performance.now() - start);
        const cls = !res.ok ? 'err' : (ms >= 1500 ? 'slow' : 'ok');
        const label = !res.ok ? res.status + ' FAIL' : (ms >= 1500 ? '200 SLOW' : '200 OK');

        const row = document.createElement('div');
        row.className = 'row ' + cls;
        row.innerHTML =
          '<div><span class="badge">' + label + '</span> ' +
          '<strong>' + (data.orderId || 'N/A') + '</strong> &middot; ' +
          userTier + ' &middot; $' + amount.toFixed(2) + ' &middot; <strong>' + ms + 'ms</strong></div>' +
          (data.traceId
            ? '<span class="trace" title="Click to copy Trace ID for Grafana Tempo" onclick="copyTrace(this, \\'' + data.traceId + '\\')">trace: ' + data.traceId + '</span>'
            : '');
        resultsEl.prepend(row);
      } catch (err) {
        const row = document.createElement('div');
        row.className = 'row err';
        row.textContent = 'Network Error: ' + err.message;
        resultsEl.prepend(row);
      }
    }

    async function sendBulk() {
      const btn = document.getElementById('bulkBtn');
      btn.disabled = true;
      btn.textContent = 'Sending 10 requests...';
      const tiers = ['gold', 'silver', 'platinum'];
      for (let i = 1; i <= 10; i++) {
        await sendOrder('random', i * 25.5, tiers[i % 3]);
      }
      btn.disabled = false;
      btn.textContent = 'Bulk Mixed Traffic (10x)';
    }
  </script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.type('html').send(DEMO_HTML);
});

app.post('/checkout', async (req, res) => {
  const orderId = `ORD-${Math.floor(Math.random() * 10000)}`;
  const amount = req.body.amount || 99.99;
  const userTier = req.body.userTier || 'gold';
  const simulate = req.body.simulate || 'random';
  const creditCard = req.body.creditCard || '4111-2222-3333-4444';

  const activeSpan = trace.getActiveSpan();
  const traceId = activeSpan ? activeSpan.spanContext().traceId : null;

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
    const paymentResult = await callPaymentService({ orderId, amount, userTier, simulate });

    if (paymentResult.statusCode >= 400) {
      if (activeSpan) {
        activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'Downstream payment failed' });
      }
      logger.error(`Checkout failed downstream for ${orderId}`, { orderId, userTier, statusCode: paymentResult.statusCode });
      ordersCounter.add(1, { status: 'failed', user_tier: userTier });
      return res.status(502).json({ error: 'Payment failed downstream', orderId, traceId, details: paymentResult.body });
    }

    logger.info(`Order ${orderId} confirmed successfully`, { orderId, transactionId: paymentResult.body.transactionId });
    ordersCounter.add(1, { status: 'success', user_tier: userTier });
    res.json({ status: 'Order Confirmed', orderId, traceId, payment: paymentResult.body });
  } catch (err) {
    if (activeSpan) {
      activeSpan.recordException(err);
      activeSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    }
    logger.error(`Unhandled exception in checkout for ${orderId}: ${err.message}`, { orderId });
    ordersCounter.add(1, { status: 'error', user_tier: userTier });
    res.status(500).json({ error: err.message, orderId, traceId });
  }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`order-service listening on port ${PORT}`));