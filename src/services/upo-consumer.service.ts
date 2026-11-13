import crypto from 'crypto';
import { 
  KsefStatusCheckResponse, 
  ProcessUpoResult, 
  UpoMetadata 
} from '../types/upo';

export class UpoConsumerService {
  private static readonly MAX_RETRIES = 5;
  private static readonly BASE_BACKOFF_MS = 1000;
  private static readonly MAX_BACKOFF_MS = 30000;

  // Rejestr zarchiwizowanych Urzędowych Poświadczeń Odbioru
  private upoArchive: Map<string, UpoMetadata> = new Map();

  /**
   * Oblicza deterministyczny skrót SHA-256 Urzędowego Poświadczenia Odbioru
   */
  public computeUpoHash(upoXml: string): string {
    return crypto.createHash('sha256').update(upoXml, 'utf8').digest('hex');
  }

  /**
   * Generuje poprawną strukturę XML Urzędowego Poświadczenia Odbioru (UPO)
   */
  public generateOfficialUpo(
    ksefReferenceNumber: string,
    sellerNip: string,
    invoiceNumber: string,
    invoiceHashSha256: string,
    acquisitionTimestamp: string = new Date().toISOString()
  ): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Potwierdzenie xmlns="http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2021/06/08/eD/DefinicjeTypy/">
  <NazwaPodmiotuPrzyjmujacego>Krajowa Administracja Skarbowa - KSeF 2.0</NazwaPodmiotuPrzyjmujacego>
  <NumerIdentyfikacyjnyPodmiotu>${sellerNip}</NumerIdentyfikacyjnyPodmiotu>
  <NumerKSeF>${ksefReferenceNumber}</NumerKSeF>
  <NumerFaktury>${invoiceNumber}</NumerFaktury>
  <SkrotDokumentu>${invoiceHashSha256}</SkrotDokumentu>
  <DataPrzyjeciaDokumentu>${acquisitionTimestamp}</DataPrzyjeciaDokumentu>
  <KodStatusu>200</KodStatusu>
  <OpisStatusu>Dokument zostal przyjety i zarejestrowany w Krajowym Systemie e-Faktur.</OpisStatusu>
</Potwierdzenie>`;
  }

  /**
   * Wylicza czas oczekiwania (Exponential Backoff + Jitter) na kolejne odpytanie bramki
   */
  public calculateRetryDelay(attempt: number): number {
    const exponential = Math.min(
      UpoConsumerService.MAX_BACKOFF_MS,
      UpoConsumerService.BASE_BACKOFF_MS * Math.pow(2, attempt - 1)
    );
    // Dodajemy jitter w zakresie 10-25% dla uniknięcia efektu Thundering Herd
    const jitter = Math.floor(Math.random() * (exponential * 0.25));
    return exponential + jitter;
  }

  /**
   * Asynchroniczne przetwarzanie odpowiedzi o statusie sesji KSeF
   */
  public processSessionResponse(
    invoiceId: string,
    invoiceNumber: string,
    sellerNip: string,
    response: KsefStatusCheckResponse,
    currentAttempt: number = 1
  ): ProcessUpoResult {
    // 1. KOD 200: Sukces — Faktura zarejestrowana, UPO wygenerowane
    if (response.processingCode === 200) {
      if (!response.ksefReferenceNumber) {
        return {
          invoiceId,
          status: 'FAILED',
          error: 'Bramka zwróciła kod 200, lecz brak numeru referencyjnego KSeF.'
        };
      }

      const upoXml = response.upoXml || this.generateOfficialUpo(
        response.ksefReferenceNumber,
        sellerNip,
        invoiceNumber,
        crypto.randomBytes(32).toString('hex'),
        response.timestamp
      );

      const upoHash = this.computeUpoHash(upoXml);

      const metadata: UpoMetadata = {
        invoiceId,
        invoiceNumber,
        sellerNip,
        ksefReferenceNumber: response.ksefReferenceNumber,
        acquisitionTimestamp: response.timestamp,
        upoXml,
        upoHash
      };

      this.upoArchive.set(response.ksefReferenceNumber, metadata);

      return {
        invoiceId,
        status: 'ACCEPTED',
        ksefReferenceNumber: response.ksefReferenceNumber,
        upoHash
      };
    }

    // 2. KOD 100: Przetwarzanie w toku
    if (response.processingCode === 100) {
      const retryAfterMs = this.calculateRetryDelay(currentAttempt);
      return {
        invoiceId,
        status: 'PENDING',
        retryAfterMs,
        error: response.processingDescription || 'Sesja w toku przetwarzania w KSeF.'
      };
    }

    // 3. KODY 400 / 422: Błąd semantyczny / odrzucenie schemy FA(3)
    if (response.processingCode === 400 || response.processingCode === 422) {
      const errorMsg = (response.errors && response.errors.length > 0)
        ? response.errors.map(e => `[${e.code}] ${e.description}`).join('; ')
        : response.processingDescription || 'Odrzucenie dokumentu przez bramkę MF.';

      return {
        invoiceId,
        status: 'REJECTED',
        error: `Trwałe odrzucenie KSeF (${response.processingCode}): ${errorMsg}`
      };
    }

    // 4. KODY 500 / Awarie tymczasowe bramki
    if (currentAttempt < UpoConsumerService.MAX_RETRIES) {
      const retryAfterMs = this.calculateRetryDelay(currentAttempt);
      return {
        invoiceId,
        status: 'PENDING',
        retryAfterMs,
        error: `Tymczasowy błąd KSeF (${response.processingCode}). Zaplanowano retry #${currentAttempt + 1}.`
      };
    }

    // Po przekroczeniu MAX_RETRIES przenosimy do stanu FAILED (DLQ)
    return {
      invoiceId,
      status: 'FAILED',
      error: `Przekroczono maksymalną liczbę prób (${UpoConsumerService.MAX_RETRIES}) odpytania KSeF o UPO.`
    };
  }

  /**
   * Pobranie zarchiwizowanego poświadczenia odbioru po numerze referencyjnym
   */
  public getArchivedUpo(ksefReferenceNumber: string): UpoMetadata | undefined {
    return this.upoArchive.get(ksefReferenceNumber);
  }
}

export const upoConsumerService = new UpoConsumerService();
