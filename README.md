# OpenTelemetry Microservices Learning Lab 🚀

A fully containerized, zero-cost production-grade observability lab designed to master **OpenTelemetry (OTel)** instrumentation, pipeline manipulation, log correlation, PII scrubbing, and multi-backend telemetry fan-out.

---

## 🏗️ Architecture & Data Flow

This project simulates a real-world microservice e-commerce workflow (`order-service` $\rightarrow$ `payment-service`) that generates distributed traces, custom metrics, and correlated structured logs, routes them through a central **OpenTelemetry Collector**, and fans them out to local and cloud backends simultaneously.

```text
[order-service (Port 8000)] ──┐
                              ├──(OTLP HTTP :4318)──> [OTel Collector] ──(Scrub PII & Batch)──┬──> [Local Grafana LGTM Stack] (Tempo/Loki/Mimir)
[payment-service (Port 8001)] ┘                                                                ├──> [Honeycomb Cloud] (api.honeycomb.io)
                                                                                               └──> [Grafana Cloud OTLP Gateway]
```

---

## 🛠️ Tech Stack & Observability Tools

* **Core Runtime:** Node.js 20 (Alpine containers via Docker)
* **Framework:** Express.js & HTTP modules
* **Instrumentation:** `@opentelemetry/api`, `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`
* **Logging:** Winston + `@opentelemetry/winston-transport`
* **Pipeline & Routing:** OpenTelemetry Collector Contrib (`otel/opentelemetry-collector-contrib`)
* **Local Backends:** Grafana LGTM (`grafana/otel-lgtm` package featuring Tempo, Prometheus/Mimir, and Loki)
* **Cloud Backends (Free Tiers):** Honeycomb (Trace exploration & BubbleUp root-cause analysis) & Grafana Cloud (Unified metrics, logs, and traces)

---

## 📂 Project Directory Structure

```text
otel-lab/
├── .gitignore
├── .env.example
├── docker-compose.yml
├── otel-collector-config.yaml
├── order-service/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js
└── payment-service/
    ├── Dockerfile
    ├── package.json
    └── index.js
```

---

## 🚀 Getting Started & Running Locally

### Prerequisites
* **Docker Desktop** installed and running on Windows 11 (WSL 2 enabled).
* PowerShell or Windows Terminal.

### Step 1: Clone or Open the Repository
```powershell
cd C:\otel-lab
```

### Step 2: Configure Environment Variables (Optional for Cloud Fan-Out)
If you want to fan out telemetry to Honeycomb or Grafana Cloud, create a `.env` file in the root directory:
```env
HONEYCOMB_API_KEY=your_honeycomb_api_key_here
GRAFANA_CLOUD_OTLP_ENDPOINT=https://otlp-gateway-prod-us-east-0.grafana.net/otlp
GRAFANA_CLOUD_BASIC_AUTH=your_base64_auth_string_here
```
*(If no `.env` file is present, the stack will run 100% locally using the Docker containers without error).*

### Step 3: Build and Start the Docker Containers
```powershell
docker compose up -d --build
```
*(Wait ~30 seconds for all containers and the Grafana LGTM stack to initialize).*

### Step 4: Generate Test Traffic (Success, Latency Spikes, and Errors)
Run this PowerShell traffic loop to fire 15 checkout requests with different user tiers and amounts (note that payment-service simulates a 20% latency delay and a 10% payment gateway timeout error):
```powershell
$tiers = @("gold", "silver", "platinum")
1..15 | ForEach-Object {
  $tier = $tiers[$_ % 3]
  $amt = $_ * 25.5
  $payload = @{
    amount = $amt
    userTier = $tier
    creditCard = "4532-9999-8888-7777"
  } | ConvertTo-Json -Compress

  try {
    $res = Invoke-RestMethod -Method Post -Uri "http://localhost:8000/checkout" -ContentType "application/json" -Body $payload
    Write-Host "[$_] Success ($tier - `$$amt): Order $($res.orderId)" -ForegroundColor Green
  } catch {
    Write-Host "[$_] Simulated failure caught for tier $tier (`$$amt)" -ForegroundColor Red
  }
}
```

---

## 🌟 Key Engineering Features Implemented

1. **Auto & Manual Instrumentation:** Zero-code Express and HTTP tracing combined with manual spans (`validate-fraud-check`), custom attributes (`app.user.tier`, `app.order.value`), and exception recording (`span.record_exception()`).
2. **Distributed Context Propagation:** W3C `traceparent` headers automatically propagated across HTTP requests between `order-service` and `payment-service` to maintain a single unified `traceId`.
3. **Custom Metrics:** 
   * **Counter (`orders_processed_total`):** Tracks order volume segmented by status and user tier.
   * **Histogram (`payment_duration_ms`):** Measures payment gateway latency distributions.
4. **Log Correlation:** Winston structured logging integrated with OpenTelemetry's SDK Logs (`LoggerProvider` & `OpenTelemetryTransportV3`), automatically injecting `trace_id` and `span_id` into every log record for seamless trace-to-log jumping in Grafana Loki.
5. **Collector PII Scrubbing:** Centralized `attributes/scrub_pii` processor in the OpenTelemetry Collector intercepting spans and masking sensitive credit card numbers (`app.payment.card_number` $\rightarrow$ `[REDACTED-BY-COLLECTOR]`) before data ever leaves the local network.
6. **Multi-Backend Fan-Out:** Parallel telemetry routing from a single collector pipeline to local Grafana Tempo/Loki/Prometheus, Honeycomb, and Grafana Cloud simultaneously.

---

## 📊 Viewing Your Observability Data

* **Local Grafana UI:** Navigate to `http://localhost:3000` (User: `admin`, Pass: `admin`):
  * **Explore $\rightarrow$ Tempo:** Inspect waterfall traces, custom span attributes, and exception stack traces.
  * **Explore $\rightarrow$ Loki:** Query correlated application logs and click the **Tempo** button to jump straight from a log line to its trace.
  * **Explore $\rightarrow$ Prometheus / Mimir:** Query custom counters and histogram quantiles (`histogram_quantile(...)`).