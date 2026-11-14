require('dotenv').config();
const axios = require('axios');
const net = require('net');
const tls = require('tls');

const SENDPULSE_API_ID = process.env.SENDPULSE_API_ID || process.env.SENDPULSE_CLIENT_ID || '';
const SENDPULSE_API_SECRET = process.env.SENDPULSE_API_SECRET || '';
const SENDPULSE_BOT_ID = process.env.SENDPULSE_BOT_ID || '6ae31fa22b8904f5d60fb9d6';

let cachedToken = null;
let tokenExpiresAt = 0;

function isConfigured() {
  return Boolean(SENDPULSE_API_ID && SENDPULSE_API_SECRET);
}

/**
 * Acquire / refresh SendPulse OAuth Bearer token.
 * Token is cached in-memory and automatically refreshed 60s before expiration.
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!isConfigured()) {
    console.warn('[SendPulse] API Credentials not provided. Running in simulation mode.');
    return null;
  }

  try {
    const { data } = await axios.post(
      'https://api.sendpulse.com/oauth/access_token',
      {
        grant_type: 'client_credentials',
        client_id: SENDPULSE_API_ID,
        client_secret: SENDPULSE_API_SECRET
      },
      { timeout: 15000 }
    );

    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    console.log('[SendPulse] OAuth access token refreshed.');
    return cachedToken;
  } catch (err) {
    console.error('[SendPulse] OAuth token error:', err.response?.data || err.message);
    throw err;
  }
}

/**
 * Send a WhatsApp text message to an existing SendPulse contact ID.
 */
