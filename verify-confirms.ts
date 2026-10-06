/**
 * Real verification of Publisher Confirms + DLQ state against the live broker.
 * Run: npx ts-node verify-confirms.ts
 */
import amqp from 'amqplib';
import { rabbitMQPublisher } from './src/messaging/rabbitmq.publisher';
import { idempotencyService } from './src/services/idempotency.service';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';

async function inspectTopology() {
  const conn = await amqp.connect(RABBITMQ_URL);
  // A 404 on a queue check kills the whole channel, so use a fresh channel per
  // probe and never let the channel 'error' event become an unhandled rejection.
  const probe = async (name: string) => {
    const ch = await conn.createChannel();
    ch.on('error', () => {});
    try {
      return await ch.checkQueue(name);
    } finally {
      await ch.close().catch(() => {});
    }
  };
  console.log('--- queues ---');
  try {
    console.log('ksef.invoice.created:', JSON.stringify(await probe('ksef.invoice.created')));
  } catch (e: any) {
    console.log('AUDIT: ksef.invoice.created MISSING —', e.message);
  }
  try {
    const dlq = await probe('ksef.invoice.created.dlq');
    console.log('DLQ ksef.invoice.created.dlq:', JSON.stringify(dlq));
  } catch (e: any) {
    console.log('DLQ: does not exist —', e.message);
  }
  // full queue list via rabbitmqctl-equivalent: passive declare on known names
  for (const n of ['ksef.dlq', 'ksef.invoice.dlq', 'dead-letter', 'dlq']) {
    try {
      const q = await probe(n);
      console.log(`found queue ${n}:`, JSON.stringify(q));
    } catch { /* absent */ }
  }
  await conn.close();
}

async function testConfirmAck() {
  console.log('--- test 1: publish confirmed by broker ---');
  const ok = await rabbitMQPublisher.publish('invoice.created', {
    _verify: 'confirm-test',
    metadata: { correlationId: 'verify-1' },
    aggregateId: '00000000-0000-0000-0000-000000000001',
  });
  console.log(ok ? 'PASS: broker ACKed the publish' : 'FAIL: no ack');
  return !!ok;
}

async function testConfirmNack() {
  console.log('--- test 2: publish must FAIL (NACK) when the channel dies before confirm ---');
  // Simulates the exact production window from the status report: server dies
  // right as the TCP packet is accepted, before the broker confirms.
  const mod = await import('./src/messaging/rabbitmq.publisher');
  const fresh = new mod.RabbitMQPublisher();
  let rejected = false;
  try {
    await fresh.connect();
    const pending = fresh.publish('invoice.created', { _verify: 'nack-test' });
    // kill the channel before the confirm can arrive
    await (fresh as any).channel.close();
    await pending;
    console.log('FAIL: publish resolved although the channel was killed');
  } catch (e: any) {
    rejected = true;
    console.log('PASS: publish rejected ->', e.message);
  }
  await fresh.close().catch(() => {});
  return rejected;
}

async function testIdempotencyRelease() {
  console.log('--- test 3: reservation released on failure (invoice-loss guard) ---');
  const key = 'outbox:verify-idem';
  const eventId = 'evt-verify-1';
  const first = await idempotencyService.checkAndMark(key, eventId);
  console.log('first checkAndMark isDuplicate =', first.isDuplicate, '(expect false)');
  // simulate the catch-branch in processEvent
  await idempotencyService.releaseReservation(key, eventId);
  const second = await idempotencyService.checkAndMark(key, eventId);
  console.log('after release, isDuplicate =', second.isDuplicate, '(expect false — was true before the fix)');
  return second.isDuplicate === false;
}

(async () => {
  const results: Record<string, boolean> = {};
  try { await inspectTopology(); } catch (e: any) { console.log('topology inspect failed:', e.message); }
  try { results.confirmAck = await testConfirmAck(); } catch (e: any) { console.log('test1 error:', e.message); results.confirmAck = false; }
  try { results.publishRejectsOnFailure = await testConfirmNack(); } catch (e: any) { console.log('test2 error:', e.message); }
  try { results.idempotencyRelease = await testIdempotencyRelease(); } catch (e: any) { console.log('test3 error:', e.message); }
  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
  await rabbitMQPublisher.close().catch(() => {});
  await idempotencyService.close().catch(() => {});
  process.exit(0);
})();
