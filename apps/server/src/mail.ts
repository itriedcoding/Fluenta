import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config, isMailEnabled } from './config.ts';

let transporter: Transporter | null = null;

function transport(): Transporter | null {
  if (transporter) return transporter;
  try {
    transporter = config.smtp.url
      ? nodemailer.createTransport(config.smtp.url)
      : nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.port === 465,
          auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
        });
    return transporter;
  } catch (err) {
    console.error('[mail] failed to create transport:', err);
    return null;
  }
}

export type MailResult = { delivered: boolean; reason?: string };

/**
 * Sends a transactional email. When SMTP is not configured the message is
 * written to data/outbox/ so self-hosters can still complete the flow; the
 * caller reports delivery=false so the UI can be honest about it.
 */
export async function sendMail(to: string, subject: string, text: string, html: string): Promise<MailResult> {
  if (!isMailEnabled()) {
    const dir = path.join(config.dataDir, 'outbox');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${text}\n`);
    console.log(`[mail] SMTP not configured — message written to ${file}\n${text}`);
    return { delivered: false, reason: 'smtp-not-configured' };
  }
  try {
    await transport()!.sendMail({ from: config.smtp.from, to, subject, text, html });
    return { delivered: true };
  } catch (err) {
    console.error('[mail] send failed:', err);
    return { delivered: false, reason: 'smtp-error' };
  }
}
