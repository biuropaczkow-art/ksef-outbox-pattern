# KSeF Outbox Pattern Implementation

Enterprise-grade **Transactional Outbox Pattern** implementation for reliable invoice processing with KSeF (Polish National e-Invoice System).

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  HTTP Request   │────▶│  Invoice Service │────▶│  PostgreSQL     │
│  (Create Invoice)│     │  (Single TX)     │     │  (invoices +    │
└─────────────────┘     └──────────────────┘     │   outbox_events)│
                                                  └────────┬────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────────┐
                                                  │  Outbox Relay    │
                                                  │  (Background)    │
                                                  └────────┬────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────────┐
                                                  │  RabbitMQ        │
                                                  │  (KSeF Queue)    │
                                                  └────────┬────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────────┐
                                                  │  KSeF Consumer   │
                                                  │  (Send to KSeF)  │
                                                  └──────────────────┘
```

## Core Guarantees

| Property | Implementation |
|----------|----------------|
| **Atomicity** | Invoice + Outbox event in single PostgreSQL transaction |
| **At-Least-Once** | Relay retries with exponential backoff |
| **Exactly-Once** | Redis idempotency keys + KSeF deduplication |
| **Durability** | Events persisted before acknowledgment |
| **Observability** | Full audit trail in `outbox_events` table |

## Database Schema

### `invoices` - Core business entity
```sql
CREATE TABLE invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_number VARCHAR(50) NOT NULL UNIQUE,
    seller_nip VARCHAR(10) NOT NULL,
    buyer_nip VARCHAR(10) NOT NULL,
    -- ... amounts, dates, KSeF fields
    ksef_status VARCHAR(50) DEFAULT 'DRAFT',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1  -- Optimistic locking
);
```

### `outbox_events` - Transactional outbox
```sql
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(100) NOT NULL,           -- INVOICE_CREATED, INVOICE_KSEF_ACCEPTED, etc.
    aggregate_id UUID NOT NULL,                 -- Invoice ID
    aggregate_type VARCHAR(50) NOT NULL,        -- 'INVOICE'
    payload JSONB NOT NULL,                     -- Event data
    metadata JSONB DEFAULT '{}',                -- Correlation IDs, tracing
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, PROCESSING, PROCESSED, FAILED, RETRY
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ
);

-- Critical index for relay performance
CREATE INDEX idx_outbox_status_created ON outbox_events(status, created_at) 
    WHERE status IN ('PENDING', 'RETRY');
```

## Transactional Outbox Pattern

### The Problem: Dual Write
```javascript
// ❌ DANGEROUS - Not atomic!
await db.query('INSERT INTO invoices ...');
await rabbitmq.publish('ksef.queue', invoiceData);  // Can fail after DB commit!
```

### The Solution: Single Transaction
```javascript
// ✅ SAFE - Atomic!
await db.query('BEGIN');
await db.query('INSERT INTO invoices ...');
await db.query(
  `INSERT INTO outbox_events (event_type, aggregate_id, aggregate_type, payload, metadata)
   VALUES ($1, $2, $3, $4, $5)`,
  ['INVOICE_CREATED', invoiceId, 'INVOICE', JSON.stringify(payload), JSON.stringify(meta)]
);
await db.query('COMMIT');
```

**Result**: Either both succeed or both rollback. No invoice exists without its outbox event.

## Outbox Relay Worker

Polls `outbox_events` table and publishes to RabbitMQ with:

- **Concurrency Safety**: `FOR UPDATE SKIP LOCKED` prevents duplicate processing
- **Idempotency**: Redis `SET NX EX` ensures exactly-once publishing
- **Retry Logic**: Exponential backoff (1s, 2s, 4s, 8s, 16s) up to 5 retries
- **Dead Letter**: Events failing all retries marked `FAILED` for manual intervention
- **Monitoring**: `outbox_relay_state` table tracks throughput and health

```typescript
// Relay processes events in batches
const events = await query(
  `SELECT * FROM outbox_events 
   WHERE status IN ('PENDING', 'RETRY')
   ORDER BY created_at ASC
   LIMIT $1
   FOR UPDATE SKIP LOCKED`,  // Critical for multiple relay instances
  [BATCH_SIZE]
);

for (const event of events) {
  // Idempotency check
  const { isDuplicate } = await idempotencyService.checkAndMark(`outbox:${event.id}`, event.id);
  if (isDuplicate) continue;

  await rabbitMQPublisher.publish(routingKey, event.payload);
  await markEventProcessed(event.id);
}
```

## Idempotency Layer (Redis)

```typescript
// Atomic check-and-set using SET NX EX
const result = await redis.set(`idempotency:${key}`, eventId, 'EX', 604800, 'NX');

if (result === 'OK') {
  // First time - process normally
} else {
  // Duplicate - return cached result
  const cached = await redis.get(`idempotency:result:${key}`);
}
```

## Event Types

| Event | Routing Key | Payload |
|-------|-------------|---------|
| `INVOICE_CREATED` | `invoice.created` | Invoice data for KSeF submission |
| `INVOICE_SENT_TO_KSEF` | `invoice.sent` | KSeF number, sent timestamp |
| `INVOICE_KSEF_ACCEPTED` | `invoice.ksef.accepted` | KSeF reference number |
| `INVOICE_KSEF_REJECTED` | `invoice.ksef.rejected` | Error codes from KSeF |

## Quick Start

```bash
# 1. Install dependencies
cd /opt/data/profiles/biuro-admin/outbox-pattern
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your DB, RabbitMQ, Redis credentials

