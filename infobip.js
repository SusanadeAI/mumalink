require('dotenv').config();
const axios = require('axios');

const INFOBIP_API_KEY = process.env.INFOBIP_API_KEY || '';
const INFOBIP_BASE_URL = (process.env.INFOBIP_BASE_URL || 'https://api.infobip.com').replace(/\/+$/, '');
const INFOBIP_SENDER = process.env.INFOBIP_SENDER || '2348138048129';

function isConfigured() {
  return Boolean(INFOBIP_API_KEY);
}

/**
 * Send an Outbound WhatsApp Text Message via Infobip WhatsApp Business API
 * Endpoint: POST /whatsapp/1/message/text
 */
async function sendWhatsAppMessage({ to, text, from = INFOBIP_SENDER }) {
  if (!isConfigured()) {
    console.warn('[Infobip] API key missing. Running in simulation mode.');
    return { simulated: true, to, text };
  }

  let cleanTo = String(to || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (/^0[789][01]\d{8}$/.test(cleanTo)) {
    cleanTo = '234' + cleanTo.slice(1);
  }
  const cleanFrom = String(from || INFOBIP_SENDER).replace(/[^\d]/g, '');

  if (!cleanTo) {
    console.warn('[Infobip] Invalid destination phone number:', to);
    return { success: false, error: 'Invalid destination phone number' };
  }

  try {
    const res = await axios.post(
      `${INFOBIP_BASE_URL}/whatsapp/1/message/text`,
      {
        from: cleanFrom,
        to: cleanTo,
        content: {
          text: String(text).trim()
        }
      },
      {
        headers: {
          'Authorization': `App ${INFOBIP_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 20000
      }
    );

    const data = res.data;
    const msgResult = data?.messages?.[0];
    const messageId = msgResult?.messageId;
    const status = msgResult?.status?.name || 'SENT';

    console.log(`[Infobip WhatsApp] Message dispatched to ${cleanTo} (ID: ${messageId}, Status: ${status})`);
    return {
      success: true,
      messageId,
      status,
      data
    };
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('[Infobip WhatsApp] Send error:', errData);
    return {
      success: false,
      error: errData
    };
  }
}

/**
 * Send an Outbound Pre-Approved WhatsApp Template Message via Infobip WhatsApp Business API
 * Endpoint: POST /whatsapp/1/message/template
 */
async function sendWhatsAppTemplate({ to, templateName, placeholders = [], language = 'en', from = INFOBIP_SENDER }) {
  if (!isConfigured()) {
    console.warn('[Infobip] API key missing. Running in simulation mode.');
    return { simulated: true, to, templateName };
  }

  let cleanTo = String(to || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (/^0[789][01]\d{8}$/.test(cleanTo)) {
    cleanTo = '234' + cleanTo.slice(1);
  }
  const cleanFrom = String(from || INFOBIP_SENDER).replace(/[^\d]/g, '');

  if (!cleanTo) {
    return { success: false, error: 'Invalid destination phone number' };
  }

  try {
    const res = await axios.post(
      `${INFOBIP_BASE_URL}/whatsapp/1/message/template`,
      {
        messages: [
          {
            from: cleanFrom,
            to: cleanTo,
            content: {
              templateName: templateName,
              templateData: {
                language: language,
                body: {
                  placeholders: placeholders
                }
              }
            }
          }
        ]
      },
      {
        headers: {
          'Authorization': `App ${INFOBIP_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 20000
      }
    );

    const data = res.data;
    const msgResult = data?.messages?.[0];
    const messageId = msgResult?.messageId;
    const status = msgResult?.status?.name || 'SENT';

    console.log(`[Infobip WhatsApp Template] Dispatched ${templateName} to ${cleanTo} (ID: ${messageId}, Status: ${status})`);
    return {
      success: true,
      messageId,
      status,
      data
    };
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('[Infobip WhatsApp Template] Send error:', errData);
    return {
      success: false,
      error: errData
    };
  }
}

/**
 * Unified dispatch helper compatible with mother object or phone number
 */
async function sendMessage(target, text) {
  if (!target || !text) return null;

  let phone = '';
  if (typeof target === 'string') {
    phone = target;
  } else if (typeof target === 'object') {
    phone = target.phone_number || target.phone || '';
  }

  return await sendWhatsAppMessage({ to: phone, text });
}

module.exports = {
  isConfigured,
  sendWhatsAppMessage,
  sendWhatsAppTemplate,
  sendMessage,
  INFOBIP_SENDER,
  INFOBIP_BASE_URL
};
