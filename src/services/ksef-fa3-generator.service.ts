import crypto from 'crypto';
import { 
  FA3InvoiceData, 
  FA3ValidationResult, 
  FA3InvoiceLine 
} from '../types/fa3';

export class KsefFA3GeneratorService {
  private static readonly SCHEMA_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13380/';
  private static readonly SYSTEM_INFO = 'Biuro Rachunkowe Jaroslaw Konik — KSeF FA(3) Outbox Relay';

  /**
   * Walidacja sumy kontrolnej NIP algorytmem wagowym mod 11 (Ministerstwo Finansów)
   */
  public static validateNip(nip: string): boolean {
    const cleaned = (nip || '').replace(/[^0-9]/g, '');
    if (cleaned.length !== 10) return false;

    const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    const sum = weights.reduce((acc, weight, idx) => acc + weight * parseInt(cleaned[idx], 10), 0);
    const controlDigit = sum % 11;

    return controlDigit === parseInt(cleaned[9], 10);
  }

  /**
   * Bezpieczna sanityzacja tekstu XML (escaping & < > " ')
   */
  public static escapeXml(text: string): string {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Formatowanie kwot z 2 miejscami po przecinku
   */
  public static formatAmount(amount: number): string {
    return Number(amount || 0).toFixed(2);
  }

  /**
   * Walidacja struktury i spójności danych merytorycznych przed wygenerowaniem schemy FA(3)
   */
  public static validate(data: FA3InvoiceData): FA3ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Sprawdzenie identyfikatorów i dat
    if (!data.invoiceNumber || !data.invoiceNumber.trim()) {
      errors.push('Brak numeru faktury (P_2).');
    }
    if (!data.issueDate || isNaN(Date.parse(data.issueDate))) {
      errors.push('Niepoprawna lub brakująca data wystawienia faktury (P_1).');
    }
    if (!data.saleDate || isNaN(Date.parse(data.saleDate))) {
      errors.push('Niepoprawna lub brakująca data sprzedaży (P_6).');
    }
    if (!data.currency || data.currency.length !== 3) {
      errors.push('Niepoprawny kod waluty ISO (KodWaluty, wymagane np. PLN, EUR).');
    }

    // 2. Walidacja Sprzedawcy (Podmiot1)
    if (!data.seller || !data.seller.nip) {
      errors.push('Brak NIP sprzedawcy (Podmiot1).');
    } else if (!this.validateNip(data.seller.nip)) {
      errors.push(`NIP sprzedawcy ${data.seller.nip} nie przechodzi walidacji sumy kontrolnej mod 11.`);
    }
    if (!data.seller?.name || !data.seller.name.trim()) {
      errors.push('Brak nazwy sprzedawcy (Podmiot1).');
    }

    // 3. Walidacja Nabywcy (Podmiot2)
    if (!data.buyer?.name || !data.buyer.name.trim()) {
      errors.push('Brak nazwy nabywcy (Podmiot2).');
    }
    if (data.buyer?.nip && !this.validateNip(data.buyer.nip)) {
      warnings.push(`NIP nabywcy ${data.buyer.nip} może być zagraniczny lub nie przechodzi mod 11.`);
    }

    // 4. Walidacja pozycji faktury
    if (!data.lines || data.lines.length === 0) {
      errors.push('Faktura musi zawierać co najmniej jedną pozycję (FaWiersz).');
    }

    // 5. Specyfika faktury korygującej (KOR)
    if (data.invoiceType === 'KOR') {
      if (!data.correction?.correctionReason) {
        errors.push('Faktura korygująca wymaga podania przyczyny korekty (PrzyczynaKorekty).');
      }
      if (!data.correction?.originalInvoiceNumber) {
        errors.push('Faktura korygująca wymaga wskazania numeru faktury korygowanej (NrFaKorygowanej).');
      }
    }

    // Wyliczenie sum stawek VAT
    let totalNet = 0;
    let totalVat = 0;

    for (const line of (data.lines || [])) {
      const lineNet = Number(line.totalNet || (line.quantity * line.unitPriceNet));
      const vatRate = Number(line.vatRate || 0);
      const lineVat = Number((lineNet * vatRate / 100).toFixed(2));

      totalNet += lineNet;
      totalVat += lineVat;
    }

    totalNet = Number(totalNet.toFixed(2));
    totalVat = Number(totalVat.toFixed(2));
    const totalGross = Number((totalNet + totalVat).toFixed(2));

    return {
      isValid: errors.length === 0,
      totalNet,
      totalVat,
      totalGross,
      errors,
      warnings
    };
  }

