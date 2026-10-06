import { outboxRelay } from './relay/outbox-relay';
import { rabbitMQPublisher } from './messaging/rabbitmq.publisher';
import { idempotencyService } from './services/idempotency.service';
import { closePool } from './db/pool';

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  KSeF Outbox Relay Worker                                   ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

async function main() {
  try {
    await outboxRelay.start();
    
    // Keep process alive
    process.on('SIGINT', async () => {
      console.log('\n🛑 Received SIGINT, shutting down gracefully...');
      await outboxRelay.stop();
      await closePool();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
      await outboxRelay.stop();
      await closePool();
      process.exit(0);
    });

    // Periodic stats logging
    setInterval(() => {
      const stats = outboxRelay.getStats();
      console.log(`📊 Relay Stats: Processed=${stats.eventsProcessed}, Failed=${stats.eventsFailed}, LastRun=${stats.lastRun?.toISOString() || 'never'}`);
    }, 60000);

  } catch (error) {
    console.error('❌ Failed to start relay:', error);
    await closePool();
    process.exit(1);
  }
}

main();