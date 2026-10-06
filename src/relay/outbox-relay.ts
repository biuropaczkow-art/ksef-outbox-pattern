import { query, transaction, OutboxEventRow } from '../db/pool';
import { rabbitMQPublisher } from '../messaging/rabbitmq.publisher';
import { idempotencyService } from '../services/idempotency.service';
import dotenv from 'dotenv';

dotenv.config();

const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '5000');
const BATCH_SIZE = parseInt(process.env.OUTBOX_BATCH_SIZE || '100');
const MAX_RETRIES = parseInt(process.env.OUTBOX_MAX_RETRIES || '5');
const BASE_DELAY_MS = parseInt(process.env.OUTBOX_RETRY_BASE_DELAY_MS || '1000');

interface RelayStats {
  eventsProcessed: number;
  eventsFailed: number;
  lastRun: Date | null;
  lastError: string | null;
  isRunning: boolean;
}

export class OutboxRelay {
  private stats: RelayStats = {
    eventsProcessed: 0,
    eventsFailed: 0,
    lastRun: null,
    lastError: null,
    isRunning: false,
  };
  
  private intervalId: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    console.log('🚀 Starting Outbox Relay Worker...');
    
    // Connect to RabbitMQ
    await rabbitMQPublisher.connect();
    
    // Run initial poll
    await this.pollOnce();
    
    // Set up interval
    this.intervalId = setInterval(() => {
      if (!this.isShuttingDown) {
        this.pollOnce().catch(err => {
          console.error('Poll error:', err);
        });
      }
    }, POLL_INTERVAL_MS);

