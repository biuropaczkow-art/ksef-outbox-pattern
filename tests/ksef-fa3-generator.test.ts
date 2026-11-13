import { KsefFA3GeneratorService } from '../src/services/ksef-fa3-generator.service';
import { FA3InvoiceData } from '../src/types/fa3';

describe('KSeF FA(3) XML Generator & Validator', () => {
  const sampleSeller = {
    nip: '7532190370', // Biuro Rachunkowe Jarosław Konik
    name: 'Biuro Rachunkowe Jarosław Konik',
    address: {
      countryCode: 'PL',
      addressLine1: 'ul. Jana Pawła II 15',
      postalCode: '48-370',
      city: 'Paczków'
    }
  };

  const sampleBuyer = {
    nip: '5252344078',
    name: 'Klient Korporacyjny Sp. z o.o.',
    address: {
      countryCode: 'PL',
      addressLine1: 'ul. Prosta 20',
      postalCode: '00-850',
      city: 'Warszawa'
    }
  };

  test('Walidacja NIP mod 11 poprawnie rozpoznaje prawomocny NIP i odrzuca błędny', () => {
    expect(KsefFA3GeneratorService.validateNip('7532190370')).toBe(true);
    expect(KsefFA3GeneratorService.validateNip('5252344078')).toBe(true);
    expect(KsefFA3GeneratorService.validateNip('7532190371')).toBe(false);
    expect(KsefFA3GeneratorService.validateNip('12345')).toBe(false);
    expect(KsefFA3GeneratorService.validateNip('')).toBe(false);
  });

  test('Odrzuca fakturę z brakującymi polami obligatoryjnymi (brak NIP sprzedawcy, brak numeru)', () => {
    const invalidData: any = {
      invoiceNumber: '',
      invoiceType: 'VAT',
      issueDate: '2026-11-13',
      saleDate: '2026-11-13',
      currency: 'PLN',
      seller: { name: 'Sprzedawca bez NIP', address: { countryCode: 'PL', addressLine1: 'Test' } },
      buyer: sampleBuyer,
      lines: []
    };

    const res = KsefFA3GeneratorService.generateXml(invalidData);
    expect(res.isValid).toBe(false);
    expect(res.errors).toContain('Brak numeru faktury (P_2).');
    expect(res.errors).toContain('Brak NIP sprzedawcy (Podmiot1).');
    expect(res.errors).toContain('Faktura musi zawierać co najmniej jedną pozycję (FaWiersz).');
  });

  test('Generuje poprawny dokument XML zgodny z FA(3) dla faktury standardowej VAT 23% i 8%', () => {
    const invoiceData: FA3InvoiceData = {
      invoiceNumber: 'FV/2026/11/042',
      invoiceType: 'VAT',
      issueDate: '2026-11-13',
      saleDate: '2026-11-13',
      currency: 'PLN',
      seller: sampleSeller,
      buyer: sampleBuyer,
      lines: [
        {
          lineNumber: 1,
          name: 'Obsługa księgowa KSeF i audyt podatkowy',
          unitOfMeasure: 'usł',
          quantity: 1,
          unitPriceNet: 1000.00,
          totalNet: 1000.00,
          vatRate: 23
        },
        {
          lineNumber: 2,
          name: 'Publikacja i opracowanie biuletynu podatkowego',
          unitOfMeasure: 'szt',
          quantity: 2,
          unitPriceNet: 100.00,
          totalNet: 200.00,
          vatRate: 8
        }
      ],
      paymentMethod: 'Przelew',
      bankAccountNumber: 'PL 10 1050 1445 1000 0090 1234 5678'
    };

    const res = KsefFA3GeneratorService.generateXml(invoiceData);

    expect(res.isValid).toBe(true);
    expect(res.errors.length).toBe(0);
    expect(res.totalNet).toBe(1200.00);
    expect(res.totalVat).toBe(246.00); // 1000*0.23=230, 200*0.08=16 => 246
    expect(res.totalGross).toBe(1446.00);
    expect(res.sha256).toBeDefined();
    expect(res.sha256?.length).toBe(64);

    // Weryfikacja tagów XML
    const xml = res.xml || '';
    expect(xml).toContain('<KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>');
    expect(xml).toContain('<WariantFormularza>3</WariantFormularza>');
    expect(xml).toContain('<NIP>7532190370</NIP>');
    expect(xml).toContain('<Nazwa>Biuro Rachunkowe Jarosław Konik</Nazwa>');
    expect(xml).toContain('<P_1>2026-11-13</P_1>');
    expect(xml).toContain('<P_2>FV/2026/11/042</P_2>');
    expect(xml).toContain('<P_13_1>1000.00</P_13_1>');
    expect(xml).toContain('<P_14_1>230.00</P_14_1>');
    expect(xml).toContain('<P_13_2>200.00</P_13_2>');
    expect(xml).toContain('<P_14_2>16.00</P_14_2>');
    expect(xml).toContain('<P_15>1446.00</P_15>');
    expect(xml).toContain('<RodzajFaktury>VAT</RodzajFaktury>');
    expect(xml).toContain('<NrRB>PL10105014451000009012345678</NrRB>');
  });

  test('Prawidłowo obsługuje i waliduje fakturę korygującą (KOR)', () => {
    const correctionData: FA3InvoiceData = {
      invoiceNumber: 'KOR/2026/11/001',
      invoiceType: 'KOR',
      issueDate: '2026-11-13',
      saleDate: '2026-11-13',
      currency: 'PLN',
      seller: sampleSeller,
      buyer: sampleBuyer,
      correction: {
        correctionReason: 'Udzielenie rabatu potransakcyjnego 10%',
        originalInvoiceNumber: 'FV/2026/11/042',
        originalKsefNumber: '7532190370-20261113-1A2B3C-9F'
      },
      lines: [
        {
          lineNumber: 1,
          name: 'Rabat - Obsługa księgowa KSeF',
          unitOfMeasure: 'usł',
          quantity: 1,
          unitPriceNet: -100.00,
          totalNet: -100.00,
          vatRate: 23
        }
      ]
    };

    const res = KsefFA3GeneratorService.generateXml(correctionData);
    expect(res.isValid).toBe(true);
    expect(res.totalNet).toBe(-100.00);
    expect(res.totalVat).toBe(-23.00);
    expect(res.totalGross).toBe(-123.00);

    const xml = res.xml || '';
    expect(xml).toContain('<RodzajFaktury>KOR</RodzajFaktury>');
    expect(xml).toContain('<PrzyczynaKorekty>Udzielenie rabatu potransakcyjnego 10%</PrzyczynaKorekty>');
    expect(xml).toContain('<NrFaKorygowanej>FV/2026/11/042</NrFaKorygowanej>');
    expect(xml).toContain('<NrKSeFFaKorygowanej>7532190370-20261113-1A2B3C-9F</NrKSeFFaKorygowanej>');
  });

  test('Faktura korygująca bez wskazania numeru faktury pierwotnej zostaje odrzucona', () => {
    const invalidCorrection: FA3InvoiceData = {
      invoiceNumber: 'KOR/2026/11/002',
      invoiceType: 'KOR',
      issueDate: '2026-11-13',
      saleDate: '2026-11-13',
      currency: 'PLN',
      seller: sampleSeller,
      buyer: sampleBuyer,
      correction: {
        correctionReason: 'Korekta bez numeru pierwotnego',
        originalInvoiceNumber: ''
      },
      lines: [
        {
          lineNumber: 1,
          name: 'Pozycja',
          unitOfMeasure: 'szt',
          quantity: 1,
          unitPriceNet: -50,
          totalNet: -50,
          vatRate: 23
        }
      ]
    };

    const res = KsefFA3GeneratorService.generateXml(invalidCorrection);
    expect(res.isValid).toBe(false);
    expect(res.errors).toContain('Faktura korygująca wymaga wskazania numeru faktury korygowanej (NrFaKorygowanej).');
  });

  test('Generowanie SHA-256 jest w pełni deterministyczne dla tego samego payloadu', () => {
    const invoiceData: FA3InvoiceData = {
      invoiceNumber: 'FV/DET/001',
      invoiceType: 'VAT',
      issueDate: '2026-11-13',
      saleDate: '2026-11-13',
      currency: 'PLN',
      seller: sampleSeller,
      buyer: sampleBuyer,
      lines: [
        {
          lineNumber: 1,
          name: 'Test determinizmu',
          unitOfMeasure: 'szt',
          quantity: 1,
          unitPriceNet: 50.00,
          totalNet: 50.00,
          vatRate: 23
        }
      ]
    };

    const res1 = KsefFA3GeneratorService.generateXml(invoiceData);
    const res2 = KsefFA3GeneratorService.generateXml(invoiceData);

    expect(res1.isValid).toBe(true);
    expect(res2.isValid).toBe(true);
    expect(res1.sha256).toBeDefined();
    expect(res2.sha256).toBeDefined();
    expect(res1.sha256?.length).toBe(64);
    expect(res1.sha256).toEqual(res2.sha256);
  });
});
