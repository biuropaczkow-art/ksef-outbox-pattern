import { UpoConsumerService } from '../src/services/upo-consumer.service';
import { KsefStatusCheckResponse } from '../src/types/upo';

describe('KSeF 2.0 UPO Consumer & Session Status Poller', () => {
  let service: UpoConsumerService;

  beforeEach(() => {
    service = new UpoConsumerService();
  });

  const invoiceId = 'inv-uuid-12345';
  const invoiceNumber = 'FV/2026/11/042';
  const sellerNip = '7532190370';

  test('Prawidłowo przetwarza status 200 (Sukces) i archiwizuje Urzędowe Poświadczenie Odbioru', () => {
    const ksefRef = '7532190370-20261113-1A2B3C-9F';
    const timestamp = '2026-11-13T15:00:00Z';
    
    const response: KsefStatusCheckResponse = {
      sessionReferenceNumber: 'sess-abc-123',
      processingCode: 200,
      processingDescription: 'Faktura przyjeta i zarejestrowana',
      timestamp,
      ksefReferenceNumber: ksefRef
    };

    const res = service.processSessionResponse(invoiceId, invoiceNumber, sellerNip, response);

    expect(res.status).toBe('ACCEPTED');
    expect(res.ksefReferenceNumber).toBe(ksefRef);
    expect(res.upoHash).toBeDefined();
    expect(res.upoHash?.length).toBe(64);

    // Sprawdzenie w rejestrze archiwalnym
    const archived = service.getArchivedUpo(ksefRef);
    expect(archived).toBeDefined();
    expect(archived?.invoiceNumber).toBe(invoiceNumber);
    expect(archived?.sellerNip).toBe(sellerNip);
    expect(archived?.upoXml).toContain('<KodStatusu>200</KodStatusu>');
    expect(archived?.upoXml).toContain(`<NumerKSeF>${ksefRef}</NumerKSeF>`);
  });

  test('Status 100 (W toku) zwraca PENDING z czasem retry zgodnym z exponential backoff', () => {
    const response: KsefStatusCheckResponse = {
      sessionReferenceNumber: 'sess-abc-123',
      processingCode: 100,
      processingDescription: 'Trwa weryfikacja semantyczna w bramce MF',
      timestamp: new Date().toISOString()
    };

    const resAttempt1 = service.processSessionResponse(invoiceId, invoiceNumber, sellerNip, response, 1);
    expect(resAttempt1.status).toBe('PENDING');
    expect(resAttempt1.retryAfterMs).toBeGreaterThanOrEqual(1000);

    const resAttempt3 = service.processSessionResponse(invoiceId, invoiceNumber, sellerNip, response, 3);
    expect(resAttempt3.status).toBe('PENDING');
    // Dla próby 3 (base: 1000 * 2^2 = 4000ms + jitter)
    expect(resAttempt3.retryAfterMs).toBeGreaterThanOrEqual(4000);
  });

  test('Status 422 (Odrzucenie semantyczne) zwraca natychmiastowe REJECTED bez kolejnych prób', () => {
    const response: KsefStatusCheckResponse = {
      sessionReferenceNumber: 'sess-abc-123',
      processingCode: 422,
      processingDescription: 'Blad walidacji schemy FA(3)',
      timestamp: new Date().toISOString(),
      errors: [
        { code: 21415, description: 'Nieprawidlowa suma kwot pozycji faktury w wezle P_15' }
      ]
    };

    const res = service.processSessionResponse(invoiceId, invoiceNumber, sellerNip, response);
    expect(res.status).toBe('REJECTED');
    expect(res.error).toContain('21415');
    expect(res.error).toContain('Nieprawidlowa suma kwot pozycji faktury w wezle P_15');
    expect(res.retryAfterMs).toBeUndefined();
  });

  test('Awarie tymczasowe bramki (np. kod 500) ponawiają próby, a po przekroczeniu limitu przechodzą w stan FAILED', () => {
    const response500: KsefStatusCheckResponse = {
      sessionReferenceNumber: 'sess-abc-123',
      processingCode: 500,
      processingDescription: 'Internal Server Error KSeF Gateway',
      timestamp: new Date().toISOString()
    };

    // Próba 2/5 -> PENDING z ponowieniem
    const resPending = service.processSessionResponse(invoiceId, invoiceNumber, sellerNip, response500, 2);
    expect(resPending.status).toBe('PENDING');
    expect(resPending.retryAfterMs).toBeDefined();

    // Próba 5/5 -> FAILED (przeniesienie do DLQ)
    const resFailed = service.processSessionResponse(invoiceId, invoiceNumber, sellerNip, response500, 5);
    expect(resFailed.status).toBe('FAILED');
    expect(resFailed.error).toContain('Przekroczono maksymalną liczbę prób');
  });

  test('Generowanie oficjalnego XML UPO zawiera wymagane węzły i jest deterministyczne', () => {
    const ksefRef = '7532190370-20261113-DEADBEEF-01';
    const invoiceHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const fixedDate = '2026-11-13T12:00:00Z';

    const xml = service.generateOfficialUpo(ksefRef, sellerNip, invoiceNumber, invoiceHash, fixedDate);
    expect(xml).toContain('<NumerKSeF>7532190370-20261113-DEADBEEF-01</NumerKSeF>');
    expect(xml).toContain('<NumerIdentyfikacyjnyPodmiotu>7532190370</NumerIdentyfikacyjnyPodmiotu>');
    expect(xml).toContain(`<SkrotDokumentu>${invoiceHash}</SkrotDokumentu>`);
    expect(xml).toContain('<KodStatusu>200</KodStatusu>');

    const hash1 = service.computeUpoHash(xml);
    const hash2 = service.computeUpoHash(xml);
    expect(hash1).toEqual(hash2);
    expect(hash1.length).toBe(64);
  });
});
