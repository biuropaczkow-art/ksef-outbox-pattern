import { v4 as uuidv4 } from 'uuid';
import { transaction, query, InvoiceRow, InvoiceItemRow } from '../db/pool';
import { 
  CreateInvoiceInput, 
  Invoice, 
  InvoiceItemWithAmounts,
  InvoiceCreatedEvent,
  OutboxEventPayload,
  KsefStatus 
} from '../types/invoice';

function calculateItemAmounts(item: CreateInvoiceInput['items'][0]): InvoiceItemWithAmounts {
  const netAmount = Number((item.quantity * item.unitPriceNet).toFixed(2));
  const vatAmount = Number((netAmount * item.vatRate / 100).toFixed(2));
  const grossAmount = Number((netAmount + vatAmount).toFixed(2));
  
  return {
    ...item,
    id: uuidv4(),
    netAmount,
    vatAmount,
    grossAmount,
  };
}

function calculateTotals(items: InvoiceItemWithAmounts[]) {
  const totalNet = items.reduce((sum, item) => sum + item.netAmount, 0);
  const totalVat = items.reduce((sum, item) => sum + item.vatAmount, 0);
  const totalGross = items.reduce((sum, item) => sum + item.grossAmount, 0);
  return { totalNet, totalVat, totalGross };
}

function mapInvoiceRow(row: InvoiceRow, items: InvoiceItemRow[]): Invoice {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    sellerNip: row.seller_nip,
    buyerNip: row.buyer_nip,
    sellerName: row.seller_name,
    buyerName: row.buyer_name,
    issueDate: new Date(row.issue_date),
    saleDate: new Date(row.sale_date),
    currency: row.currency,
    totalNet: parseFloat(row.total_net),
    totalVat: parseFloat(row.total_vat),
    totalGross: parseFloat(row.total_gross),
    ksefNumber: row.ksef_number,
    ksefStatus: row.ksef_status as KsefStatus,
    ksefSentAt: row.ksef_sent_at ? new Date(row.ksef_sent_at) : null,
    ksefResponse: row.ksef_response,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    version: row.version,
    items: items.map(item => ({
      id: item.id,
      lineNumber: item.line_number,
      name: item.name,
      quantity: parseFloat(item.quantity),
      unit: item.unit,
      unitPriceNet: parseFloat(item.unit_price_net),
      vatRate: parseFloat(item.vat_rate),
      netAmount: parseFloat(item.net_amount),
      vatAmount: parseFloat(item.vat_amount),
      grossAmount: parseFloat(item.gross_amount),
    })),
  };
}

export class InvoiceService {
  async createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
    const itemsWithAmounts = input.items.map(calculateItemAmounts);
    const { totalNet, totalVat, totalGross } = calculateTotals(itemsWithAmounts);
    const invoiceId = uuidv4();

