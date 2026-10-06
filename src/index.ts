import { invoiceService } from './services/invoice.service';
import { outboxRelay } from './relay/outbox-relay';
import { pool, closePool } from './db/pool';
import { rabbitMQPublisher } from './messaging/rabbitmq.publisher';
import { idempotencyService } from './services/idempotency.service';

async function runDemo() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  KSeF Outbox Pattern - Demo                                 ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  try {
    // Test 1: Create invoice (writes to DB + outbox in single transaction)
    console.log('\n📝 Test 1: Creating invoice with transactional outbox...');
    
    const invoice = await invoiceService.createInvoice({
      invoiceNumber: `FV/${new Date().getFullYear()}/001`,
      sellerNip: '7532190370',
      buyerNip: '1234567890',
      sellerName: 'Biuro Rachunkowe Konik Jarosław',
      buyerName: 'Klient Testowy Sp. z o.o.',
      issueDate: new Date().toISOString().split('T')[0],
      saleDate: new Date().toISOString().split('T')[0],
      currency: 'PLN',
      items: [
        { lineNumber: 1, name: 'Usługi księgowe - miesiąc wrzesień', quantity: 1, unit: 'szt', unitPriceNet: 500.00, vatRate: 23 },
        { lineNumber: 2, name: 'Doradztwo podatkowe', quantity: 2, unit: 'godz', unitPriceNet: 200.00, vatRate: 23 },
      ],
    });

    console.log(`✅ Invoice created: ${invoice.id}`);
    console.log(`   Number: ${invoice.invoiceNumber}`);
    console.log(`   Total: ${invoice.totalGross} ${invoice.currency}`);
    console.log(`   Status: ${invoice.ksefStatus}`);
    console.log(`   Items: ${invoice.items.length}`);

    // Test 2: Create another invoice
    console.log('\n📝 Test 2: Creating second invoice...');
    
    const invoice2 = await invoiceService.createInvoice({
      invoiceNumber: `FV/${new Date().getFullYear()}/002`,
      sellerNip: '7532190370',
      buyerNip: '9876543210',
      sellerName: 'Biuro Rachunkowe Konik Jarosław',
      buyerName: 'Inny Klient S.A.',
      issueDate: new Date().toISOString().split('T')[0],
      saleDate: new Date().toISOString().split('T')[0],
      currency: 'PLN',
      items: [
        { lineNumber: 1, name: 'Usługi księgowe - kwartał Q3', quantity: 1, unit: 'szt', unitPriceNet: 1500.00, vatRate: 23 },
      ],
    });

    console.log(`✅ Invoice created: ${invoice2.id}`);

    // Test 3: Check outbox events
    console.log('\n📋 Test 3: Checking outbox events...');
    const outboxStats = await outboxRelay.getOutboxStats();
    console.table(outboxStats);

    // Test 4: Run relay once to publish events
    console.log('\n🚀 Test 4: Running outbox relay (publish to RabbitMQ)...');
    const relayResult = await outboxRelay.pollOnce();
    console.log(`   Processed: ${relayResult.processed}, Failed: ${relayResult.failed}`);

    // Test 5: Check outbox after relay
    console.log('\n📋 Test 5: Outbox status after relay...');
    const outboxStatsAfter = await outboxRelay.getOutboxStats();
    console.table(outboxStatsAfter);

    // Test 6: Simulate KSeF acceptance (updates invoice + writes to outbox in transaction)
    console.log('\n📝 Test 6: Simulating KSeF acceptance...');
    const acceptedInvoice = await invoiceService.markAsAccepted(
      invoice.id,
      'KSEF-2026-000123456',
      'REF-ABC-123'
    );
    console.log(`✅ Invoice marked as ACCEPTED: ${acceptedInvoice.ksefNumber}`);

    // Test 7: Run relay again for new events
    console.log('\n🚀 Test 7: Running relay for KSeF events...');
    await outboxRelay.pollOnce();

    // Final stats
    console.log('\n📊 Final Outbox Stats:');
    const finalStats = await outboxRelay.getOutboxStats();
    console.table(finalStats);

    console.log('\n📊 Relay Stats:');
    console.table(outboxRelay.getStats());

  } catch (error) {
    console.error('❌ Demo failed:', error);
  } finally {
    await closePool();
    await rabbitMQPublisher.close();
    await idempotencyService.close();
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await outboxRelay.stop();
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down...');
  await outboxRelay.stop();
  await closePool();
  process.exit(0);
});

runDemo();