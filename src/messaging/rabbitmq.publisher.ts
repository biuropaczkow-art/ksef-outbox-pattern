import amqp, { ChannelModel, ConfirmChannel } from 'amqplib';
import dotenv from 'dotenv';

dotenv.config();

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:***@localhost:5672';
const EXCHANGE_NAME = process.env.RABBITMQ_EXCHANGE || 'ksef.events';
const QUEUE_NAME = process.env.RABBITMQ_QUEUE || 'ksef.invoice.created';
const DLX_NAME = process.env.RABBITMQ_DLX || 'ksef.dlx';
const DLQ_NAME = process.env.RABBITMQ_DLQ || `${QUEUE_NAME}.dlq`;

export class RabbitMQPublisher {
  private connection: ChannelModel | null = null;
  private channel: ConfirmChannel | null = null;
  private isConnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  async connect(): Promise<void> {
    if (this.connection || this.isConnecting) return;

    this.isConnecting = true;

    try {
      this.connection = await amqp.connect(RABBITMQ_URL, {
        heartbeat: 30,
        connection_timeout: 10000,
      });

      this.connection.on('error', (err) => {
        console.error('RabbitMQ connection error:', err.message);
        this.handleDisconnect();
      });

      this.connection.on('close', () => {
        console.log('RabbitMQ connection closed');
        this.handleDisconnect();
      });

      this.channel = await this.connection.createConfirmChannel();

      // Declare exchange and queue
      await this.channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true });

      // Dead-letter topology. Declared BEFORE the main queue so the queue is
      // never created without its dead-letter route: a queue asserted without
      // x-dead-letter-exchange silently discards every rejected message, and
      // the next post-mortem has nothing to inspect.
      await this.channel.assertExchange(DLX_NAME, 'topic', { durable: true });
      await this.channel.assertQueue(DLQ_NAME, { durable: true });
      await this.channel.bindQueue(DLQ_NAME, DLX_NAME, '#');

      await this.channel.assertQueue(QUEUE_NAME, {
        durable: true,
        arguments: {
          // amqplib has no `type` option — it only forwards `arguments`, so the
          // queue type must be requested explicitly. x-delivery-limit is
          // honoured by quorum queues only; a classic queue rejects it with
          // PRECONDITION_FAILED.
          'x-queue-type': 'quorum',
          'x-dead-letter-exchange': DLX_NAME,
          'x-delivery-limit': 5,
        },
      });
      await this.channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, 'invoice.created');
      await this.channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, 'invoice.ksef.accepted');
      await this.channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, 'invoice.ksef.rejected');
      await this.channel.bindQueue(QUEUE_NAME, EXCHANGE_NAME, 'invoice.sent');

      console.log('✅ RabbitMQ connected and topology declared');
      console.log(`   DLQ: ${DLQ_NAME} via ${DLX_NAME} (x-delivery-limit 5)`);
    } catch (error) {
      this.isConnecting = false;
      this.connection = null;
      console.error('Failed to connect to RabbitMQ:', error);
      throw error;
    }

    this.isConnecting = false;
  }

  private handleDisconnect(): void {
    this.connection = null;
    this.channel = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (error) {
        console.error('Reconnection failed:', error);
      }
    }, 5000);
  }

  async publish(routingKey: string, message: any, options: { persistent?: boolean } = {}): Promise<boolean> {
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }

    const content = Buffer.from(JSON.stringify(message));

    return new Promise<boolean>((resolve, reject) => {
      this.channel!.publish(
        EXCHANGE_NAME,
        routingKey,
        content,
        {
          persistent: options.persistent ?? true,
          contentType: 'application/json',
          timestamp: Date.now(),
          messageId: message.metadata?.correlationId || message.aggregateId,
        },
        // amqplib's confirm callback is invoked with a SINGLE argument:
        // null means the broker ACKed, an Error means NACK. It is not an
        // (err, ok) pair, so reading a second parameter always yields
        // undefined and would report a confirmed publish as failed.
        (err) => {
          if (err) {
            console.error(`Publish NACKed for ${routingKey}:`, err.message);
            reject(err);
          } else {
            resolve(true);
          }
        }
      );
    });
  }

  async publishBatch(messages: Array<{ routingKey: string; message: any }>): Promise<number> {
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }

    let successCount = 0;
    
    for (const { routingKey, message } of messages) {
      try {
        await this.publish(routingKey, message);
        successCount++;
      } catch (error) {
        console.error(`Failed to publish message for ${routingKey}:`, error);
        // Continue with other messages
      }
    }

    return successCount;
  }

  async waitForConfirms(): Promise<void> {
    if (!this.channel) return;
    await this.channel.waitForConfirms();
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }
    
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
    
    console.log('RabbitMQ connection closed gracefully');
  }

  get isConnected(): boolean {
    return this.connection !== null && this.channel !== null;
  }
}

export const rabbitMQPublisher = new RabbitMQPublisher();