    const invoice = await transaction(async (client) => {
      // 1. Insert invoice
      await client.query(
        `INSERT INTO invoices (
          id, invoice_number, seller_nip, buyer_nip, seller_name, buyer_name,
          issue_date, sale_date, currency, total_net, total_vat, total_gross,
          ksef_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          invoiceId,
          input.invoiceNumber,
          input.sellerNip,
          input.buyerNip,
          input.sellerName,
          input.buyerName,
          input.issueDate,
          input.saleDate,
          input.currency || 'PLN',
          totalNet.toFixed(2),
          totalVat.toFixed(2),
          totalGross.toFixed(2),
          'DRAFT',
        ]
      );

      // 2. Insert invoice items
      for (const item of itemsWithAmounts) {
        await client.query(
          `INSERT INTO invoice_items (
            id, invoice_id, line_number, name, quantity, unit,
            unit_price_net, vat_rate, net_amount, vat_amount, gross_amount
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            item.id,
            invoiceId,
            item.lineNumber,
            item.name,
            item.quantity.toFixed(3),
            item.unit,
            item.unitPriceNet.toFixed(4),
            item.vatRate.toFixed(2),
            item.netAmount.toFixed(2),
            item.vatAmount.toFixed(2),
            item.grossAmount.toFixed(2),
          ]
        );
      }

      // 3. CRITICAL: Write to OUTBOX in the SAME transaction
      // This is the Transactional Outbox Pattern - atomic write of business data + event
      const eventPayload: InvoiceCreatedEvent = {
        eventType: 'INVOICE_CREATED',
        aggregateId: invoiceId,
        aggregateType: 'INVOICE',
        payload: {
          invoiceId,
          invoiceNumber: input.invoiceNumber,
          sellerNip: input.sellerNip,
          buyerNip: input.buyerNip,
          totalGross,
          currency: input.currency || 'PLN',
          issueDate: input.issueDate,
        },
        metadata: {
          source: 'api',
          correlationId: uuidv4(),
        },
      };

      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_id, aggregate_type, payload, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          eventPayload.eventType,
          eventPayload.aggregateId,
          eventPayload.aggregateType,
          JSON.stringify(eventPayload.payload),
          JSON.stringify(eventPayload.metadata),
        ]
      );

      return invoiceId;
    });

    // Fetch the created invoice with items
    const invoiceResult = await query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1',
      [invoice]
    );
    
    const itemsResult = await query<InvoiceItemRow>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number',
      [invoice]
    );

    return mapInvoiceRow(invoiceResult.rows[0], itemsResult.rows);
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const invoiceResult = await query<InvoiceRow>(
      'SELECT * FROM invoices WHERE id = $1',
      [id]
    );
    
    if (invoiceResult.rows.length === 0) {
      return null;
    }

    const itemsResult = await query<InvoiceItemRow>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number',
      [id]
    );

    return mapInvoiceRow(invoiceResult.rows[0], itemsResult.rows);
  }

  async getInvoiceByNumber(invoiceNumber: string): Promise<Invoice | null> {
    const invoiceResult = await query<InvoiceRow>(
      'SELECT * FROM invoices WHERE invoice_number = $1',
      [invoiceNumber]
    );
    
    if (invoiceResult.rows.length === 0) {
      return null;
    }

    const itemsResult = await query<InvoiceItemRow>(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number',
      [invoiceResult.rows[0].id]
    );

    return mapInvoiceRow(invoiceResult.rows[0], itemsResult.rows);
  }

  async markAsSentToKsef(
    invoiceId: string, 
    ksefNumber: string, 
    ksefResponse: any
  ): Promise<Invoice> {
    await transaction(async (client) => {
      // Update invoice
      await client.query(
        `UPDATE invoices 
         SET ksef_number = $1, ksef_status = $2, ksef_sent_at = NOW(), ksef_response = $3, version = version + 1
         WHERE id = $4`,
        [ksefNumber, 'SENT_TO_KSEF', JSON.stringify(ksefResponse), invoiceId]
      );

      // Write event to outbox in SAME transaction
      const eventPayload = {
        eventType: 'INVOICE_SENT_TO_KSEF',
        aggregateId: invoiceId,
        aggregateType: 'INVOICE',
        payload: {
          invoiceId,
          ksefNumber,
          sentAt: new Date().toISOString(),
        },
        metadata: {
          correlationId: uuidv4(),
        },
      };

      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_id, aggregate_type, payload, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          eventPayload.eventType,
          eventPayload.aggregateId,
          eventPayload.aggregateType,
          JSON.stringify(eventPayload.payload),
          JSON.stringify(eventPayload.metadata),
        ]
      );
    });

    const invoice = await this.getInvoice(invoiceId);
    if (!invoice) throw new Error('Invoice not found after update');
    return invoice;
  }

  async markAsAccepted(
    invoiceId: string, 
    ksefNumber: string, 
    ksefReference: string
  ): Promise<Invoice> {
    await transaction(async (client) => {
      await client.query(
        `UPDATE invoices 
         SET ksef_number = $1, ksef_status = $2, ksef_response = $3, version = version + 1
         WHERE id = $4`,
        [ksefNumber, 'ACCEPTED', JSON.stringify({ reference: ksefReference }), invoiceId]
      );

      const eventPayload = {
        eventType: 'INVOICE_KSEF_ACCEPTED',
        aggregateId: invoiceId,
        aggregateType: 'INVOICE',
        payload: {
          invoiceId,
          ksefNumber,
          acceptedAt: new Date().toISOString(),
          ksefReference,
        },
        metadata: {
          correlationId: uuidv4(),
        },
      };

      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_id, aggregate_type, payload, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          eventPayload.eventType,
          eventPayload.aggregateId,
          eventPayload.aggregateType,
          JSON.stringify(eventPayload.payload),
          JSON.stringify(eventPayload.metadata),
        ]
      );
    });

    const invoice = await this.getInvoice(invoiceId);
    if (!invoice) throw new Error('Invoice not found after update');
    return invoice;
  }

  async markAsRejected(
    invoiceId: string, 
    ksefNumber: string, 
    errors: string[]
  ): Promise<Invoice> {
    await transaction(async (client) => {
      await client.query(
        `UPDATE invoices 
         SET ksef_number = $1, ksef_status = $2, ksef_response = $3, version = version + 1
         WHERE id = $4`,
        [ksefNumber, 'REJECTED', JSON.stringify({ errors }), invoiceId]
      );

      const eventPayload = {
        eventType: 'INVOICE_KSEF_REJECTED',
        aggregateId: invoiceId,
        aggregateType: 'INVOICE',
        payload: {
          invoiceId,
          ksefNumber,
          rejectedAt: new Date().toISOString(),
          errors,
        },
        metadata: {
          correlationId: uuidv4(),
        },
      };

      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_id, aggregate_type, payload, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          eventPayload.eventType,
          eventPayload.aggregateId,
          eventPayload.aggregateType,
          JSON.stringify(eventPayload.payload),
          JSON.stringify(eventPayload.metadata),
        ]
      );
    });

    const invoice = await this.getInvoice(invoiceId);
    if (!invoice) throw new Error('Invoice not found after update');
    return invoice;
  }

  async listInvoices(
    filters: { 
      sellerNip?: string; 
      buyerNip?: string; 
      ksefStatus?: KsefStatus;
      fromDate?: string;
      toDate?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<{ invoices: Invoice[]; total: number }> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.sellerNip) {
      conditions.push(`seller_nip = $${paramIndex++}`);
      params.push(filters.sellerNip);
    }
    if (filters.buyerNip) {
      conditions.push(`buyer_nip = $${paramIndex++}`);
      params.push(filters.buyerNip);
    }
    if (filters.ksefStatus) {
      conditions.push(`ksef_status = $${paramIndex++}`);
      params.push(filters.ksefStatus);
    }
    if (filters.fromDate) {
      conditions.push(`issue_date >= $${paramIndex++}`);
      params.push(filters.fromDate);
    }
    if (filters.toDate) {
      conditions.push(`issue_date <= $${paramIndex++}`);
      params.push(filters.toDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Count total
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM invoices ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Fetch invoices
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    params.push(limit, offset);
    
    const invoiceResult = await query<InvoiceRow>(
      `SELECT * FROM invoices ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params
    );

    const invoices: Invoice[] = [];
    for (const row of invoiceResult.rows) {
      const itemsResult = await query<InvoiceItemRow>(
        'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_number',
        [row.id]
      );
      invoices.push(mapInvoiceRow(row, itemsResult.rows));
    }

    return { invoices, total };
  }
}

export const invoiceService = new InvoiceService();