    this.stats.isRunning = true;
    console.log(`✅ Outbox Relay started (poll every ${POLL_INTERVAL_MS}ms, batch size: ${BATCH_SIZE})`);
  }

  async stop(): Promise<void> {
    console.log('🛑 Stopping Outbox Relay...');
    this.isShuttingDown = true;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    // Wait for current poll to complete (max 30s)
    const startWait = Date.now();
    while (this.stats.isRunning && Date.now() - startWait < 30000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    await rabbitMQPublisher.close();
    await idempotencyService.close();
    
    this.stats.isRunning = false;
    console.log('✅ Outbox Relay stopped');
  }

  async pollOnce(): Promise<{ processed: number; failed: number }> {
    if (this.stats.isRunning) {
      // Prevent concurrent polls
      return { processed: 0, failed: 0 };
    }

    this.stats.isRunning = true;
    let processed = 0;
    let failed = 0;

    try {
      // 1. Fetch pending events (with FOR UPDATE SKIP LOCKED for concurrent relay safety)
      const events = await this.fetchPendingEvents();
      
      if (events.length === 0) {
        this.stats.lastRun = new Date();
        this.stats.isRunning = false;
        return { processed: 0, failed: 0 };
      }

      console.log(`📦 Processing ${events.length} outbox events...`);

      // 2. Process each event
      for (const event of events) {
        try {
          await this.processEvent(event);
          processed++;
          this.stats.eventsProcessed++;
        } catch (error) {
          failed++;
          this.stats.eventsFailed++;
          await this.handleEventFailure(event, error as Error);
        }
      }

      // 3. Update relay state
      await this.updateRelayState(events[events.length - 1].id);
      
      this.stats.lastRun = new Date();
      this.stats.lastError = null;
      
    } catch (error) {
      this.stats.lastError = (error as Error).message;
      console.error('Poll failed:', error);
      failed = 1;
    } finally {
      this.stats.isRunning = false;
    }

    return { processed, failed };
  }

  private async fetchPendingEvents(): Promise<OutboxEventRow[]> {
    const result = await query<OutboxEventRow>(
      `SELECT * FROM outbox_events
       WHERE status IN ('PENDING', 'RETRY')
         AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE]
    );
    return result.rows;
  }

  private async processEvent(event: OutboxEventRow): Promise<void> {
    // Idempotency check - use event ID as key
    const idempotencyKey = `outbox:${event.id}`;
    const { isDuplicate, existingResult } = await idempotencyService.checkAndMark(idempotencyKey, event.id);
    
    if (isDuplicate) {
      console.log(`⏭️ Event ${event.id} already processed (idempotent), skipping`);
      // Mark as processed in DB if not already
      if (event.status !== 'PROCESSED') {
        await this.markEventProcessed(event.id);
      }
      return;
    }

    // Mark as PROCESSING to prevent other relay instances from picking it up
    await this.markEventProcessing(event.id);

    try {
      // Determine routing key based on event type
      const routingKey = this.getRoutingKey(event.event_type);
      
      // Publish to RabbitMQ
      await rabbitMQPublisher.publish(routingKey, {
        ...event.payload,
        metadata: event.metadata,
        _outbox: {
          eventId: event.id,
          eventType: event.event_type,
          aggregateId: event.aggregate_id,
          aggregateType: event.aggregate_type,
          createdAt: event.created_at,
        },
      });

      // Mark as PROCESSED
      await this.markEventProcessed(event.id);
      
      // Store result for idempotency
      await idempotencyService.storeResult(idempotencyKey, { 
        status: 'published', 
        routingKey,
        publishedAt: new Date().toISOString() 
      });

      console.log(`✅ Published event ${event.id} (${event.event_type}) to ${routingKey}`);
    } catch (error) {
      // Release the idempotency reservation: the broker never got this event,
      // so the next poll MUST be allowed to publish it again.
      await idempotencyService.releaseReservation(idempotencyKey, event.id);
      // Re-throw to be caught by pollOnce
      throw error;
    }
  }

  private getRoutingKey(eventType: string): string {
    const routingMap: Record<string, string> = {
      'INVOICE_CREATED': 'invoice.created',
      'INVOICE_SENT_TO_KSEF': 'invoice.sent',
      'INVOICE_KSEF_ACCEPTED': 'invoice.ksef.accepted',
      'INVOICE_KSEF_REJECTED': 'invoice.ksef.rejected',
    };
    return routingMap[eventType] || 'invoice.unknown';
  }

  private async markEventProcessing(eventId: string): Promise<void> {
    await query(
      `UPDATE outbox_events 
       SET status = 'PROCESSING', retry_count = retry_count + 1
       WHERE id = $1 AND status IN ('PENDING', 'RETRY')`,
      [eventId]
    );
  }

  private async markEventProcessed(eventId: string): Promise<void> {
    await query(
      `UPDATE outbox_events 
       SET status = 'PROCESSED', processed_at = NOW(), published_at = NOW()
       WHERE id = $1`,
      [eventId]
    );
  }

  private async handleEventFailure(event: OutboxEventRow, error: Error): Promise<void> {
    const newRetryCount = event.retry_count + 1;
    const shouldRetry = newRetryCount < MAX_RETRIES;

    const status = shouldRetry ? 'RETRY' : 'FAILED';
    const errorMessage = error.message.substring(0, 1000);
    // Exponential backoff with jitter — without it a burst of failed events
    // is retried in lockstep every POLL_INTERVAL_MS, which is exactly the
    // retry storm that hits the Ministry gateway.
    const delayMs = shouldRetry
      ? Math.min(BASE_DELAY_MS * Math.pow(2, newRetryCount - 1), 300000) *
        (0.5 + Math.random())
      : null;

    await query(
      `UPDATE outbox_events
       SET status = $1, last_error = $2, retry_count = $3, next_retry_at = $4
       WHERE id = $5`,
      [status, errorMessage, newRetryCount, delayMs ? new Date(Date.now() + delayMs) : null, event.id]
    );

    console.error(`❌ Event ${event.id} failed (attempt ${newRetryCount}/${MAX_RETRIES}): ${errorMessage}`);

    if (shouldRetry) {
      console.warn(`⏳ Retry ${event.id} scheduled in ${Math.round(delayMs!)}ms`);
    } else {
      console.error(`💀 Event ${event.id} moved to FAILED after ${MAX_RETRIES} retries`);
      // Could trigger alert/notification here
    }
  }

  private async updateRelayState(lastProcessedId: string): Promise<void> {
    await query(
      `UPDATE outbox_relay_state 
       SET last_processed_id = $1, last_processed_at = NOW(), 
           events_processed_total = events_processed_total + $2,
           events_failed_total = events_failed_total + $3,
           updated_at = NOW()
       WHERE id = 1`,
      [lastProcessedId, this.stats.eventsProcessed, this.stats.eventsFailed]
    );
  }

  getStats(): RelayStats {
    return { ...this.stats };
  }

  async getOutboxStats(): Promise<any[]> {
    const result = await query(
      `SELECT status, COUNT(*) as count 
       FROM outbox_events 
       GROUP BY status`
    );
    return result.rows;
  }
}

export const outboxRelay = new OutboxRelay();