  /**
   * Generuje poprawny dokument XML zgodny ze specyfikacją KSeF FA(3)
   */
  public static generateXml(data: FA3InvoiceData): FA3ValidationResult {
    const val = this.validate(data);
    if (!val.isValid) {
      return val;
    }

    const genTimestamp = new Date().toISOString();
    const sellerNip = (data.seller.nip || '').replace(/[^0-9]/g, '');
    const buyerNip = data.buyer.nip ? data.buyer.nip.replace(/[^0-9]/g, '') : null;

    // Agregaty stawek VAT
    let p13_1 = 0; // Netto 23%
    let p14_1 = 0; // VAT 23%
    let p13_2 = 0; // Netto 8%
    let p14_2 = 0; // VAT 8%
    let p13_3 = 0; // Netto 5%
    let p14_3 = 0; // VAT 5%
    let p13_6 = 0; // Zwolnione / 0%

    for (const line of data.lines) {
      const net = Number(line.totalNet || (line.quantity * line.unitPriceNet));
      const rate = Number(line.vatRate || 0);
      const vat = Number((net * rate / 100).toFixed(2));

      if (rate === 23) {
        p13_1 += net;
        p14_1 += vat;
      } else if (rate === 8) {
        p13_2 += net;
        p14_2 += vat;
      } else if (rate === 5) {
        p13_3 += net;
        p14_3 += vat;
      } else {
        p13_6 += net;
      }
    }

    // Budowa struktury XML FA(3)
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<Faktura xmlns="${this.SCHEMA_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n`;
    
    // Nagłówek
    xml += `  <Naglowek>\n`;
    xml += `    <KodFormularza kodSystemowy="FA (3)" wersjaSchemy="1-0E">FA</KodFormularza>\n`;
    xml += `    <WariantFormularza>3</WariantFormularza>\n`;
    xml += `    <DataWytworzeniaFa>${genTimestamp}</DataWytworzeniaFa>\n`;
    xml += `    <SystemInfo>${this.escapeXml(this.SYSTEM_INFO)}</SystemInfo>\n`;
    xml += `  </Naglowek>\n`;

    // Podmiot1 (Sprzedawca)
    xml += `  <Podmiot1>\n`;
    xml += `    <PrefiksPodatnika>PL</PrefiksPodatnika>\n`;
    xml += `    <DaneIdentyfikacyjne>\n`;
    xml += `      <NIP>${sellerNip}</NIP>\n`;
    xml += `      <Nazwa>${this.escapeXml(data.seller.name)}</Nazwa>\n`;
    xml += `    </DaneIdentyfikacyjne>\n`;
    xml += `    <Adres>\n`;
    xml += `      <KodKraju>${this.escapeXml(data.seller.address.countryCode || 'PL')}</KodKraju>\n`;
    xml += `      <AdresL1>${this.escapeXml(data.seller.address.addressLine1)}</AdresL1>\n`;
    if (data.seller.address.postalCode && data.seller.address.city) {
      xml += `      <AdresL2>${this.escapeXml(`${data.seller.address.postalCode} ${data.seller.address.city}`)}</AdresL2>\n`;
    }
    xml += `    </Adres>\n`;
    xml += `  </Podmiot1>\n`;

    // Podmiot2 (Nabywca)
    xml += `  <Podmiot2>\n`;
    xml += `    <DaneIdentyfikacyjne>\n`;
    if (buyerNip) {
      xml += `      <NIP>${buyerNip}</NIP>\n`;
    } else {
      xml += `      <BrakID>1</BrakID>\n`;
    }
    xml += `      <Nazwa>${this.escapeXml(data.buyer.name)}</Nazwa>\n`;
    xml += `    </DaneIdentyfikacyjne>\n`;
    xml += `    <Adres>\n`;
    xml += `      <KodKraju>${this.escapeXml(data.buyer.address.countryCode || 'PL')}</KodKraju>\n`;
    xml += `      <AdresL1>${this.escapeXml(data.buyer.address.addressLine1)}</AdresL1>\n`;
    if (data.buyer.address.postalCode && data.buyer.address.city) {
      xml += `      <AdresL2>${this.escapeXml(`${data.buyer.address.postalCode} ${data.buyer.address.city}`)}</AdresL2>\n`;
    }
    xml += `    </Adres>\n`;
    xml += `  </Podmiot2>\n`;

    // Fa (Główna część dokumentu)
    xml += `  <Fa>\n`;
    xml += `    <KodWaluty>${this.escapeXml(data.currency)}</KodWaluty>\n`;
    xml += `    <P_1>${data.issueDate}</P_1>\n`;
    xml += `    <P_2>${this.escapeXml(data.invoiceNumber)}</P_2>\n`;
    xml += `    <P_6>${data.saleDate}</P_6>\n`;

    // Kwoty stawek VAT
    if (p13_1 > 0 || p14_1 > 0) {
      xml += `    <P_13_1>${this.formatAmount(p13_1)}</P_13_1>\n`;
      xml += `    <P_14_1>${this.formatAmount(p14_1)}</P_14_1>\n`;
    }
    if (p13_2 > 0 || p14_2 > 0) {
      xml += `    <P_13_2>${this.formatAmount(p13_2)}</P_13_2>\n`;
      xml += `    <P_14_2>${this.formatAmount(p14_2)}</P_14_2>\n`;
    }
    if (p13_3 > 0 || p14_3 > 0) {
      xml += `    <P_13_3>${this.formatAmount(p13_3)}</P_13_3>\n`;
      xml += `    <P_14_3>${this.formatAmount(p14_3)}</P_14_3>\n`;
    }
    if (p13_6 > 0) {
      xml += `    <P_13_6>${this.formatAmount(p13_6)}</P_13_6>\n`;
    }

    xml += `    <P_15>${this.formatAmount(val.totalGross)}</P_15>\n`;
    xml += `    <RodzajFaktury>${data.invoiceType}</RodzajFaktury>\n`;

    // Obsługa faktury korygującej
    if (data.invoiceType === 'KOR' && data.correction) {
      xml += `    <PrzyczynaKorekty>${this.escapeXml(data.correction.correctionReason)}</PrzyczynaKorekty>\n`;
      xml += `    <DaneFaKorygowanej>\n`;
      xml += `      <NrFaKorygowanej>${this.escapeXml(data.correction.originalInvoiceNumber)}</NrFaKorygowanej>\n`;
      if (data.correction.originalKsefNumber) {
        xml += `      <NrKSeFFaKorygowanej>${this.escapeXml(data.correction.originalKsefNumber)}</NrKSeFFaKorygowanej>\n`;
      }
      xml += `    </DaneFaKorygowanej>\n`;
    }

    // Wiersze faktury (FaWiersz)
    for (const line of data.lines) {
      const lineNet = Number(line.totalNet || (line.quantity * line.unitPriceNet));
      xml += `    <FaWiersz>\n`;
      xml += `      <NrWierszaFa>${line.lineNumber}</NrWierszaFa>\n`;
      xml += `      <P_7>${this.escapeXml(line.name)}</P_7>\n`;
      xml += `      <P_8A>${this.escapeXml(line.unitOfMeasure || 'szt')}</P_8A>\n`;
      xml += `      <P_8B>${line.quantity}</P_8B>\n`;
      xml += `      <P_9A>${this.formatAmount(line.unitPriceNet)}</P_9A>\n`;
      xml += `      <P_11>${this.formatAmount(lineNet)}</P_11>\n`;
      xml += `      <P_12>${line.vatRate}</P_12>\n`;
      xml += `    </FaWiersz>\n`;
    }

    // Płatności i uwagi
    if (data.paymentMethod || data.bankAccountNumber) {
      xml += `    <Platnosc>\n`;
      if (data.paymentMethod) {
        xml += `      <FormaPlatnosci>${this.escapeXml(data.paymentMethod)}</FormaPlatnosci>\n`;
      }
      if (data.bankAccountNumber) {
        xml += `      <RachunekBankowy>\n`;
        xml += `        <NrRB>${this.escapeXml(data.bankAccountNumber.replace(/\s+/g, ''))}</NrRB>\n`;
        xml += `      </RachunekBankowy>\n`;
      }
      xml += `    </Platnosc>\n`;
    }

    xml += `  </Fa>\n`;
    xml += `</Faktura>\n`;

    // Obliczenie deterministycznego skrótu SHA-256
    const sha256 = crypto.createHash('sha256').update(xml, 'utf8').digest('hex');

    return {
      isValid: true,
      xml,
      sha256,
      totalNet: val.totalNet,
      totalVat: val.totalVat,
      totalGross: val.totalGross,
      errors: [],
      warnings: val.warnings
    };
  }
}
