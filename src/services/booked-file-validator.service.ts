import crypto from 'crypto';
const uuidv4 = () => crypto.randomUUID();
import { 
  DocumentInput, 
  DocumentValidationResult, 
  BookedDocumentRecord 
} from '../types/validator';
import { idempotencyService } from './idempotency.service';

export class BookedFileValidator {
  // In-memory persistent registry for booked files and invoices
  // In production with PostgreSQL, this query executes against `invoices` and `booked_files`
  private bookedHashes: Map<string, BookedDocumentRecord> = new Map();
  private bookedInvoices: Map<string, BookedDocumentRecord> = new Map();
  private activeLocks: Set<string> = new Set();

  /**
   * Calculates deterministic SHA-256 hash of document binary or string contents
   */
  public computeFileHash(content: Buffer | string): string {
    const hash = crypto.createHash('sha256');
    if (Buffer.isBuffer(content)) {
      hash.update(content);
    } else {
      hash.update(content, 'utf8');
    }
    return hash.digest('hex');
  }

  /**
   * Creates a deterministic business key for the invoice: NIP + invoice number + issue date
   */
  public getBusinessKey(
    sellerNip: string,
    invoiceNumber: string,
    issueDate: string,
    documentType?: 'INVOICE' | 'CORRECTION',
    originalRef?: string
  ): string {
    if (documentType === 'CORRECTION') {
      return `${sellerNip.trim()}::KOR::${invoiceNumber.trim()}::${(originalRef || '').trim()}`;
    }
    return `${sellerNip.trim()}::${invoiceNumber.trim()}::${issueDate.trim()}`;
  }

