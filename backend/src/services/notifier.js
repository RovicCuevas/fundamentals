const TEMPLATES = {
  booking_received: {
    subject: "Booking request received",
    body: ({ reference, date, startTime, start_time }) => `Your booking request ${reference} was received for ${date} at ${startTime ?? start_time}.`,
  },
  appointment_confirmed: {
    subject: "Appointment confirmed",
    body: ({ reference, date, startTime, start_time }) => `Your appointment ${reference} is confirmed for ${date} at ${startTime ?? start_time}.`,
  },
  appointment_cancelled: {
    subject: "Appointment cancelled",
    body: ({ reference, date, startTime, start_time }) => `Your appointment ${reference} for ${date} at ${startTime ?? start_time} was cancelled.`,
  },
  appointment_rescheduled: {
    subject: "Appointment rescheduled",
    body: ({ reference, date, startTime, start_time }) => `Your appointment ${reference} was rescheduled to ${date} at ${startTime ?? start_time}.`,
  },
  payment_received: {
    subject: "Payment received",
    body: ({ reference }) => `Your deposit for appointment ${reference} was received.`,
  },
  reminder_24h: {
    subject: "Appointment reminder",
    body: ({ reference, date, startTime, start_time }) => `Reminder: appointment ${reference} is tomorrow, ${date} at ${startTime ?? start_time}.`,
  },
  reminder_2h: {
    subject: "Appointment reminder",
    body: ({ reference, date, startTime, start_time }) => `Reminder: appointment ${reference} is today, ${date} at ${startTime ?? start_time}.`,
  },
  password_reset: {
    subject: "Reset your SmartCare password",
    body: ({ resetUrl }) => `Use this link to reset your password: ${resetUrl}`,
  },
  email_verification: {
    subject: "Verify your SmartCare email",
    body: ({ verificationUrl }) => `Use this link to verify your email: ${verificationUrl}`,
  },
};

function recipientFor(db, userId) {
  return db.prepare("SELECT email, phone FROM users WHERE id = ? AND active = 1").get(userId);
}

function consoleProvider({ channel, recipient, subject }) {
  console.info("[notification]", { channel, recipient, subject });
}

async function brevoFailureMessage(status, responseText) {
  let details = "";
  try {
    const payload = responseText ? JSON.parse(responseText) : null;
    const code = typeof payload?.code === "string" ? payload.code : "";
    const message = typeof payload?.message === "string" ? payload.message : "";
    details = [code, message].filter(Boolean).join(": ");
  } catch {
    // Brevo may return an empty or non-JSON error body.
  }
  const safeDetails = details.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240);
  return `Brevo API returned HTTP ${status}${safeDetails ? `: ${safeDetails}` : ""}`;
}

function createBrevoApiProvider(config) {
  return async ({ recipient, subject, body }) => {
    const controller = new AbortController();
    const timeoutMs = Number.isInteger(config.brevoTimeoutMs) && config.brevoTimeoutMs >= 1000
      ? config.brevoTimeoutMs
      : 15_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(config.brevoApiUrl, {
        method: "POST",
        headers: { "accept": "application/json", "api-key": config.brevoApiKey, "content-type": "application/json" },
        body: JSON.stringify({
          sender: { email: config.notificationFromEmail, name: config.notificationFromName },
          to: [{ email: recipient }],
          subject,
          textContent: body,
        }),
        signal: controller.signal,
      });
      const responseText = await response.text();
      console.info("[brevo] response", {
        status: response.status,
        ok: response.ok,
        body: responseText,
      });
      if (!response.ok) {
        throw new Error(await brevoFailureMessage(response.status, responseText));
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Brevo API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

function createBrevoSmtpProvider(config) {
  const transport = nodemailer.createTransport({
    host: config.brevoSmtpHost,
    port: config.brevoSmtpPort,
    secure: config.brevoSmtpPort === 465,
    auth: { user: config.brevoSmtpUser, pass: config.brevoSmtpPassword },
  });
  return async ({ recipient, subject, body }) => {
    await transport.sendMail({
      from: { address: config.notificationFromEmail, name: config.notificationFromName },
      to: recipient,
      subject,
      text: body,
    });
  };
}

export function createNotifier({ db, config = {}, provider } = {}) {
  if (!db) throw new Error("Notifier requires a database");
  console.info("[notifications] runtime", {
    provider: config.notificationProvider ?? "console",
    brevoApiUrl: config.brevoApiUrl ?? "",
    notificationFromEmail: config.notificationFromEmail ?? "",
    notificationFromName: config.notificationFromName ?? "",
  });
  const sendProvider = provider ??
    (config.notificationProvider === "brevo-api" ? createBrevoApiProvider(config) :
      config.notificationProvider === "brevo-smtp" ? createBrevoSmtpProvider(config) : consoleProvider);
  return {
    async send({ userId, appointmentId = null, template, dedupeKey, data = {}, channel = "email" }) {
      const definition = TEMPLATES[template];
      if (!definition) throw new Error(`Unknown notification template: ${template}`);
      const recipient = recipientFor(db, userId);
      if (!recipient) return false;
      const address = channel === "sms" ? recipient.phone : recipient.email;
      if (!address) return false;
      const key = dedupeKey ?? `${appointmentId ? `appointment:${appointmentId}` : `user:${userId}`}:${template}:${channel}`;
      const existing = db.prepare("SELECT status FROM notification_log WHERE dedupe_key = ?").get(key);
      if (existing?.status === "sent") return false;
      try {
        await sendProvider({ channel, recipient: address, subject: definition.subject, body: definition.body(data) });
      } catch (error) {
        db.prepare(
          `INSERT OR IGNORE INTO notification_log
           (appointment_id, user_id, channel, template, recipient, dedupe_key, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'failed', datetime('now'))`,
        ).run(appointmentId, userId, channel, template, address, key);
        const detail = error instanceof Error &&
          (error.message.startsWith("Brevo API returned HTTP ") || error.message === "Brevo API request timed out")
          ? error.message
          : "provider error";
        throw new Error(`Notification delivery failed for ${template}: ${detail}`, { cause: error });
      }
      if (existing?.status === "failed") {
        db.prepare(
          "UPDATE notification_log SET status = 'sent', sent_at = datetime('now') WHERE dedupe_key = ? AND status = 'failed'",
        ).run(key);
      } else {
        db.prepare(
          `INSERT INTO notification_log
           (appointment_id, user_id, channel, template, recipient, dedupe_key, status, created_at, sent_at)
           VALUES (?, ?, ?, ?, ?, ?, 'sent', datetime('now'), datetime('now'))`,
        ).run(appointmentId, userId, channel, template, address, key);
      }
      return true;
    },
  };
}

export { TEMPLATES };
import nodemailer from "nodemailer";
