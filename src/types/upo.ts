export type KsefProcessingCode = 100 | 200 | 400 | 422 | 500;

export type KsefSessionStatusState = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'FAILED';

export interface KsefStatusCheckResponse {
  sessionReferenceNumber: string;
  processingCode: KsefProcessingCode;
  processingDescription: string;
  timestamp: string;
  ksefReferenceNumber?: string;
  upoXml?: string;
  errors?: Array<{ code: number; description: string }>;
}

export interface UpoMetadata {
  invoiceId: string;
  invoiceNumber: string;
  sellerNip: string;
  ksefReferenceNumber: string;
  acquisitionTimestamp: string;
  upoXml: string;
  upoHash: string; // SHA-256
}

export interface ProcessUpoResult {
  invoiceId: string;
  status: KsefSessionStatusState;
  ksefReferenceNumber?: string;
  upoHash?: string;
  retryAfterMs?: number;
  error?: string;
}
