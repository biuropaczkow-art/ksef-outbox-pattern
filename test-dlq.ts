/**
 * End-to-end DLQ test: publish a message, reject it, prove it lands in the
 * Dead Letter Queue with x-death metadata intact.
 */
import amqp from 'amqplib';

const URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
const Q = 'ksef.invoice.created';
const DLQ = Q + '.dlq';

(async () => {
  const conn = await amqp.connect(URL);
  const ch = await conn.createConfirmChannel();
  ch.on('error', (e: any) => console.log('channel error:', e.message));

  // publish one identifiable message
  const body = Buffer.from(JSON.stringify({ _dlqtest: 'poison-1' }));
  await ch.assertExchange('ksef.events', 'topic', { durable: true });
  ch.publish('ksef.events', 'invoice.created', body, { persistent: true });
  await ch.waitForConfirms();
  console.log('published poison message');
  console.log('main queue:', JSON.stringify(await ch.checkQueue(Q)));

  // consume it and reject without requeue -> must go to DLQ
  const m = await ch.get(Q, { noAck: false });
  if (!m) { console.log('FAIL: nothing to consume'); process.exit(1); }
  ch.nack(m, false, false); // requeue=false => dead-letter
  console.log('rejected (requeue=false)');

  await new Promise(r => setTimeout(r, 700));
  const dlqState = await ch.checkQueue(DLQ);
  console.log('dlq:', JSON.stringify(dlqState));
  if (dlqState.messageCount === 0) {
    console.log('FAIL: message did NOT reach the DLQ');
    process.exit(1);
  }

  const dm = await ch.get(DLQ, { noAck: false });
  const parsed = JSON.parse(dm!.content.toString());
  const xdeath = dm!.properties.headers?.['x-death'];
  console.log('dlq body:', JSON.stringify(parsed));
  console.log('x-death:', JSON.stringify(xdeath));
  console.log(
    xdeath
      ? 'PASS: DLQ captured the poison message with x-death metadata'
      : 'FAIL: no x-death header on the dead-lettered message'
  );
  ch.ack(dm!); // clean up the test message

  await ch.close();
  await conn.close();
  console.log('final dlq:', JSON.stringify(await (async () => {
    const c = await amqp.connect(URL); const x = await c.createChannel();
    const s = await x.checkQueue(DLQ); await x.close(); await c.close(); return s;
  })()));
})();
