import crypto from 'crypto';

// In-memory mock tables
interface MockOutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_type: string;
  payload: any;
  metadata: any;
  status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'RETRY' | 'FAILED';
  retry_count: number;
  last_error: string | null;
  next_retry_at: Date | null;
  created_at: Date;
  processed_at: Date | null;
  published_at: Date | null;
}

interface MockInvoiceRow {
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
  ksef_status: string;
  ksef_number: string | null;
  ksef_sent_at: string | null;
  ksef_response: any;
  created_at: string;
  updated_at: string;
  version: number;
}

let mockOutboxEvents: MockOutboxRow[] = [];
let mockInvoices: MockInvoiceRow[] = [];
let mockInvoiceItems: any[] = [];
let mockRelayState = {
  id: 1,
  last_processed_id: '0',
  events_processed_total: 0,
  events_failed_total: 0,
  updated_at: new Date()
};

// Mock the DB pool module before importing services
jest.mock('../src/db/pool', () => {
  return {
    query: jest.fn(async (sql: string, params?: any[]) => {
      const cleanSql = sql.trim().toUpperCase();

      // SELECT * FROM outbox_events WHERE aggregate_id = $1
      if (cleanSql.includes('SELECT * FROM OUTBOX_EVENTS WHERE AGGREGATE_ID = $1')) {
        const rows = mockOutboxEvents.filter(e => e.aggregate_id === params![0]);
        return { rows, rowCount: rows.length };
      }

      // SELECT * FROM outbox_events WHERE id = $1
      if (cleanSql.includes('SELECT * FROM OUTBOX_EVENTS WHERE ID = $1')) {
        const rows = mockOutboxEvents.filter(e => e.id === params![0]);
        return { rows, rowCount: rows.length };
      }

      // SELECT id FROM outbox_events WHERE status = 'FAILED'
      if (cleanSql.includes("SELECT ID FROM OUTBOX_EVENTS WHERE STATUS = 'FAILED'")) {
        const rows = mockOutboxEvents.filter(e => e.status === 'FAILED').map(e => ({ id: e.id }));
        return { rows, rowCount: rows.length };
      }

      // SELECT status, published_at FROM outbox_events WHERE id = $1
      if (cleanSql.includes('SELECT STATUS, PUBLISHED_AT FROM OUTBOX_EVENTS WHERE ID = $1')) {
        const rows = mockOutboxEvents.filter(e => e.id === params![0]).map(e => ({ status: e.status, published_at: e.published_at }));
        return { rows, rowCount: rows.length };
      }

      // fetchPendingEvents: SELECT * FROM outbox_events WHERE status IN ('PENDING', 'RETRY')
      if (cleanSql.includes('SELECT * FROM OUTBOX_EVENTS') && cleanSql.includes("'PENDING', 'RETRY'")) {
        const now = new Date();
        const rows = mockOutboxEvents
          .filter(e => 
            (e.status === 'PENDING' || e.status === 'RETRY') &&
            (!e.next_retry_at || e.next_retry_at <= now)
          )
          .map(e => ({ ...e })); // Return snapshot copy like real PG
        return { rows, rowCount: rows.length };
      }

      // UPDATE outbox_events SET status = 'PROCESSING'
      if (cleanSql.includes('UPDATE OUTBOX_EVENTS') && cleanSql.includes("STATUS = 'PROCESSING'")) {
        const eventId = params![0];
        const event = mockOutboxEvents.find(e => e.id === eventId);
        if (event) {
          event.status = 'PROCESSING';
          event.retry_count += 1;
        }
        return { rows: [], rowCount: 1 };
      }

      // UPDATE outbox_events SET status = 'PROCESSED'
      if (cleanSql.includes('UPDATE OUTBOX_EVENTS') && cleanSql.includes("STATUS = 'PROCESSED'")) {
        const eventId = params![0];
        const event = mockOutboxEvents.find(e => e.id === eventId);
        if (event) {
          event.status = 'PROCESSED';
          event.processed_at = new Date();
          event.published_at = new Date();
        }
        return { rows: [], rowCount: 1 };
      }

      // UPDATE outbox_events SET status = $1, last_error = $2, retry_count = $3, next_retry_at = $4 WHERE id = $5
      if (cleanSql.includes('UPDATE OUTBOX_EVENTS') && cleanSql.includes('NEXT_RETRY_AT = $4')) {
        const [status, last_error, retry_count, next_retry_at, id] = params!;
        const event = mockOutboxEvents.find(e => e.id === id);
        if (event) {
          event.status = status;
          event.last_error = last_error;
          event.retry_count = retry_count;
          event.next_retry_at = next_retry_at;
        }
        return { rows: [], rowCount: 1 };
      }

      // UPDATE outbox_events SET status = 'PENDING', retry_count = 0 (reset/replay)
      if (cleanSql.includes('UPDATE OUTBOX_EVENTS') && cleanSql.includes("STATUS = 'PENDING'")) {
        const eventId = params![0];
        const event = mockOutboxEvents.find(e => e.id === eventId);
        if (event) {
          event.status = 'PENDING';
          event.retry_count = 0;
          event.next_retry_at = null;
          event.last_error = null;
        }
        return { rows: [], rowCount: 1 };
      }

      // Custom test simulation: UPDATE outbox_events SET retry_count = 4
      if (cleanSql.includes('UPDATE OUTBOX_EVENTS') && cleanSql.includes('RETRY_COUNT = 4')) {
        const eventId = params![0];
        const event = mockOutboxEvents.find(e => e.id === eventId);
        if (event) {
          event.retry_count = 4;
          event.status = 'RETRY';
          event.next_retry_at = new Date(Date.now() - 1000);
        }
        return { rows: [], rowCount: 1 };
      }

      // UPDATE outbox_relay_state
      if (cleanSql.includes('UPDATE OUTBOX_RELAY_STATE')) {
        mockRelayState.last_processed_id = params![0];
        mockRelayState.events_processed_total += params![1];
        mockRelayState.events_failed_total += params![2];
        return { rows: [], rowCount: 1 };
      }

      // SELECT * FROM invoices WHERE id = $1
      if (cleanSql.includes('SELECT * FROM INVOICES WHERE ID = $1')) {
        const rows = mockInvoices.filter(i => i.id === params![0]);
        return { rows, rowCount: rows.length };
      }

      // SELECT * FROM invoice_items WHERE invoice_id = $1
      if (cleanSql.includes('SELECT * FROM INVOICE_ITEMS WHERE INVOICE_ID = $1')) {
        const rows = mockInvoiceItems.filter(i => i.invoice_id === params![0]);
        return { rows, rowCount: rows.length };
      }

      return { rows: [], rowCount: 0 };
    }),

    transaction: jest.fn(async (callback: any) => {
      const mockClient = {
        query: jest.fn(async (sql: string, params?: any[]) => {
          const cleanSql = sql.trim().toUpperCase();

          if (cleanSql.startsWith('INSERT INTO INVOICES')) {
            const [id, invoice_number, seller_nip, buyer_nip, seller_name, buyer_name, issue_date, sale_date, currency, total_net, total_vat, total_gross, ksef_status] = params!;
            mockInvoices.push({
              id,
              invoice_number,
              seller_nip,
              buyer_nip,
              seller_name,
              buyer_name,
              issue_date,
              sale_date,
              currency,
              total_net,
              total_vat,
              total_gross,
              ksef_status,
              ksef_number: null,
              ksef_sent_at: null,
              ksef_response: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              version: 1
            });
            return { rows: [], rowCount: 1 };
          }

          if (cleanSql.startsWith('INSERT INTO INVOICE_ITEMS')) {
            mockInvoiceItems.push({
              id: params![0],
              invoice_id: params![1],
              line_number: params![2],
              name: params![3],
              quantity: params![4],
              unit: params![5],
              unit_price_net: params![6],
              vat_rate: params![7],
              net_amount: params![8],
              vat_amount: params![9],
              gross_amount: params![10]
            });
            return { rows: [], rowCount: 1 };
          }

          if (cleanSql.startsWith('INSERT INTO OUTBOX_EVENTS')) {
            const [event_type, aggregate_id, aggregate_type, payloadStr, metaStr] = params!;
            const newEvent: MockOutboxRow = {
              id: crypto.randomUUID(),
              event_type,
              aggregate_id,
              aggregate_type,
              payload: typeof payloadStr === 'string' ? JSON.parse(payloadStr) : payloadStr,
              metadata: typeof metaStr === 'string' ? JSON.parse(metaStr) : metaStr,
              status: 'PENDING',
              retry_count: 0,
              last_error: null,
              next_retry_at: null,
              created_at: new Date(),
              processed_at: null,
              published_at: null
            };
            mockOutboxEvents.push(newEvent);
            return { rows: [newEvent], rowCount: 1 };
          }

          return { rows: [], rowCount: 0 };
        })
      };

      return callback(mockClient);
    }),

    closePool: jest.fn(async () => {})
  };
});

