// SMTP summary email. If SMTP is not configured, prints the message to the log instead.
const { NOTIFY_EMAIL } = require('./config');

async function sendMail({ subject, text, html }) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const to = NOTIFY_EMAIL || SMTP_USER;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !to) {
    console.log(`\n  📧  SMTP not configured — summary below:\n${'─'.repeat(60)}\n${subject}\n\n${text || html}\n${'─'.repeat(60)}`);
    return false;
  }
  try {
    const nodemailer = require('nodemailer');
    const port = parseInt(SMTP_PORT || '587', 10);
    const tx = nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } });
    await tx.sendMail({ from: SMTP_USER, to, subject, text, html });
    console.log(`\n  📧  Email sent to ${to}`);
    return true;
  } catch (e) {
    console.warn(`  ⚠️  email failed: ${e.message}`);
    return false;
  }
}

module.exports = { sendMail };
