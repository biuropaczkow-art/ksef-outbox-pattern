export interface FA3Header {
  formCode: string;
  systemCode: string;
  schemaVersion: string;
  variant: number;
  generationDate: string;
  systemInfo: string;
}

export interface FA3PartyAddress {
  countryCode: string;
  addressLine1: string;
  postalCode?: string;
  city?: string;
}

export interface FA3Party {
  nip?: string;
  countryPrefix?: string;
  name: string;
  address: FA3PartyAddress;
  email?: string;
  phone?: string;
}

export interface FA3InvoiceLine {
  lineNumber: number;
  name: string;
  unitOfMeasure: string;
  quantity: number;
  unitPriceNet: number;
  totalNet: number;
  vatRate: number; // np. 23, 8, 5, 0
}

export interface FA3CorrectionDetails {
  correctionReason: string;
  originalInvoiceNumber: string;
  originalKsefNumber?: string;
  issueDateCorrected?: string;
}

export interface FA3InvoiceData {
  invoiceNumber: string;
  invoiceType: 'VAT' | 'KOR' | 'ZAL' | 'ROZ';
  issueDate: string;
  saleDate: string;
  currency: string;
  seller: FA3Party;
  buyer: FA3Party;
  lines: FA3InvoiceLine[];
  correction?: FA3CorrectionDetails;
  notes?: string;
  paymentMethod?: string;
  bankAccountNumber?: string;
}

export interface FA3ValidationResult {
  isValid: boolean;
  xml?: string;
  sha256?: string;
  totalNet: number;
  totalVat: number;
  totalGross: number;
  errors: string[];
  warnings: string[];
}
