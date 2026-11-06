/**
 * Standalone verification script for BookedFileValidator.
 * Tests all 4 double-accounting hazards defined in audit requirement A06:
 * 1. New document ingestion -> ACCEPTED
 * 2. Exact file duplicate (same content hash) -> DUPLICATE_FILE
 * 3. Business duplicate (same invoice number + NIP, different file content) -> DUPLICATE_INVOICE
 * 4. Concurrent race conditions (5 simultaneous uploads) -> exactly 1 succeeds, 4 rejected
 * 
 * Run: npx ts-node verify-validator.ts
 */

import { BookedFileValidator } from './src/services/booked-file-validator.service';
import { DocumentInput } from './src/types/validator';

async function runValidatorVerification() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Walidator Przeciwko Podwójnemu Księgowaniu - Weryfikacja   ║');
  console.log('║  Biuro Rachunkowe Jarosław Konik (NIP: 7532190370)          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const validator = new BookedFileValidator();
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

  // Sample documents
  const sampleDoc1: DocumentInput = {
    fileName: 'faktura_2026_001.xml',
    fileContent: '<Faktura><Naglowek><Nr>FV/2026/001</Nr><Data>2026-11-06</Data></Naglowek><Kwota>1230.00</Kwota></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'FV/2026/001',
    issueDate: '2026-11-06',
    totalGross: 1230.00,
    currency: 'PLN',
  };

  // Test 1: Pierwsze wgranie pliku
  console.log('--- Test 1: Księgowanie nowego dokumentu ---');
  const res1 = await validator.validateAndBookDocument(sampleDoc1);
  assert(res1.isValid === true, 'Nowy dokument jest poprawny');
  assert(res1.status === 'ACCEPTED', 'Status nowego dokumentu to ACCEPTED');
  assert(res1.documentRecord !== undefined, 'Dokument został zarejestrowany');
  console.log(`   SHA-256: ${res1.fileHash}`);
  console.log(`   Komunikat: ${res1.message}\n`);

  // Test 2: Ponowne wgranie identycznego pliku (ten sam hash SHA-256)
  console.log('--- Test 2: Próba ponownego wgrania identycznego pliku (ten sam hash) ---');
  const res2 = await validator.validateAndBookDocument(sampleDoc1);
  assert(res2.isValid === false, 'Duplikat pliku jest odrzucony (isValid = false)');
  assert(res2.status === 'DUPLICATE_FILE', 'Status to DUPLICATE_FILE');
  assert(res2.conflictDetails?.originalInvoiceNumber === 'FV/2026/001', 'Wykryto powiązanie z pierwotną fakturą');
  console.log(`   Powód odrzucenia: ${res2.message}\n`);

  // Test 3: Wgranie innego pliku (zmieniona treść/komentarz), ale z tym samym numerem faktury i NIP sprzedawcy
  console.log('--- Test 3: Wgranie innego pliku z tym samym numerem faktury (duplikat biznesowy) ---');
  const sampleDocModifiedContent: DocumentInput = {
    fileName: 'skan_faktury_001_v2.pdf',
    // Inna treść -> inny hash SHA-256
    fileContent: '%PDF-1.4 [Skan z pieczątką] Faktura FV/2026/001 data 2026-11-06',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'FV/2026/001', // Ten sam numer faktury!
    issueDate: '2026-11-06',     // Ta sama data!
    totalGross: 1230.00,
    currency: 'PLN',
  };
  const res3 = await validator.validateAndBookDocument(sampleDocModifiedContent);
  assert(res3.isValid === false, 'Duplikat biznesowy jest odrzucony');
  assert(res3.status === 'DUPLICATE_INVOICE', 'Status to DUPLICATE_INVOICE');
  console.log(`   Powód odrzucenia: ${res3.message}\n`);

  // Test 4: Wgranie kolejnej poprawnej faktury o innym numerze
  console.log('--- Test 4: Wgranie innej niezależnej faktury ---');
  const sampleDoc2: DocumentInput = {
    fileName: 'faktura_2026_002.xml',
    fileContent: '<Faktura><Naglowek><Nr>FV/2026/002</Nr><Data>2026-11-06</Data></Naglowek><Kwota>2460.00</Kwota></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '9876543210',
    invoiceNumber: 'FV/2026/002',
    issueDate: '2026-11-06',
    totalGross: 2460.00,
    currency: 'PLN',
  };
  const res4 = await validator.validateAndBookDocument(sampleDoc2);
  assert(res4.isValid === true, 'Nowa niezależna faktura została zaksięgowana');
  assert(res4.status === 'ACCEPTED', 'Status FV/2026/002 to ACCEPTED\n');

  // Test 5: Współbieżność - symulacja 5 jednoczesnych uploadów tego samego pliku (race condition)
  console.log('--- Test 5: Odporność na wyścig (5 równoległych uploadów w tym samym ułamku sekundy) ---');
  const concurrentDoc: DocumentInput = {
    fileName: 'concurrent_burst_003.xml',
    fileContent: '<Faktura><Nr>FV/2026/003-BURST</Nr></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '1112223344',
    invoiceNumber: 'FV/2026/003',
    issueDate: '2026-11-06',
    totalGross: 500.00,
    currency: 'PLN',
  };

  const parallelPromises = Array.from({ length: 5 }, () => 
    validator.validateAndBookDocument({ ...concurrentDoc })
  );

  const results = await Promise.all(parallelPromises);
  const acceptedCount = results.filter(r => r.status === 'ACCEPTED').length;
  const rejectedCount = results.filter(r => r.status !== 'ACCEPTED').length;

  console.log(`   Wynik równoległego przetwarzania: ${acceptedCount} zaakceptowany, ${rejectedCount} odrzuconych.`);
  assert(acceptedCount === 1, 'Dokładnie JEDNO żądanie zostało zaksięgowane');
  assert(rejectedCount === 4, 'Pozostałe 4 żądania zostały zablokowane i odrzucone');

  // Podsumowanie
  console.log('\n================================================================');
  console.log(`Wynik testów walidatora: ${passedTests}/${totalTests} ZDANYCH`);
  console.log('================================================================');

  if (passedTests === totalTests) {
    console.log('🎉 WSZYSTKIE TESTY WALIDATORA ZAKOŃCZONE SUKCESEM!');
    process.exit(0);
  } else {
    console.error('❌ Niektóre testy nie powiodły się.');
    process.exit(1);
  }
}

runValidatorVerification().catch(err => {
  console.error('Błąd krytyczny testu walidatora:', err);
  process.exit(1);
});
