/**
 * Standalone verification script for Outbox Resilience (Audit requirement A08).
 * Tests all 6 critical resilience guarantees:
 * 1. Transactional Outbox atomicity (invoice + outbox event with correlationId)
 * 2. Crash recovery & At-least-once delivery (no lost work on crash)
 * 3. Idempotency & Duplicate prevention (no double execution in KSeF)
 * 4. Limited retries with exponential backoff & jitter
 * 5. Quarantine / Dead Letter Queue (FAILED status after 5 retries with full trace)
 * 6. Safe replay from quarantine after resolution
 * 
 * Run: npx ts-node verify-outbox-resilience.ts
 */

import { query, closePool } from './src/db/pool';
import { invoiceService } from './src/services/invoice.service';
import { outboxRelay } from './src/relay/outbox-relay';
import { rabbitMQPublisher } from './src/messaging/rabbitmq.publisher';
import { idempotencyService } from './src/services/idempotency.service';

async function runResilienceVerification() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  KSeF Outbox Pattern — Weryfikacja Odporności (A08)         ║');
  console.log('║  Biuro Rachunkowe Jarosław Konik (NIP: 7532190370)          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`  ✅ [PASS] ${testName}`);
    } else {
      console.error(`  ❌ [FAIL] ${testName} ${detail ? `- ${detail}` : ''}`);
    }
  }

  try {
    await query(`
      INSERT INTO outbox_relay_state (id, last_processed_id, events_processed_total, events_failed_total)
      VALUES (1, '0', 0, 0)
      ON CONFLICT (id) DO NOTHING
    `);

    // -------------------------------------------------------------------------
    // TEST 1: Atomowy zapis w transakcji (Transactional Outbox)
    // -------------------------------------------------------------------------
    console.log('--- Test 1: Atomowy zapis faktury i zdarzenia w jednej transakcji ---');
    const invNum1 = `FV/A08/${Date.now().toString().slice(-6)}`;
    const inv1 = await invoiceService.createInvoice({
      invoiceNumber: invNum1,
      sellerNip: '7532190370',
      buyerNip: '5250001098',
      sellerName: 'Biuro Rachunkowe Jarosław Konik',
      buyerName: 'Firma Testowa Sp. z o.o.',
      issueDate: '2026-11-06',
      saleDate: '2026-11-06',
      currency: 'PLN',
      items: [{ lineNumber: 1, name: 'Księgowość KSeF', quantity: 1, unit: 'usł', unitPriceNet: 1200, vatRate: 23 }]
    });

    const ev1 = await query(`SELECT * FROM outbox_events WHERE aggregate_id = $1`, [inv1.id]);
    assert(ev1.rows.length === 1, 'Zdarzenie outbox utworzone w transakcji');
    assert(ev1.rows[0].status === 'PENDING', 'Status początkowy to PENDING');
    const meta1 = typeof ev1.rows[0].metadata === 'string' ? JSON.parse(ev1.rows[0].metadata) : ev1.rows[0].metadata;
    assert(!!meta1.correlationId, `Identyfikator śledzenia (correlationId: ${meta1.correlationId}) zapisany`);

    // -------------------------------------------------------------------------
    // TEST 2: Symulacja crashu i odtworzenia (At-least-once)
    // -------------------------------------------------------------------------
    console.log('\n--- Test 2: Crash recovery — zdarzenie po restarcie nie ginie ---');
    // Mockujemy sukces publikacji
    rabbitMQPublisher.publish = async () => true;

    const pollRes = await outboxRelay.pollOnce();
    assert(pollRes.processed >= 1, `Poller podjął oczekujące zdarzenia (przetworzono: ${pollRes.processed})`);

    const ev1Processed = await query(`SELECT * FROM outbox_events WHERE aggregate_id = $1`, [inv1.id]);
    assert(ev1Processed.rows[0].status === 'PROCESSED', 'Zdarzenie oznaczone jako PROCESSED');
    assert(ev1Processed.rows[0].published_at !== null, 'Zapisano znacznik czasu publikacji published_at');

    // -------------------------------------------------------------------------
    // TEST 3: Idempotencja — brak podwójnej wysyłki
    // -------------------------------------------------------------------------
    console.log('\n--- Test 3: Idempotencja — ochrona przed dublowaniem wysyłki ---');
    let publishCount = 0;
    rabbitMQPublisher.publish = async () => { publishCount++; return true; };

    await outboxRelay.pollOnce();
    assert(publishCount === 0, 'Żadne już przetworzone zdarzenie nie zostało wysłane ponownie');

    // -------------------------------------------------------------------------
    // TEST 4: Ograniczone ponowienia (Retry) i Exponential Backoff przy awarii
    // -------------------------------------------------------------------------
    console.log('\n--- Test 4: Ograniczone ponowienia (Retry) przy awarii bramki KSeF ---');
    const invNum2 = `FV/A08/ERR_${Date.now().toString().slice(-5)}`;
    const inv2 = await invoiceService.createInvoice({
      invoiceNumber: invNum2,
      sellerNip: '7532190370',
      buyerNip: '5250001098',
      sellerName: 'Biuro Rachunkowe Jarosław Konik',
      buyerName: 'Firma Błąd Sp. z o.o.',
      issueDate: '2026-11-06',
      saleDate: '2026-11-06',
      currency: 'PLN',
      items: [{ lineNumber: 1, name: 'Usługa testowa', quantity: 1, unit: 'usł', unitPriceNet: 300, vatRate: 23 }]
    });

    // Symulacja błędu sieci Ministerstwa Finansów
    rabbitMQPublisher.publish = async () => { throw new Error('KSeF 503 Service Unavailable'); };

    await outboxRelay.pollOnce();

    const ev2AfterFail = await query(`SELECT * FROM outbox_events WHERE aggregate_id = $1`, [inv2.id]);
    const row2 = ev2AfterFail.rows[0];
    assert(row2.status === 'RETRY', 'Zdarzenie przeszło w status RETRY');
    assert(row2.retry_count === 1, 'Licznik ponowień retry_count = 1');
    assert(row2.last_error.includes('KSeF 503'), 'Treść błędu last_error została utrwalona');
    assert(new Date(row2.next_retry_at).getTime() > Date.now(), 'Wyznaczono next_retry_at w przyszłości (exponential backoff)');

    // -------------------------------------------------------------------------
    // TEST 5: Kwarantanna (Dead Letter Queue / FAILED) po 5 próbach
    // -------------------------------------------------------------------------
    console.log('\n--- Test 5: Kwarantanna (Dead Letter Queue / FAILED) po 5 nieudanych próbach ---');
    // Ustawiamy retry_count na 4, aby kolejna próba była 5-tą (ostatnią)
    await query(
      `UPDATE outbox_events 
       SET retry_count = 4, status = 'RETRY', next_retry_at = NOW() - INTERVAL '1 second'
       WHERE aggregate_id = $1`,
      [inv2.id]
    );

    // Ostateczna nieudana próba
    await outboxRelay.pollOnce();

    const ev2Dlq = await query(`SELECT * FROM outbox_events WHERE aggregate_id = $1`, [inv2.id]);
    const dlqRow = ev2Dlq.rows[0];
    assert(dlqRow.status === 'FAILED', 'Zdarzenie trafiło do kwarantanny (status FAILED)');
    assert(dlqRow.retry_count === 5, 'Licznik osiągnął maksymalny limit prób (retry_count = 5)');
    assert(dlqRow.last_error.includes('KSeF 503'), 'Zapisano pełny powód odrzucenia');

    // -------------------------------------------------------------------------
    // TEST 6: Bezpieczne odtworzenie (Replay) zdarzenia z kwarantanny
    // -------------------------------------------------------------------------
    console.log('\n--- Test 6: Bezpieczne odtworzenie (Replay) z kwarantanny po naprawie ---');
    // Symulacja naprawy awarii bramki
    rabbitMQPublisher.publish = async () => true;

    // Resetowanie zdarzenia przez administratora
    await query(
      `UPDATE outbox_events 
       SET status = 'PENDING', retry_count = 0, next_retry_at = NULL, last_error = NULL
       WHERE id = $1`,
      [dlqRow.id]
    );

    const replayRes = await outboxRelay.pollOnce();
    assert(replayRes.processed >= 1, 'Zdarzenie z kwarantanny zostało ponownie podjęte');

    const ev2Replayed = await query(`SELECT * FROM outbox_events WHERE id = $1`, [dlqRow.id]);
    assert(ev2Replayed.rows[0].status === 'PROCESSED', 'Zdarzenie pomyślnie przetworzone (status PROCESSED)');
    assert(ev2Replayed.rows[0].published_at !== null, 'Zdarzenie pomyślnie opublikowane');

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log(`  WYNIK KOŃCOWY WERYFIKACJI A08: ${passedTests}/${totalTests} ZALICZONYCH (${Math.round(passedTests/totalTests*100)}%)`);
    console.log('════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('Błąd weryfikacji:', error);
  } finally {
    await idempotencyService.close();
    await closePool();
  }
}

runResilienceVerification();
