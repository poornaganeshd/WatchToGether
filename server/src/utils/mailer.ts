import nodemailer from "nodemailer";

export const getClientUrl = () =>
  (process.env.CLIENT_URL || "http://localhost:5173").split(",")[0].trim().replace(/\/+$/, "");

export const getMailTransport = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  const port = Number(SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
};

export const mailFrom = () => process.env.SMTP_FROM || '"WatchTogether" <noreply@watchtogether.app>';

/** Sends an email if SMTP is configured. Returns whether it was sent. */
export const sendMail = async (options: { to: string; subject: string; text: string; html: string }) => {
  const transport = getMailTransport();
  if (!transport) return false;
  await transport.sendMail({ from: mailFrom(), ...options });
  return true;
};
