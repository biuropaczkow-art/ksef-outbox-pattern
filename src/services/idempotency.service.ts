import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

export const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0'),
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    if (times > 3) return null;
    return Math.min(times * 200, 2000);
  },
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('✅ Redis connected');
});

export class IdempotencyService {
  private defaultTtlSeconds = 86400 * 7; // 7 days

  async checkAndMark(key: string, eventId: string): Promise<{ isDuplicate: boolean; existingResult?: any }> {
    const redisKey = `idempotency:${key}`;
    
    // Use SET NX EX for atomic check-and-set
    const result = await redis.set(redisKey, eventId, 'EX', this.defaultTtlSeconds, 'NX');
    
    if (result === 'OK') {
      // First time seeing this key - not a duplicate
      return { isDuplicate: false };
    }

    // Key exists - check if it's the same event (idempotent retry) or different event (collision)
    const existingEventId = await redis.get(redisKey);
    
    if (existingEventId === eventId) {
      // Same event ID - this is a legitimate retry, get cached result
      const cachedResult = await redis.get(`idempotency:result:${key}`);
      return { 
        isDuplicate: true, 
        existingResult: cachedResult ? JSON.parse(cachedResult) : undefined 
      };
    }

    // Different event ID for same key - collision (should not happen with UUID keys)
    throw new Error(`Idempotency key collision: ${key}`);
  }

  async storeResult(key: string, result: any): Promise<void> {
    const redisKey = `idempotency:result:${key}`;
    await redis.set(redisKey, JSON.stringify(result), 'EX', this.defaultTtlSeconds);
  }

  /**
   * Release a reservation taken by checkAndMark() when the work it guarded
   * FAILED. Without this the key survives the failure, the next poll sees
   * isDuplicate=true and marks the event PROCESSED although it was never
   * handed to the broker -> silent invoice loss.
   */
  async releaseReservation(key: string, eventId: string): Promise<void> {
    const redisKey = `idempotency:${key}`;
    // Only delete if we still own the reservation (compare-and-delete)
    const current = await redis.get(redisKey);
    if (current === eventId) {
      await redis.del(redisKey, `idempotency:result:${key}`);
    }
  }

  async remove(key: string): Promise<void> {
    await redis.del(`idempotency:${key}`, `idempotency:result:${key}`);
  }

  async close(): Promise<void> {
    await redis.quit();
  }
}

export const idempotencyService = new IdempotencyService();