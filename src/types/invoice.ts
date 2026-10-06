export interface InvoiceItem {
  lineNumber: number;
  name: string;
  quantity: number;
  unit: string;
  unitPriceNet: number;
  vatRate: number;
}

export interface CreateInvoiceInput {
  invoiceNumber: string;
  sellerNip: string;
  buyerNip: string;
  sellerName: string;
  buyerName: string;
  issueDate: string; // ISO date string
  saleDate: string; // ISO date string
  currency?: string;
  items: InvoiceItem[];
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  sellerNip: string;
  buyerNip: string;
  sellerName: string;
  buyerName: string;
  issueDate: Date;
  saleDate: Date;
  currency: string;
  totalNet: number;
  totalVat: number;
  totalGross: number;
  ksefNumber: string | null;
  ksefStatus: string;
  ksefSentAt: Date | null;
  ksefResponse: any;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  items: InvoiceItemWithAmounts[];
}

export interface InvoiceItemWithAmounts extends InvoiceItem {
  id: string;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
}

export type KsefStatus = 
  | 'DRAFT'
  | 'PENDING_KSEF'
  | 'SENT_TO_KSEF'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'ERROR';

export interface InvoiceCreatedEvent {
  eventType: 'INVOICE_CREATED';
  aggregateId: string;
  aggregateType: 'INVOICE';
  payload: {
    invoiceId: string;
    invoiceNumber: string;
    sellerNip: string;
    buyerNip: string;
    totalGross: number;
    currency: string;
    issueDate: string;
  };
  metadata: {
    source: 'api' | 'batch' | 'recurring';
    correlationId?: string;
    causationId?: string;
  };
}

export interface InvoiceSentToKsefEvent {
  eventType: 'INVOICE_SENT_TO_KSEF';
  aggregateId: string;
  aggregateType: 'INVOICE';
  payload: {
    invoiceId: string;
    ksefNumber: string;
    sentAt: string;
  };
  metadata: {
    correlationId?: string;
  };
}

export interface InvoiceKsefAcceptedEvent {
  eventType: 'INVOICE_KSEF_ACCEPTED';
  aggregateId: string;
  aggregateType: 'INVOICE';
  payload: {
    invoiceId: string;
    ksefNumber: string;
    acceptedAt: string;
    ksefReference: string;
  };
  metadata: {
    correlationId?: string;
  };
}

export interface InvoiceKsefRejectedEvent {
  eventType: 'INVOICE_KSEF_REJECTED';
  aggregateId: string;
  aggregateType: 'INVOICE';
  payload: {
    invoiceId: string;
    ksefNumber: string;
    rejectedAt: string;
    errors: string[];
  };
  metadata: {
    correlationId?: string;
  };
}

export type OutboxEventPayload = 
  | InvoiceCreatedEvent
  | InvoiceSentToKsefEvent
  | InvoiceKsefAcceptedEvent
  | InvoiceKsefRejectedEvent;

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateId: string;
  aggregateType: string;
  payload: OutboxEventPayload;
  metadata: Record<string, any>;
  status: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'RETRY';
  retryCount: number;
  lastError: string | null;
  createdAt: Date;
  processedAt: Date | null;
  publishedAt: Date | null;
}