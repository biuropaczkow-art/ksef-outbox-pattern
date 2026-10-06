import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ksef_invoices',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DB_SSL === 'true',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 100) {
    console.log(`Slow query (${duration}ms):`, text.substring(0, 100));
  }
  return result;
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export interface InvoiceRow {
  id: string;
  invoice_number: string;
  seller_nip: string;
  buyer_nip: string;
  seller_name: string;
  buyer_name: string;
  issue_date: string;
  sale_date: string;
  currency: string;
  total_net: string;
  total_vat: string;
  total_gross: string;
  ksef_number: string | null;
  ksef_status: string;
  ksef_sent_at: string | null;
  ksef_response: any;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface InvoiceItemRow {
  id: string;
  invoice_id: string;
  line_number: number;
  name: string;
  quantity: string;
  unit: string;
  unit_price_net: string;
  vat_rate: string;
  net_amount: string;
  vat_amount: string;
  gross_amount: string;
  created_at: string;
}

export interface OutboxEventRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_type: string;
  payload: any;
  metadata: any;
  status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'RETRY';
  retry_count: number;
  last_error: string | null;
  next_retry_at: string | null;
  created_at: string;
  processed_at: string | null;
  published_at: string | null;
}