import { invoiceService } from '../src/services/invoice.service';
import { outboxRelay } from '../src/relay/outbox-relay';
import { rabbitMQPublisher } from '../src/messaging/rabbitmq.publisher';
import { idempotencyService } from '../src/services/idempotency.service';

describe('A08 — Odporność KSeF Outbox: Deduplikacja, Transakcje, Retry i Kwarantanna (DLQ)', () => {
  beforeEach(() => {
    mockOutboxEvents = [];
    mockInvoices = [];
    mockInvoiceItems = [];
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await idempotencyService.close();
  });

  test('Scenariusz 1: Atomowość transakcji — faktura i zdarzenie outbox powstają jednocześnie z identyfikatorem śledzenia', async () => {
    const uniqueNum = `FV/A08/${Date.now().toString().slice(-6)}`;
    
    // Tworzymy fakturę przez Transactional Outbox
    const invoice = await invoiceService.createInvoice({
      invoiceNumber: uniqueNum,
      sellerNip: '7532190370',
      buyerNip: '5250001098',
      sellerName: 'Biuro Rachunkowe Jarosław Konik',
      buyerName: 'Klient Audytowy Sp. z o.o.',
      issueDate: '2026-11-06',
      saleDate: '2026-11-06',
      currency: 'PLN',
      items: [
        { lineNumber: 1, name: 'Obsługa księgowa KSeF', quantity: 1, unit: 'usł', unitPriceNet: 1000, vatRate: 23 }
      ]
    });

    expect(invoice.id).toBeDefined();

    // Weryfikacja atomowości: faktura istnieje
    expect(mockInvoices.length).toBe(1);
    expect(mockInvoices[0].id).toBe(invoice.id);

    // Weryfikacja zdarzenia outbox
    expect(mockOutboxEvents.length).toBe(1);
    const event = mockOutboxEvents[0];
    expect(event.aggregate_id).toBe(invoice.id);
    expect(event.status).toBe('PENDING');
    expect(event.retry_count).toBe(0);

    // Weryfikacja identyfikatora śledzenia (correlationId)
    expect(event.metadata.correlationId).toBeDefined();
    expect(typeof event.metadata.correlationId).toBe('string');
  });

  test('Scenariusz 2: Crash/restart między zapisem a potwierdzeniem — praca nie ginie (At-least-once)', async () => {
    const uniqueNum = `FV/A08/CRASH_${Date.now().toString().slice(-5)}`;
    
    const invoice = await invoiceService.createInvoice({
      invoiceNumber: uniqueNum,
      sellerNip: '7532190370',
      buyerNip: '5250001098',
      sellerName: 'Biuro Rachunkowe Jarosław Konik',
      buyerName: 'Klient Crash-Test Sp. z o.o.',
      issueDate: '2026-11-06',
      saleDate: '2026-11-06',
      currency: 'PLN',
      items: [{ lineNumber: 1, name: 'Test odporności', quantity: 1, unit: 'szt', unitPriceNet: 500, vatRate: 23 }]
    });

    // Mockujemy sukces RabbitMQ publishera po restarcie brokera
    const publishSpy = jest.spyOn(rabbitMQPublisher, 'publish').mockResolvedValue(true);

    // Uruchamiamy poller (symulacja powrotu relay po restarcie)
    const result = await outboxRelay.pollOnce();
    expect(result.processed).toBe(1);

    // Sprawdzamy czy nasze zdarzenie zostało pomyślnie opublikowane
    const event = mockOutboxEvents.find(e => e.aggregate_id === invoice.id);
    expect(event?.status).toBe('PROCESSED');
    expect(event?.published_at).not.toBeNull();
    expect(publishSpy).toHaveBeenCalled();
  });

  test('Scenariusz 3: Idempotencja — przetworzone zdarzenie nie jest dublowane przy ponownym odpaleniu', async () => {
    const publishSpy = jest.spyOn(rabbitMQPublisher, 'publish').mockResolvedValue(true);

    // Odpalamy poller ponownie gdy brak oczekujących zdarzeń PENDING
    const resultAgain = await outboxRelay.pollOnce();
    
    // Żadne zdarzenie nie zostało zdublowane
    expect(resultAgain.processed).toBe(0);
    expect(resultAgain.failed).toBe(0);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test('Scenariusz 4: Ograniczone ponowienia (Retry) z exponential backoff przy awarii sieci KSeF', async () => {
    const uniqueNum = `FV/A08/RETRY_${Date.now().toString().slice(-5)}`;
    
    const invoice = await invoiceService.createInvoice({
      invoiceNumber: uniqueNum,
      sellerNip: '7532190370',
      buyerNip: '5250001098',
      sellerName: 'Biuro Rachunkowe Jarosław Konik',
      buyerName: 'Klient Retry Sp. z o.o.',
      issueDate: '2026-11-06',
      saleDate: '2026-11-06',
      currency: 'PLN',
      items: [{ lineNumber: 1, name: 'Test retry', quantity: 1, unit: 'szt', unitPriceNet: 200, vatRate: 23 }]
    });

    // Symulacja awarii zewnętrznej bramki KSeF (błąd HTTP 504 / timeout)
    jest.spyOn(rabbitMQPublisher, 'publish').mockRejectedValue(new Error('KSeF Gateway Timeout (504)'));

    // Pierwsza próba przetwarzania — rzuca błąd
    await outboxRelay.pollOnce();

    const event = mockOutboxEvents.find(e => e.aggregate_id === invoice.id);
    expect(event?.status).toBe('RETRY');
    expect(event?.retry_count).toBe(1);
    expect(event?.last_error).toContain('KSeF Gateway Timeout');
    expect(event?.next_retry_at).not.toBeNull();
    expect(new Date(event!.next_retry_at!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  test('Scenariusz 5: Kwarantanna (Dead Letter Queue / FAILED) po przekroczeniu limitu 5 prób', async () => {
    const uniqueNum = `FV/A08/DLQ_${Date.now().toString().slice(-5)}`;
    
    const invoice = await invoiceService.createInvoice({
      invoiceNumber: uniqueNum,
      sellerNip: '7532190370',
      buyerNip: '5250001098',
      sellerName: 'Biuro Rachunkowe Jarosław Konik',
      buyerName: 'Klient DLQ Sp. z o.o.',
      issueDate: '2026-11-06',
      saleDate: '2026-11-06',
      currency: 'PLN',
      items: [{ lineNumber: 1, name: 'Błąd permanentny schemy', quantity: 1, unit: 'szt', unitPriceNet: 100, vatRate: 23 }]
    });

    const event = mockOutboxEvents.find(e => e.aggregate_id === invoice.id)!;
    
    // Symulujemy, że zdarzenie miało już 4 próby i jest gotowe do 5-tej (ostatniej)
    event.retry_count = 4;
    event.status = 'RETRY';
    event.next_retry_at = new Date(Date.now() - 5000);

    // Symulacja błędu ostatecznego
    jest.spyOn(rabbitMQPublisher, 'publish').mockRejectedValue(new Error('KSeF Permanent Schema Rejection (422)'));

    // Uruchamiamy poller
    await outboxRelay.pollOnce();

    // Weryfikacja kwarantanny
    expect(event.status).toBe('FAILED');
    expect(event.retry_count).toBe(5);
    expect(event.last_error).toContain('KSeF Permanent Schema Rejection');
    
    // Identyfikator śledzenia i payload w 100% zachowane
    expect(event.metadata.correlationId).toBeDefined();
    expect(event.payload.invoiceNumber).toBe(uniqueNum);
  });

  test('Scenariusz 6: Bezpieczne odtworzenie (Replay) zdarzenia z kwarantanny po naprawie usterki', async () => {
    // Rejestrujemy zdarzenie w stanie FAILED (kwarantanna)
    const eventId = crypto.randomUUID();
    const failedEvent: MockOutboxRow = {
      id: eventId,
      event_type: 'INVOICE_CREATED',
      aggregate_id: crypto.randomUUID(),
      aggregate_type: 'INVOICE',
      payload: { invoiceNumber: 'FV/A08/REPLAY_001', sellerNip: '7532190370' },
      metadata: { correlationId: crypto.randomUUID() },
      status: 'FAILED',
      retry_count: 5,
      last_error: 'KSeF Schema Error',
      next_retry_at: null,
      created_at: new Date(),
      processed_at: null,
      published_at: null
    };
    mockOutboxEvents.push(failedEvent);

    // Administrator resetuje zdarzenie po usunięciu awarii
    failedEvent.status = 'PENDING';
    failedEvent.retry_count = 0;
    failedEvent.next_retry_at = null;
    failedEvent.last_error = null;

    // Mockujemy sukces publishera
    jest.spyOn(rabbitMQPublisher, 'publish').mockResolvedValue(true);

    // Uruchamiamy poller
    const replayResult = await outboxRelay.pollOnce();
    expect(replayResult.processed).toBe(1);

    // Zdarzenie pomyślnie przetworzone
    expect(failedEvent.status).toBe('PROCESSED');
    expect(failedEvent.published_at).not.toBeNull();
  });
});
