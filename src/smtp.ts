import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import type { SkyMailConfig } from "./config.js";

const TIMEOUT_MS = 15_000;

export interface ComposeEmailOptions {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string | string[];
}

export interface BuiltMimeMessage {
  raw: Buffer;
  messageId: string;
  envelope: {
    from: string | false;
    to: string[];
  };
}

export async function buildMimeMessage(
  options: ComposeEmailOptions,
): Promise<BuiltMimeMessage> {
  const mailOptions: Mail.Options = {
    from: options.from,
    to: options.to,
    cc: options.cc,
    subject: options.subject,
    text: options.text,
    inReplyTo: options.inReplyTo,
    references: options.references,
  };
  const composer = new MailComposer(mailOptions);
  const node = composer.compile();
  const messageId = node.messageId();
  const envelope = node.getEnvelope();
  const raw = await node.build();
  return { raw, messageId, envelope };
}

export async function sendRawMimeViaSmtp(
  config: SkyMailConfig,
  mime: BuiltMimeMessage,
): Promise<{ response: string }> {
  const transporter = createSmtpTransport(config);
  try {
    const info = await transporter.sendMail({
      envelope: mime.envelope,
      raw: mime.raw,
    });
    return { response: info.response };
  } finally {
    transporter.close();
  }
}

export function createSmtpTransport(config: SkyMailConfig) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: true,
    auth: {
      user: config.user,
      pass: config.password,
    },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
}

export async function verifySmtpLogin(config: SkyMailConfig): Promise<void> {
  const transporter = createSmtpTransport(config);
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}