  /**
   * Validates document against double booking hazards:
   * 1. Concurrency race conditions (atomic in-flight check)
   * 2. Content hash deduplication (exact duplicate file already booked)
   * 3. Business key deduplication (invoice already booked under same or different file)
   */
  public async validateAndBookDocument(input: DocumentInput): Promise<DocumentValidationResult> {
    const fileHash = this.computeFileHash(input.fileContent);
    const isCorrection = input.documentType === 'CORRECTION';
    const originalRef = input.originalKsefNumber || input.originalInvoiceNumber;

    if (isCorrection && !originalRef) {
      return {
        isValid: false,
        status: 'INVALID_CORRECTION_REFERENCE',
        fileHash,
        message: 'Faktura korygująca KSeF FA(3) musi zawierać referencję do korygowanej faktury (numer KSeF lub numer faktury pierwotnej).',
      };
    }

    const businessKey = this.getBusinessKey(input.sellerNip, input.invoiceNumber, input.issueDate, input.documentType, originalRef);
    const lockKey = `lock:doc:${fileHash}`;
    const businessLockKey = `lock:biz:${businessKey}`;
    const eventId = uuidv4();

    // --- STEP 1: CONCURRENCY LOCK (Idempotency Protection) ---
    // If Redis is reachable, attempt atomic SETNX EX. Fallback to in-memory lock if Redis is local/offline.
    let redisLockAcquired = false;
    try {
      const lockRes = await idempotencyService.checkAndMark(lockKey, eventId);
      if (lockRes.isDuplicate) {
        return {
          isValid: false,
          status: 'IN_PROCESSING_COLLISION',
          fileHash,
          message: 'Dokument jest obecnie przetwarzany przez inne równoległe żądanie.',
          conflictDetails: {
            reason: 'In-flight processing conflict detected via idempotency key',
          },
        };
      }
      redisLockAcquired = true;
    } catch {
      // Redis offline/disabled: use memory atomic lock
      if (this.activeLocks.has(lockKey) || this.activeLocks.has(businessLockKey)) {
        return {
          isValid: false,
          status: 'IN_PROCESSING_COLLISION',
          fileHash,
          message: 'Dokument jest obecnie przetwarzany przez inne równoległe żądanie (blokada pamięciowa).',
          conflictDetails: {
            reason: 'In-flight memory lock detected',
          },
        };
      }
      this.activeLocks.add(lockKey);
      this.activeLocks.add(businessLockKey);
    }

    try {
      // --- STEP 2: CONTENT HASH VALIDATION ---
      const existingByHash = this.bookedHashes.get(fileHash);
      if (existingByHash) {
        return {
          isValid: false,
          status: 'DUPLICATE_FILE',
          fileHash,
          message: `Plik o identycznej zawartości (SHA-256: ${fileHash.substring(0, 12)}...) został już zaksięgowany.`,
          conflictDetails: {
            originalInvoiceNumber: existingByHash.invoiceNumber,
            originalFileName: existingByHash.fileName,
            bookedAt: existingByHash.bookedAt,
            reason: 'Plik został już wcześniej wgrany i zaksięgowany w systemie.',
          },
        };
      }

      // --- STEP 3: BUSINESS IDENTITY VALIDATION ---
      const existingByBizKey = this.bookedInvoices.get(businessKey);
      if (existingByBizKey) {
        return {
          isValid: false,
          status: 'DUPLICATE_INVOICE',
          fileHash,
          message: `Faktura o numerze ${input.invoiceNumber} od sprzedawcy NIP ${input.sellerNip} z dnia ${input.issueDate} jest już zaksięgowana w systemie.`,
          conflictDetails: {
            originalInvoiceNumber: existingByBizKey.invoiceNumber,
            originalFileName: existingByBizKey.fileName,
            bookedAt: existingByBizKey.bookedAt,
            reason: 'Zarejestrowano już fakturę o tym numerze i dacie od wskazanego kontrahenta.',
          },
        };
      }

      // --- STEP 4: REGISTER THE BOOKED DOCUMENT ---
      const record: BookedDocumentRecord = {
        id: uuidv4(),
        fileHash,
        fileName: input.fileName,
        invoiceNumber: input.invoiceNumber,
        sellerNip: input.sellerNip,
        buyerNip: input.buyerNip,
        issueDate: input.issueDate,
        totalGross: input.totalGross,
        currency: input.currency || 'PLN',
        bookedAt: new Date(),
        documentType: input.documentType || 'INVOICE',
        originalInvoiceNumber: input.originalInvoiceNumber || null,
        originalKsefNumber: input.originalKsefNumber || null,
        correctionReason: input.correctionReason || null,
      };

      this.bookedHashes.set(fileHash, record);
      this.bookedInvoices.set(businessKey, record);

      return {
        isValid: true,
        status: 'ACCEPTED',
        fileHash,
        message: 'Dokument pomyślnie zweryfikowany i zaksięgowany. Brak duplikatów.',
        documentRecord: record,
      };

    } finally {
      // Clean up in-flight locks
      if (redisLockAcquired) {
        try {
          // Keep lock or remove
          await idempotencyService.remove(lockKey);
        } catch {
          // ignore
        }
      }
      this.activeLocks.delete(lockKey);
      this.activeLocks.delete(businessLockKey);
    }
  }

  /**
   * Helper to check file status without writing
   */
  public checkFileHash(content: Buffer | string): { isBooked: boolean; record?: BookedDocumentRecord } {
    const hash = this.computeFileHash(content);
    const record = this.bookedHashes.get(hash);
    return {
      isBooked: !!record,
      record,
    };
  }

  /**
   * Helper to check invoice status by business key
   */
  public checkInvoice(sellerNip: string, invoiceNumber: string, issueDate: string): { isBooked: boolean; record?: BookedDocumentRecord } {
    const key = this.getBusinessKey(sellerNip, invoiceNumber, issueDate);
    const record = this.bookedInvoices.get(key);
    return {
      isBooked: !!record,
      record,
    };
  }

  /**
   * Reset store (useful for tests)
   */
  public resetRegistry(): void {
    this.bookedHashes.clear();
    this.bookedInvoices.clear();
    this.activeLocks.clear();
  }
}

export const bookedFileValidator = new BookedFileValidator();
