import { BookedFileValidator } from '../src/services/booked-file-validator.service';
import { DocumentInput } from '../src/types/validator';
import { idempotencyService } from '../src/services/idempotency.service';

describe('BookedFileValidator - Walidator podwójnego księgowania', () => {
  let validator: BookedFileValidator;

  beforeEach(() => {
    validator = new BookedFileValidator();
    validator.resetRegistry();
  });

  afterAll(async () => {
    await idempotencyService.close();
  });

  const baseDoc: DocumentInput = {
    fileName: 'faktura_vat_001.xml',
    fileContent: '<Faktura><Numer>FV/2026/001</Numer><NIP>7532190370</NIP><Kwota>1230.00</Kwota></Faktura>',
    sellerNip: '7532190370',
    buyerNip: '5250001098',
    invoiceNumber: 'FV/2026/001',
    issueDate: '2026-11-06',
    totalGross: 1230.00,
    currency: 'PLN',
  };

  test('Scenariusz 1: Nowy dokument przechodzi pomyślnie z wynikiem ACCEPTED', async () => {
    const res = await validator.validateAndBookDocument(baseDoc);

    expect(res.isValid).toBe(true);
    expect(res.status).toBe('ACCEPTED');
    expect(res.documentRecord).toBeDefined();
    expect(res.documentRecord?.invoiceNumber).toBe('FV/2026/001');
    expect(res.fileHash).toHaveLength(64); // SHA-256 hex length
  });

  test('Scenariusz 2: Ponowny upload identycznego pliku (ten sam hash SHA-256) jest odrzucany z kodem DUPLICATE_FILE', async () => {
    // Pierwszy upload
    await validator.validateAndBookDocument(baseDoc);

    // Ponowny upload
    const duplicateRes = await validator.validateAndBookDocument(baseDoc);

    expect(duplicateRes.isValid).toBe(false);
    expect(duplicateRes.status).toBe('DUPLICATE_FILE');
    expect(duplicateRes.conflictDetails?.originalInvoiceNumber).toBe('FV/2026/001');
    expect(duplicateRes.conflictDetails?.reason).toContain('wcześniej wgrany');
  });

  test('Scenariusz 3: Plik o innej zawartości, ale z tym samym numerem faktury i NIP jest odrzucany z kodem DUPLICATE_INVOICE', async () => {
    // Pierwszy dokument
    await validator.validateAndBookDocument(baseDoc);

    // Drugi plik (inny nagłówek/komentarz w XML, inny hash), ale ten sam numer faktury i kontrahent
    const modifiedFileDoc: DocumentInput = {
      ...baseDoc,
      fileName: 'FV_001_skan_papierowy.pdf',
      fileContent: '%PDF-1.4 Inna reprezentacja binarna tej samej faktury FV/2026/001',
    };

    const duplicateInvoiceRes = await validator.validateAndBookDocument(modifiedFileDoc);

    expect(duplicateInvoiceRes.isValid).toBe(false);
    expect(duplicateInvoiceRes.status).toBe('DUPLICATE_INVOICE');
    expect(duplicateInvoiceRes.conflictDetails?.originalInvoiceNumber).toBe('FV/2026/001');
    expect(duplicateInvoiceRes.conflictDetails?.reason).toContain('o tym numerze');
  });

  test('Scenariusz 4: Inna poprawna faktura przechodzi bez zakłóceń', async () => {
    await validator.validateAndBookDocument(baseDoc);

    const secondDoc: DocumentInput = {
      fileName: 'faktura_vat_002.xml',
      fileContent: '<Faktura><Numer>FV/2026/002</Numer><NIP>7532190370</NIP><Kwota>4500.00</Kwota></Faktura>',
      sellerNip: '7532190370',
      buyerNip: '1112223344',
      invoiceNumber: 'FV/2026/002',
      issueDate: '2026-11-06',
      totalGross: 4500.00,
      currency: 'PLN',
    };

    const res2 = await validator.validateAndBookDocument(secondDoc);

    expect(res2.isValid).toBe(true);
    expect(res2.status).toBe('ACCEPTED');
  });

  test('Scenariusz 5: Równoległe zgłoszenia (5 jednoczesnych requestów) księgują dokładnie 1 raz', async () => {
    const burstDoc: DocumentInput = {
      fileName: 'burst_004.xml',
      fileContent: '<Faktura><Numer>FV/2026/004-BURST</Numer></Faktura>',
      sellerNip: '7532190370',
      buyerNip: '9988776655',
      invoiceNumber: 'FV/2026/004',
      issueDate: '2026-11-06',
      totalGross: 990.00,
      currency: 'PLN',
    };

    const results = await Promise.all([
      validator.validateAndBookDocument({ ...burstDoc }),
      validator.validateAndBookDocument({ ...burstDoc }),
      validator.validateAndBookDocument({ ...burstDoc }),
      validator.validateAndBookDocument({ ...burstDoc }),
      validator.validateAndBookDocument({ ...burstDoc }),
    ]);

    const accepted = results.filter(r => r.status === 'ACCEPTED');
    const rejected = results.filter(r => r.status !== 'ACCEPTED');

    expect(accepted.length).toBe(1);
    expect(rejected.length).toBe(4);
  });
});
