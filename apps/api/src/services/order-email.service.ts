import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { QueryRunner } from 'typeorm';

interface MailRow {
  email: string;
  total_minor: string;
  payment_type: 'cod' | 'bank_transfer' | 'demo';
}

const SUBJECTS: Record<string, string> = {
  'order.placed': 'Your order was placed',
  'order.paid': 'Payment recorded for your order',
  'order.cancelled': 'Your order was cancelled',
  'order.transfer_reference_updated': 'Transfer reference received',
};

@Injectable()
export class OrderEmailService {
  readonly testDeliveries: { eventId: string; orderId: string; email: string; eventType: string }[] = [];

  async send(runner: QueryRunner, eventId: string, eventType: string, orderId: string): Promise<void> {
    const subject = SUBJECTS[eventType];
    if (!subject) throw new Error(`Unsupported order notification event: ${eventType}`);
    const rows = await runner.query(
      `SELECT u.email, o.total_minor, o.payment_type
         FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
      [orderId],
    ) as MailRow[];
    if (!rows.length) throw new Error(`Order ${orderId} no longer exists`);
    const row = rows[0];
    const deliveredSubject = eventType === 'order.paid' && row.payment_type === 'demo'
      ? 'Demo payment simulated for your order' : subject;
    if (process.env.NODE_ENV === 'test' && process.env.OTP_DELIVERY_MODE === 'test') {
      this.testDeliveries.push({ eventId, orderId, email: row.email, eventType });
      return;
    }
    const host = process.env.SMTP_HOST;
    const from = process.env.SMTP_FROM;
    if (!host || !from) throw new Error('SMTP_HOST and SMTP_FROM are required for order notifications');
    const port = Number(process.env.SMTP_PORT ?? '587');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT is invalid');
    const user = process.env.SMTP_USER;
    const password = process.env.SMTP_PASSWORD;
    if (Boolean(user) !== Boolean(password)) throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true',
      ...(user && password ? { auth: { user, pass: password } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
    try {
      await transport.sendMail({
        from,
        to: row.email,
        subject: deliveredSubject,
        text: `${deliveredSubject}. Order ${orderId}. Total: PKR ${(Number(row.total_minor) / 100).toFixed(2)}. Payment: ${row.payment_type}.${row.payment_type === 'demo' ? ' No real charge was made.' : ''}`,
        headers: { 'X-Order-Event-ID': eventId },
      });
    } finally {
      transport.close();
    }
  }
}
