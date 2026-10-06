import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ksef_invoices',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  ssl: process.env.DB_SSL === 'true',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const MIGRATION_SQL = `
-- ============================================================================
-- KSeF Invoice Processing - Database Schema with Transactional Outbox Pattern
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- INVOICES TABLE - Core business entity
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_number VARCHAR(50) NOT NULL UNIQUE,
    seller_nip VARCHAR(10) NOT NULL,
    buyer_nip VARCHAR(10) NOT NULL,
    seller_name VARCHAR(255) NOT NULL,
    buyer_name VARCHAR(255) NOT NULL,
    issue_date DATE NOT NULL,
    sale_date DATE NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'PLN',
    total_net NUMERIC(15, 2) NOT NULL,
    total_vat NUMERIC(15, 2) NOT NULL,
    total_gross NUMERIC(15, 2) NOT NULL,
    ksef_number VARCHAR(50),
    ksef_status VARCHAR(50) DEFAULT 'DRAFT',
    ksef_sent_at TIMESTAMPTZ,
    ksef_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_invoices_seller_nip ON invoices(seller_nip);
CREATE INDEX IF NOT EXISTS idx_invoices_buyer_nip ON invoices(buyer_nip);
CREATE INDEX IF NOT EXISTS idx_invoices_ksef_status ON invoices(ksef_status);
CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date);

-- ============================================================================
-- INVOICE LINE ITEMS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    quantity NUMERIC(10, 3) NOT NULL,
    unit VARCHAR(20) NOT NULL,
    unit_price_net NUMERIC(15, 4) NOT NULL,
    vat_rate NUMERIC(5, 2) NOT NULL,
    net_amount NUMERIC(15, 2) NOT NULL,
    vat_amount NUMERIC(15, 2) NOT NULL,
    gross_amount NUMERIC(15, 2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);

-- ============================================================================
-- OUTBOX EVENTS TABLE - Transactional Outbox Pattern
-- ============================================================================
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type VARCHAR(100) NOT NULL,
    aggregate_id UUID NOT NULL,
    aggregate_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    metadata JSONB DEFAULT '{}',
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ
);

-- Backfill for databases created before next_retry_at existed
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Critical indexes for relay performance
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox_events(status, created_at) 
    WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX IF NOT EXISTS idx_outbox_next_retry ON outbox_events(next_retry_at)
    WHERE status = 'RETRY';
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox_events(aggregate_id, aggregate_type);

-- ============================================================================
-- IDEMPOTENCY KEYS TABLE - For exactly-once processing
-- ============================================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
    key VARCHAR(255) PRIMARY KEY,
    event_id UUID NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================================
-- OUTBOX RELAY STATE TABLE - For monitoring and debugging
-- ============================================================================
CREATE TABLE IF NOT EXISTS outbox_relay_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_processed_id UUID,
    last_processed_at TIMESTAMPTZ,
    events_processed_total BIGINT NOT NULL DEFAULT 0,
    events_failed_total BIGINT NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Initialize relay state
INSERT INTO outbox_relay_state (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- FUNCTION: Update updated_at timestamp
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_invoices_updated_at ON invoices;
CREATE TRIGGER update_invoices_updated_at
    BEFORE UPDATE ON invoices
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- FUNCTION: Clean up old processed outbox events (run via cron)
-- ============================================================================
CREATE OR REPLACE FUNCTION cleanup_outbox_events(retention_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM outbox_events
    WHERE status = 'PROCESSED'
    AND processed_at < NOW() - (retention_days || ' days')::INTERVAL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- FUNCTION: Get outbox statistics
-- ============================================================================
CREATE OR REPLACE FUNCTION get_outbox_stats()
RETURNS TABLE (
    status VARCHAR(20),
    count BIGINT,
    oldest_pending TIMESTAMPTZ,
    newest_pending TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        oe.status::VARCHAR(20),
        COUNT(*)::BIGINT,
        MIN(CASE WHEN oe.status = 'PENDING' THEN oe.created_at END),
        MAX(CASE WHEN oe.status = 'PENDING' THEN oe.created_at END)
    FROM outbox_events oe
    GROUP BY oe.status;
END;
$$ LANGUAGE plpgsql;
`;

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('🔄 Running database migration...');
    await client.query(MIGRATION_SQL);
    console.log('✅ Migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(() => process.exit(1));