export interface DocumentInput {
  fileName: string;
  fileContent: Buffer | string;
  sellerNip: string;
  buyerNip: string;
  invoiceNumber: string;
  issueDate: string; // YYYY-MM-DD
  totalGross: number;
  currency?: string;
  documentType?: 'INVOICE' | 'CORRECTION';
  originalInvoiceNumber?: string;
  originalKsefNumber?: string;
  correctionReason?: string;
}

export type DocumentValidationStatus = 
  | 'ACCEPTED' 
  | 'DUPLICATE_FILE' 
  | 'DUPLICATE_INVOICE' 
  | 'IN_PROCESSING_COLLISION'
  | 'INVALID_CORRECTION_REFERENCE';

export interface BookedDocumentRecord {
  id: string;
  fileHash: string;
  fileName: string;
  invoiceNumber: string;
  sellerNip: string;
  buyerNip: string;
  issueDate: string;
  totalGross: number;
  currency: string;
  bookedAt: Date;
  documentType?: 'INVOICE' | 'CORRECTION';
  originalInvoiceNumber?: string | null;
  originalKsefNumber?: string | null;
  correctionReason?: string | null;
}

export interface DocumentValidationResult {
  isValid: boolean;
  status: DocumentValidationStatus;
  fileHash: string;
  message: string;
  documentRecord?: BookedDocumentRecord;
  conflictDetails?: {
    originalInvoiceNumber?: string;
    originalFileName?: string;
    bookedAt?: Date;
    reason: string;
  };
}
