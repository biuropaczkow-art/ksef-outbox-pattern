/**
 * Standalone verification script for KSeF FA(3) Corrections.
 * Tests:
 * 1. Base VAT invoice ingestion -> ACCEPTED
 * 2. Correction invoice (KOR) without original reference -> INVALID_CORRECTION_REFERENCE (rejected)
 * 3. Valid correction invoice (KOR) referencing original KSeF number -> ACCEPTED
 * 4. Duplicate correction file upload (same hash) -> DUPLICATE_FILE (rejected)
 * 5. Duplicate correction business key -> DUPLICATE_INVOICE (rejected)
 * 6. Second valid correction for different invoice -> ACCEPTED
 * 7. Concurrency race conditions (5 parallel requests for same correction) -> exactly 1 succeeds, 4 rejected
 * 
 * Run: npx ts-node verify-corrections.ts
 */

import { BookedFileValidator } from './src/services/booked-file-validator.service';
import { DocumentInput } from './src/types/validator';

async function runCorrectionVerification() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  KSeF FA(3) Obsługa Korekt w Locie - Weryfikacja            ║');
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

  // Dokument 1: Faktura pierwotna VAT
  const baseInvoice: DocumentInput = {
    fileName: 'faktura_vat_2026_100.xml',
    fileContent: '<Faktura><Naglowek><RodzajFaktury>VAT</RodzajFaktury><Nr>FV/2026/100</Nr></Naglowek><Kwota>2460.00</Kwota></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'FV/2026/100',
    issueDate: '2026-11-10',
    totalGross: 2460.00,
    currency: 'PLN',
    documentType: 'INVOICE',
  };

  console.log('--- Test 1: Zaksięgowanie faktury pierwotnej VAT ---');
  const res1 = await validator.validateAndBookDocument(baseInvoice);
  assert(res1.isValid === true, 'Faktura pierwotna jest poprawna');
  assert(res1.status === 'ACCEPTED', 'Status faktury pierwotnej to ACCEPTED');
  console.log(`   SHA-256: ${res1.fileHash}`);
  console.log(`   Komunikat: ${res1.message}\n`);

  // Dokument 2: Korekta bez referencji (błąd schematu KSeF)
  console.log('--- Test 2: Próba wystawienia korekty bez referencji do faktury pierwotnej ---');
  const invalidCorrection: DocumentInput = {
    fileName: 'korekta_bledna.xml',
    fileContent: '<Faktura><Naglowek><RodzajFaktury>KOR</RodzajFaktury><Nr>KOR/2026/001</Nr></Naglowek></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'KOR/2026/001',
    issueDate: '2026-11-13',
    totalGross: -460.00,
    currency: 'PLN',
    documentType: 'CORRECTION',
    // brak originalKsefNumber i originalInvoiceNumber
  };

  const res2 = await validator.validateAndBookDocument(invalidCorrection);
  assert(res2.isValid === false, 'Korekta bez referencji została odrzucona');
  assert(res2.status === 'INVALID_CORRECTION_REFERENCE', 'Status to INVALID_CORRECTION_REFERENCE');
  console.log(`   Powód: ${res2.message}\n`);

  // Dokument 3: Poprawna korekta z numerem KSeF faktury pierwotnej
  console.log('--- Test 3: Wystawienie poprawnej korekty KSeF FA(3) z numerem KSeF ---');
  const validCorrection: DocumentInput = {
    fileName: 'korekta_kor_2026_001.xml',
    fileContent: '<Faktura><Naglowek><RodzajFaktury>KOR</RodzajFaktury><Nr>KOR/2026/001</Nr><NrKSeFFaKorygowanej>7532190370-20261110-123456-AB</NrKSeFFaKorygowanej><PrzyczynaKorekty>Zwrot towaru</PrzyczynaKorekty></Naglowek></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'KOR/2026/001',
    issueDate: '2026-11-13',
    totalGross: -460.00,
    currency: 'PLN',
    documentType: 'CORRECTION',
    originalKsefNumber: '7532190370-20261110-123456-AB',
    originalInvoiceNumber: 'FV/2026/100',
    correctionReason: 'Zwrot części towaru przez nabywcę',
  };

  const res3 = await validator.validateAndBookDocument(validCorrection);
  assert(res3.isValid === true, 'Poprawna korekta KSeF została zaakceptowana');
  assert(res3.status === 'ACCEPTED', 'Status korekty to ACCEPTED');
  assert(res3.documentRecord?.originalKsefNumber === '7532190370-20261110-123456-AB', 'Zapisano numer KSeF faktury korygowanej');
  console.log(`   Komunikat: ${res3.message}\n`);

  // Dokument 4: Duplikat pliku korekty
  console.log('--- Test 4: Próba ponownego wgrania identycznego pliku korekty (ten sam SHA-256) ---');
  const res4 = await validator.validateAndBookDocument(validCorrection);
  assert(res4.isValid === false, 'Duplikat pliku korekty został zablokowany');
  assert(res4.status === 'DUPLICATE_FILE', 'Status to DUPLICATE_FILE');
  console.log(`   Powód: ${res4.message}\n`);

  // Dokument 5: Duplikat biznesowy korekty (inny plik, ten sam numer korekty i referencja)
  console.log('--- Test 5: Próba wgrania innego pliku o tym samym numerze korekty ---');
  const duplicateBizCorrection: DocumentInput = {
    ...validCorrection,
    fileName: 'korekta_kor_2026_001_v2.xml',
    fileContent: '<Faktura><InnaZawartosc>123</InnaZawartosc></Faktura>',
  };

  const res5 = await validator.validateAndBookDocument(duplicateBizCorrection);
  assert(res5.isValid === false, 'Duplikat biznesowy korekty został zablokowany');
  assert(res5.status === 'DUPLICATE_INVOICE', 'Status to DUPLICATE_INVOICE');
  console.log(`   Powód: ${res5.message}\n`);

  // Dokument 6: Druga niezależna korekta (KOR/2026/002)
  console.log('--- Test 6: Wystawienie kolejnej niezależnej korekty KOR/2026/002 ---');
  const validCorrection2: DocumentInput = {
    fileName: 'korekta_kor_2026_002.xml',
    fileContent: '<Faktura><Naglowek><RodzajFaktury>KOR</RodzajFaktury><Nr>KOR/2026/002</Nr><NrKSeFFaKorygowanej>7532190370-20261111-999999-CD</NrKSeFFaKorygowanej></Naglowek></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'KOR/2026/002',
    issueDate: '2026-11-13',
    totalGross: -100.00,
    currency: 'PLN',
    documentType: 'CORRECTION',
    originalKsefNumber: '7532190370-20261111-999999-CD',
    originalInvoiceNumber: 'FV/2026/101',
    correctionReason: 'Udzielenie rabatu potransakcyjnego',
  };

  const res6 = await validator.validateAndBookDocument(validCorrection2);
  assert(res6.isValid === true, 'Druga korekta została zaakceptowana');
  assert(res6.status === 'ACCEPTED', 'Status to ACCEPTED\n');

  // Dokument 7: Test współbieżności (5 jednoczesnych żądań w tej samej milisekundzie)
  console.log('--- Test 7: Ochrona przed wyścigiem (5 jednoczesnych uploadów korekty) ---');
  const parallelCorrectionDoc: DocumentInput = {
    fileName: 'korekta_parallel.xml',
    fileContent: '<Faktura><Naglowek><RodzajFaktury>KOR</RodzajFaktury><Nr>KOR/2026/003</Nr><NrKSeFFaKorygowanej>7532190370-20261112-777777-EF</NrKSeFFaKorygowanej></Naglowek></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'KOR/2026/003',
    issueDate: '2026-11-13',
    totalGross: -50.00,
    currency: 'PLN',
    documentType: 'CORRECTION',
    originalKsefNumber: '7532190370-20261112-777777-EF',
  };

  const parallelPromises = Array.from({ length: 5 }, () => 
    validator.validateAndBookDocument(parallelCorrectionDoc)
  );

  const parallelResults = await Promise.all(parallelPromises);
  const acceptedCount = parallelResults.filter(r => r.status === 'ACCEPTED').length;
  const rejectedCount = parallelResults.filter(r => r.status !== 'ACCEPTED').length;

  console.log(`   Wynik równoległego przetwarzania: ${acceptedCount} zaakceptowany, ${rejectedCount} odrzuconych.`);
  assert(acceptedCount === 1, 'Dokładnie JEDNA korekta została zaksięgowana');
  assert(rejectedCount === 4, 'Pozostałe 4 równoległe żądania zostały zablokowane i odrzucone');

  console.log('\n================================================================');
  console.log(`Wynik testów obsługi korekt KSeF: ${passedTests}/${totalTests} ZDANYCH`);
  console.log('================================================================');
  if (passedTests === totalTests) {
    console.log('🎉 WSZYSTKIE TESTY ASYNCHRONICZNYCH KOREKT KSEF ZAKOŃCZONE SUKCESEM!\n');
    process.exit(0);
  } else {
    console.error('❌ WYKRYTO BŁĘDY W TESTACH KOREKT.');
    process.exit(1);
  }
}

runCorrectionVerification().catch(err => {
  console.error('Błąd wykonania weryfikacji korekt:', err);
  process.exit(1);
});
