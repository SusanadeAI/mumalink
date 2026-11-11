require('dotenv').config();
const axios = require('axios');

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

module.exports = {
  isConfigured,
  getAccessToken,
  sendText,
  sendTextByPhone,
  sendMessage,
  sendTypingIndicator,
  SENDPULSE_BOT_ID
};