async function sendText(contactId, text) {
  if (!contactId) {
    console.warn('[SendPulse] sendText called without contactId.');
    return null;
  }

  const token = await getAccessToken();
  if (!token) {
    console.log(`[SendPulse Simulator] Output to contact ${contactId}: \n${text}`);
    return { simulated: true, contactId, text };
  }

  // Attempt 1: sendByContact
  try {
    const { data } = await axios.post(
      'https://api.sendpulse.com/whatsapp/contacts/sendByContact',
      {
        contact_id: contactId,
        message: {
          type: 'text',
          text: { body: text }
        }
      },
      {
        headers: { 
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    console.log('[SendPulse] Message delivered to contact:', contactId);
    return data;
  } catch (err) {
    // Attempt 2: fallback to /contacts/send
    try {
      const { data } = await axios.post(
        'https://api.sendpulse.com/whatsapp/contacts/send',
        {
          contact_id: contactId,
          message: {
            type: 'text',
            text: { body: text }
          }
        },
        {
          headers: { 
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      );
      console.log('[SendPulse] Message delivered via fallback to contact:', contactId);
      return data;
    } catch (fallbackErr) {
      console.error('[SendPulse] sendText error:', err.response?.data || err.message);
      return null;
    }
  }
}

/**
 * Send a WhatsApp text message directly to a phone number.
 */
async function sendTextByPhone(phone, text) {
  if (!phone) {
    console.warn('[SendPulse] sendTextByPhone called without phone.');
    return null;
  }

  const token = await getAccessToken();
  if (!token) {
    console.log(`[SendPulse Simulator] Output to phone ${phone}: \n${text}`);
    return { simulated: true, phone, text };
  }

  const cleanPhone = phone.replace(/[^0-9]/g, '');

  try {
    const { data } = await axios.post(
      'https://api.sendpulse.com/whatsapp/contacts/sendByPhone',
      {
        bot_id: SENDPULSE_BOT_ID,
        phone: cleanPhone,
        message: {
          type: 'text',
          text: { body: text }
        }
      },
      {
        headers: { 
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    console.log('[SendPulse] Message delivered to phone:', cleanPhone);
    return data;
  } catch (err) {
    console.error('[SendPulse] sendTextByPhone error:', err.response?.data || err.message);
    return null;
  }
}

/**
 * Unified dispatch: sends via contact_id if available, falling back to phone number.
 */
async function sendMessage(target, text) {
  if (!target) return null;

  // If target looks like a SendPulse hexadecimal contact_id (24 chars)
  if (typeof target === 'string' && /^[0-9a-f]{24}$/i.test(target)) {
    const res = await sendText(target, text);
    if (res) return res;
  }

  // Otherwise target is phone number or mother object
  if (typeof target === 'object') {
    if (target.sendpulse_contact_id) {
      const res = await sendText(target.sendpulse_contact_id, text);
      if (res) return res;
    }
    if (target.phone_number || target.phone) {
      return await sendTextByPhone(target.phone_number || target.phone, text);
    }
  }

  return await sendTextByPhone(target, text);
}

/**
 * Send typing indicator to WhatsApp contact
 */
async function sendTypingIndicator(contactId) {
  if (!contactId) return;
  const token = await getAccessToken();
  if (!token) return;

  try {
    await axios.post(
      'https://api.sendpulse.com/whatsapp/contacts/sendTyping',
      { contact_id: contactId },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      }
    );
  } catch (err) {
    // Non-critical, ignore typing errors
  }
}

function normalizeEmailRecipients(to) {
  const list = Array.isArray(to) ? to : [to];
  const seen = new Set();
  const clean = [];
  for (const item of list) {
    if (!item) continue;
    let email = '';
    let name = '';
    if (typeof item === 'string') {
      email = item.trim();
    } else if (typeof item === 'object' && item.email) {
      email = String(item.email).trim();
      name = item.name ? String(item.name).trim() : '';
    }
    if (!email || !email.includes('@')) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(name ? { name, email } : { name: email.split('@')[0], email });
  }
  return clean;
}

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sendViaSmtpSocket({ fromEmail, fromName, recipients, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST || '';
    const port = parseInt(process.env.SMTP_PORT || '2525', 10);
    const user = process.env.SMTP_USER || '';
    const pass = process.env.SMTP_PASS || '';
    if (!host || !user || !pass) {
      return reject(new Error('SMTP credentials not configured'));
    }

    let socket = port === 465
      ? tls.connect({ host, port, rejectUnauthorized: false })
      : net.createConnection({ host, port });

    socket.setTimeout(15000);
    let buffer = '';
    let waitResolve = null;

    const attachListeners = (sock) => {
      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i];
          if (/^\d{3} /.test(line)) {
            const full = lines.slice(0, i + 1).join('\n');
            buffer = lines.slice(i + 1).join('\n');
            if (waitResolve) {
              const r = waitResolve;
              waitResolve = null;
              r(full);
            }
            break;
          }
        }
      });
      sock.on('error', (err) => reject(err));
      sock.on('timeout', () => {
        sock.destroy();
        reject(new Error('SMTP socket timeout'));
      });
    };

    const readResponse = () => new Promise((res) => { waitResolve = res; });
    const sendCmd = async (cmd) => {
      const p = readResponse();
      socket.write(cmd + '\r\n');
      return await p;
    };

    attachListeners(socket);

    (async () => {
      const greet = await readResponse();
      if (!greet.startsWith('220')) throw new Error(`SMTP greeting error: ${greet}`);

      let ehlo = await sendCmd('EHLO mumalink.com');
      if (port !== 465 && /STARTTLS/i.test(ehlo)) {
        const starttlsResp = await sendCmd('STARTTLS');
        if (starttlsResp.startsWith('220')) {
          socket = tls.connect({ socket, rejectUnauthorized: false });
          attachListeners(socket);
          ehlo = await sendCmd('EHLO mumalink.com');
        }
      }

      const authPrompt = await sendCmd('AUTH LOGIN');
      if (!authPrompt.startsWith('334')) throw new Error(`SMTP AUTH error: ${authPrompt}`);
      const userResp = await sendCmd(Buffer.from(user, 'utf8').toString('base64'));
      if (!userResp.startsWith('334')) throw new Error(`SMTP user error: ${userResp}`);
      const passResp = await sendCmd(Buffer.from(pass, 'utf8').toString('base64'));
      if (!passResp.startsWith('235')) throw new Error(`SMTP auth failed: ${passResp}`);

      const mailResp = await sendCmd(`MAIL FROM:<${fromEmail}>`);
      if (!mailResp.startsWith('250')) throw new Error(`SMTP MAIL FROM error: ${mailResp}`);

      for (const r of recipients) {
        const rcptResp = await sendCmd(`RCPT TO:<${r.email}>`);
        if (!rcptResp.startsWith('250')) throw new Error(`SMTP RCPT TO error: ${rcptResp}`);
      }

      const dataResp = await sendCmd('DATA');
      if (!dataResp.startsWith('354')) throw new Error(`SMTP DATA error: ${dataResp}`);

      const toHeader = recipients.map(r => `"${r.name.replace(/"/g, '')}" <${r.email}>`).join(', ');
      const mimeBody = [
        `From: "${fromName.replace(/"/g, '')}" <${fromEmail}>`,
        `To: ${toHeader}`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        '',
        String(html || text || '').replace(/^\./gm, '..'),
        '.'
      ].join('\r\n');

      const endResp = await sendCmd(mimeBody);
      if (!endResp.startsWith('250')) throw new Error(`SMTP body error: ${endResp}`);

      await sendCmd('QUIT').catch(() => {});
      socket.end();
      resolve({ provider: 'smtp', accepted: recipients.map(r => r.email) });
    })().catch((err) => {
      try { socket.destroy(); } catch (_) {}
      reject(err);
    });
  });
}

/**
 * Send transactional email via SendPulse SMTP API with direct SMTP fallback.
 */
async function sendEmail({ to, subject, html, text }) {
  const recipients = normalizeEmailRecipients(to);
  if (recipients.length === 0) {
    return { skipped: true, reason: 'No valid recipient email addresses' };
  }

  const fromEmail = process.env.SMTP_FROM || 'mail@usecallmate.com';
  const fromName = process.env.SMTP_FROM_NAME || 'MumaLINK';
  const plainText = text || stripHtmlTags(html);

  try {
    const token = await getAccessToken();
    if (token) {
      const { data } = await axios.post(
        'https://api.sendpulse.com/smtp/emails',
        {
          email: {
            html: Buffer.from(html || plainText || '', 'utf8').toString('base64'),
            text: plainText,
            subject,
            from: { name: fromName, email: fromEmail },
            to: recipients
          }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );
      console.log(`[Email] Delivered via SendPulse API to: ${recipients.map(r => r.email).join(', ')} | Subject: ${subject}`);
      return { success: true, provider: 'sendpulse_api', data, recipients: recipients.map(r => r.email) };
    }
  } catch (apiErr) {
    console.warn('[Email] SendPulse API notice, trying SMTP fallback:', apiErr.response?.data || apiErr.message);
  }

  try {
    const smtpRes = await sendViaSmtpSocket({
      fromEmail,
      fromName,
      recipients,
      subject,
      html,
      text: plainText
    });
    console.log(`[Email] Delivered via SMTP socket to: ${recipients.map(r => r.email).join(', ')} | Subject: ${subject}`);
    return { success: true, ...smtpRes };
  } catch (smtpErr) {
    console.error('[Email] Delivery failed:', smtpErr.message);
    return { success: false, error: smtpErr.message, recipients: recipients.map(r => r.email) };
  }
}

module.exports = {
  isConfigured,
  getAccessToken,
  sendText,
  sendTextByPhone,
  sendMessage,
  sendTypingIndicator,
  sendEmail,
  SENDPULSE_BOT_ID
};