# 3. Run migration (creates tables)
npm run migrate

# 4. Start relay worker (terminal 1)
npm run relay

# 5. Run demo (terminal 2)
npm run dev
```

## Production Checklist

- [ ] PostgreSQL: Enable `wal_level = logical` for replication
- [ ] PostgreSQL: Configure `max_prepared_transactions` for 2PC if needed
- [ ] RabbitMQ: Enable publisher confirms, use quorum queues
- [ ] Redis: Enable persistence (AOF) for idempotency keys
- [ ] Monitoring: Alert on `outbox_events` where `status = 'FAILED'`
- [ ] Monitoring: Alert on relay lag (`NOW() - MAX(created_at) WHERE status = 'PENDING'`)
- [ ] Cleanup: Schedule `cleanup_outbox_events(30)` via pg_cron
- [ ] Scaling: Run multiple relay instances (they coordinate via `FOR UPDATE SKIP LOCKED`)

## Why This Matters for October 1st

When hundreds of B2B clients hit "Generate Recurring Invoices" simultaneously:

1. **HTTP requests** hit your API → each creates invoice + outbox event atomically
2. **Database** absorbs the write burst (single INSERT per request)
3. **Relay workers** drain outbox at controlled pace → RabbitMQ
4. **KSeF consumers** process with exponential backoff → no API throttling
5. **Zero data loss** even if: container OOM, power loss, RabbitMQ restart, network partition

This is the difference between a script that "works on my machine" and a system that survives production.

## Testing the Dual Write Failure

```bash
# Simulate crash between DB commit and RabbitMQ publish
# (The outbox pattern makes this impossible - they're in same TX)

# But you can test relay resilience:
# 1. Start relay
# 2. Kill RabbitMQ container
# 3. Create invoices (they pile up in outbox_events as PENDING)
# 4. Restart RabbitMQ
# 5. Relay automatically catches up - zero data loss
```

## Files Structure

```
src/
├── index.ts                 # Demo entry point
├── relay-worker.ts          # Production relay worker
├── db/
│   ├── pool.ts              # PostgreSQL connection pool + transaction helper
│   └── migrate.ts           # Schema migration
├── types/
│   └── invoice.ts           # TypeScript interfaces
├── services/
│   ├── invoice.service.ts   # Business logic with transactional outbox
│   └── idempotency.service.ts # Redis-based exactly-once
├── messaging/
│   └── rabbitmq.publisher.ts # Publisher with confirms + reconnection
└── relay/
    └── outbox-relay.ts      # Background polling + publishing
```

## Answers to Your Test Questions

### 1. Why `try...catch` doesn't protect against hard crash?

```javascript
// This DOES NOT protect against power loss / OOM kill / SIGKILL
try {
  await db.query('INSERT INTO invoices ...');
  await rabbitmq.publish('ksef.queue', data);  // If process dies HERE...
} catch (e) {
  // ...this catch block NEVER runs
}
```

**Reason**: `try...catch` only catches synchronous/async exceptions within the same process. A hard crash (power loss, OOM killer, `kill -9`, host reboot) terminates the process instantly — no finally blocks, no catch blocks, no cleanup. The database transaction may or may not commit (depends on timing), but the RabbitMQ publish definitely doesn't happen.

**Outbox Solution**: The event is *persisted in the same transaction* as the invoice. Even if power fails after `COMMIT`, the event exists in `outbox_events` and the relay will publish it on restart.

---

### 2. At-Least-Once + Idempotency = Exactly-Once

The outbox guarantees **at-least-once** (relay retries until ack). Combined with the Redis idempotency service:

```
Relay publishes event → RabbitMQ acks → Relay marks PROCESSED
         ↓ (crash before ack)
Relay restarts → Re-publishes same event → Redis detects duplicate (SET NX fails)
         ↓
Returns cached result → No duplicate processing
```

**KSeF Integration**: KSeF itself requires idempotency keys (numer faktury + data wystawienia). Our event payload includes these, so the KSeF consumer can safely retry.

---

### 3. RabbitMQ Down, PostgreSQL Up

```
Time →
[Invoice API] ──POST /invoices──▶ [PostgreSQL] ✅ COMMIT (invoice + outbox event)
                                      │
                                      ▼ (RabbitMQ DOWN)
                              [outbox_events: PENDING]
                                      │
                              [Relay polls, fails, retries with backoff]
                                      │
                              [RabbitMQ RECOVERS]
                                      ▼
                              [Relay publishes] ✅
                              [outbox_events: PROCESSED]
```

**Result**: Invoices are never lost. They queue safely in PostgreSQL (which has 99.99%+ uptime) until RabbitMQ recovers. The relay's exponential backoff prevents thundering herd on recovery.