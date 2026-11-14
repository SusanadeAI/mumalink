require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initPostgresDatabase } = require('./postgres_db');
const sendpulse = require('./sendpulse');
const infobip = require('./infobip');

function normalizePhoneNumber(raw) {
  let digits = String(raw || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (/^0[789][01]\d{8}$/.test(digits)) {
    digits = '234' + digits.slice(1);
  }
  return digits ? '+' + digits : '';
}

const MOOD_OPTIONS = [
  { code: '1', label: 'Happy / Peaceful', negative: false, keywords: ['happy', 'peaceful', 'good', 'great', 'fine', 'blessed', 'okay', 'well'] },
  { code: '2', label: 'Tired but coping', negative: false, keywords: ['tired but coping', 'coping', 'managing'] },
  { code: '3', label: 'Unhappy / Overwhelmed', negative: true, keywords: ['not happy', 'not good', 'not well', 'not okay', 'unhappy', 'overwhelmed', 'struggling', 'exhausted', 'bad'] },
  { code: '4', label: 'Anxious / Worried', negative: true, keywords: ['anxious', 'worried', 'worry', 'restless', 'panicky', 'panic', 'scared', 'stressed', 'stress'] },
  { code: '5', label: 'Sad / Low mood', negative: true, keywords: ['sad', 'depressed', 'low mood', 'crying', 'cry', 'miserable', 'down', 'lonely', 'hopeless', 'helpless'] }
];

function buildInitialGreetingMessage(mother) {
  const hospitalName = mother.hospital_name || 'Mother & Child Hospital';
  const babyLine = mother.baby_name
    ? `We celebrate with you and baby ${mother.baby_name} on your safe delivery from ${hospitalName}.`
    : `You just delivered from ${hospitalName}, and your care team is checking in on you.`;
  return `Congratulations Mommy ${mother.full_name}!
${babyLine}

How are you feeling today? (You can select one or multiple options):
1 - Happy / Peaceful
2 - Tired but coping
3 - Unhappy / Overwhelmed
4 - Anxious / Worried
5 - Sad / Low mood

Reply with one or more numbers (e.g. 1, 2 or 3, 4) or describe how you feel.`;
}

function buildFollowupGreetingMessage(mother) {
  const hospitalName = mother.hospital_name || 'Mother & Child Hospital';
  return `Good day Mommy ${mother.full_name}.
This is your follow-up wellness check-in from ${hospitalName}.

How are you feeling today? (You can select one or more options):
1 - Happy / Peaceful
2 - Tired but coping
3 - Unhappy / Overwhelmed
4 - Anxious / Worried
5 - Sad / Low mood

Reply with one or more numbers (e.g. 1, 2 or 3, 4) or describe how you feel.`;
}

function parseMoodSelection(incomingText) {
  const lower = String(incomingText || '').toLowerCase().trim();
  const matched = new Map();

  // Extract explicit option numbers (e.g. "1", "3, 4", "3 5")
  const digitMatches = lower.match(/\b[1-5]\b/g) || [];
  digitMatches.forEach(d => {
    const opt = MOOD_OPTIONS.find(o => o.code === d);
    if (opt) matched.set(opt.code, opt);
  });
  if (matched.size === 0 && /^[1-5\s,&+]+$/.test(lower)) {
    for (const ch of lower) {
      const opt = MOOD_OPTIONS.find(o => o.code === ch);
      if (opt) matched.set(opt.code, opt);
    }
  }

  // Mask negated positives before keyword scanning so "not happy" does not match "happy"
  const maskedNegative = lower.includes('not happy') || lower.includes('not good') || lower.includes('not well') || lower.includes('not okay');
  for (const opt of MOOD_OPTIONS) {
    if (!opt.negative && maskedNegative) continue;
    if (opt.keywords.some(kw => new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lower))) {
      matched.set(opt.code, opt);
    }
  }

  // Standalone "tired" without "coping" or "managing" counts as exhaustion distress
  if (/\btired\b/i.test(lower) && !matched.has('2')) {
    const opt3 = MOOD_OPTIONS.find(o => o.code === '3');
    if (opt3) matched.set(opt3.code, opt3);
  }

  const selections = Array.from(matched.values());
  return {
    selections,
    labels: selections.map(s => `${s.code} (${s.label})`),
    hasNegative: selections.some(s => s.negative),
    hasPositive: selections.some(s => !s.negative)
  };
}

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mumalink_secure_jwt_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets (disable auto index.html so root '/' handles subdomain tenant routing)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Initialize Render PostgreSQL tables & seed data
initPostgresDatabase()
  .then(() => console.log('Render PostgreSQL ready.'))
  .catch(err => console.error('Failed to init PostgreSQL:', err));

// =============================================================================
// TRANSACTIONAL EMAIL DISPATCH HELPERS (SENDPULSE API + SMTP FALLBACK)
// =============================================================================
function escapeHtmlServer(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBrandedEmailHtml({ badge = 'MumaLINK Clinical Network', title, subtitle, rows = [], ctaLabel, ctaUrl, footerNote }) {
  const rowsHtml = rows
    .filter(r => r && r.value !== undefined && r.value !== null && String(r.value).trim() !== '')
    .map(r => `
      <tr>
        <td style="padding: 10px 14px; border-bottom: 1px solid #E2E8F0; color: #64748B; font-size: 13px; font-weight: 600; width: 38%; vertical-align: top;">${escapeHtmlServer(r.label)}</td>
        <td style="padding: 10px 14px; border-bottom: 1px solid #E2E8F0; color: #0F172A; font-size: 13px; font-weight: 600; vertical-align: top;">${escapeHtmlServer(r.value)}</td>
      </tr>
    `).join('');

  const ctaHtml = (ctaLabel && ctaUrl) ? `
    <div style="margin-top: 22px;">
      <a href="${escapeHtmlServer(ctaUrl)}" style="display: inline-block; background-color: #0F172A; color: #FFFFFF; text-decoration: none; font-size: 13.5px; font-weight: 700; padding: 11px 20px; border-radius: 8px;">${escapeHtmlServer(ctaLabel)}</a>
    </div>
  ` : '';

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background-color: #F8FAFC; padding: 28px 16px; color: #0F172A;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 12px; overflow: hidden;">
        <div style="padding: 20px 24px; border-bottom: 1px solid #E2E8F0; background-color: #0F172A; color: #FFFFFF;">
          <div style="font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94A3B8; margin-bottom: 6px;">${escapeHtmlServer(badge)}</div>
          <div style="font-size: 19px; font-weight: 800; line-height: 1.3;">${escapeHtmlServer(title)}</div>
        </div>
        <div style="padding: 22px 24px;">
          ${subtitle ? `<p style="margin: 0 0 18px 0; font-size: 14px; color: #334155; line-height: 1.55;">${escapeHtmlServer(subtitle)}</p>` : ''}
          ${rowsHtml ? `<table style="width: 100%; border-collapse: collapse; border: 1px solid #E2E8F0; border-radius: 8px; overflow: hidden;">${rowsHtml}</table>` : ''}
          ${ctaHtml}
          <p style="margin: 22px 0 0 0; font-size: 12px; color: #64748B; line-height: 1.5;">
            ${escapeHtmlServer(footerNote || 'Sent automatically by MumaLINK Maternal Postpartum Triage & Clinical Surveillance.')}
          </p>
        </div>
      </div>
    </div>
  `;
}

async function getHospitalRecipients(hospitalId, { includeSuperAdmins = false, extraEmails = [] } = {}) {
  const recipients = [];
  const seen = new Set();
  const addEmail = (email, name) => {
    const clean = String(email || '').trim();
    if (!clean || !clean.includes('@')) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    recipients.push({ email: clean, name: name || clean.split('@')[0] });
  };

  for (const extra of extraEmails) {
    if (typeof extra === 'string') addEmail(extra);
    else if (extra && extra.email) addEmail(extra.email, extra.name);
  }

  try {
    if (hospitalId) {
      const { rows: hRows } = await pool.query('SELECT name, contact_email FROM hospitals WHERE id = $1', [hospitalId]);
      if (hRows[0]?.contact_email) addEmail(hRows[0].contact_email, hRows[0].name);

      const { rows: cRows } = await pool.query('SELECT full_name, email FROM clinicians WHERE hospital_id = $1', [hospitalId]);
      for (const c of cRows) addEmail(c.email, c.full_name);
    }

    if (includeSuperAdmins) {
      const { rows: adminRows } = await pool.query("SELECT full_name, email FROM clinicians WHERE role = 'Super Admin'");
      for (const a of adminRows) addEmail(a.email, a.full_name);
    }
  } catch (err) {
    console.error('[Email Recipient Lookup Error]:', err.message);
  }
  return recipients;
}

async function sendNotificationEmailSafe({ to, subject, html, text }) {
  try {
    return await sendpulse.sendEmail({ to, subject, html, text });
  } catch (err) {
    console.error('[Email Dispatch Notice]:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendCriticalRiskAlertEmail(mother, { reason, score = null, hospitalName = '' }) {
  const hospRes = await pool.query('SELECT name, subdomain, phone FROM hospitals WHERE id = $1', [mother.hospital_id]).catch(() => ({ rows: [] }));
  const hosp = hospRes.rows[0] || {};
  const label = hospitalName || mother.hospital_name || hosp.name || 'Partner Hospital';
  const recipients = await getHospitalRecipients(mother.hospital_id, { includeSuperAdmins: true });
  const portalUrl = hosp.subdomain ? `https://${hosp.subdomain}.mumalink.com/dashboard` : 'https://mumalink.com/dashboard';

  return await sendNotificationEmailSafe({
    to: recipients,
    subject: `[URGENT • MumaLINK] Critical Postpartum Risk Alert — ${mother.full_name} (${label})`,
    html: buildBrandedEmailHtml({
      badge: 'Urgent Clinical Escalation',
      title: `Critical Alert: ${mother.full_name}`,
      subtitle: `Immediate clinical review is required for ${mother.full_name} at ${label}.`,
      rows: [
        { label: 'Patient Name', value: mother.full_name },
        { label: 'WhatsApp Phone', value: mother.phone_number },
        { label: 'Facility', value: label },
        { label: 'Escalation Trigger', value: reason },
        { label: 'EPDS Score', value: score !== null && score !== undefined ? `${score} / 30` : 'Immediate Urgent Trigger' },
        { label: 'Hospital Line', value: hosp.phone || mother.hospital_phone || 'See portal' }
      ],
      ctaLabel: 'Open Triage Dashboard',
      ctaUrl: portalUrl
    })
  });
}

// =============================================================================
// EPDS 10 CLINICAL QUESTIONS REFERENCE
// =============================================================================
const EPDS_QUESTIONS = [
  {
    index: 1,
    key: 'q1_laugh',
    question: "In the past 7 days: I have been able to laugh and see the funny side of things.",
    options: [
      { score: 0, text: "0 - As much as I always could" },
      { score: 1, text: "1 - Not quite so much now" },
      { score: 2, text: "2 - Definitely not so much now" },
      { score: 3, text: "3 - Not at all" }
    ]
  },
  {
    index: 2,
    key: 'q2_enjoyment',
    question: "In the past 7 days: I have looked forward with enjoyment to things.",
    options: [
      { score: 0, text: "0 - As much as I ever did" },
      { score: 1, text: "1 - Rather less than I used to" },
      { score: 2, text: "2 - Definitely less than I used to" },
      { score: 3, text: "3 - Hardly at all" }
    ]
  },
  {
    index: 3,
    key: 'q3_blame',
    question: "In the past 7 days: I have blamed myself unnecessarily when things went wrong.",
    options: [
      { score: 3, text: "3 - Yes, most of the time" },
      { score: 2, text: "2 - Yes, some of the time" },
      { score: 1, text: "1 - Not very often" },
      { score: 0, text: "0 - No, never" }
    ]
  },
  {
    index: 4,
    key: 'q4_anxious',
    question: "In the past 7 days: I have been anxious or worried for no good reason.",
    options: [
      { score: 0, text: "0 - No, not at all" },
      { score: 1, text: "1 - Hardly ever" },
      { score: 2, text: "2 - Yes, sometimes" },
      { score: 3, text: "3 - Yes, very often" }
    ]
  },
  {
    index: 5,
    key: 'q5_scared',
    question: "In the past 7 days: I have felt scared or panicky for no very good reason.",
    options: [
      { score: 3, text: "3 - Yes, quite a lot" },
      { score: 2, text: "2 - Yes, sometimes" },
      { score: 1, text: "1 - No, not much" },
      { score: 0, text: "0 - No, not at all" }
    ]
  },
  {
    index: 6,
    key: 'q6_cope',
    question: "In the past 7 days: Things have been getting on top of me (difficult to cope).",
    options: [
      { score: 3, text: "3 - Yes, most of the time I haven't been able to cope" },
      { score: 2, text: "2 - Yes, sometimes I haven't been coping as well as usual" },
      { score: 1, text: "1 - No, most of the time I have coped quite well" },
      { score: 0, text: "0 - No, I have been coping as well as ever" }
    ]
  },
  {
    index: 7,
    key: 'q7_sleep',
    question: "In the past 7 days: I have been so unhappy that I have had difficulty sleeping.",
    options: [
      { score: 3, text: "3 - Yes, most of the time" },
      { score: 2, text: "2 - Yes, sometimes" },
      { score: 1, text: "1 - Not very often" },
      { score: 0, text: "0 - No, not at all" }
    ]
  },
  {
    index: 8,
    key: 'q8_sad',
    question: "In the past 7 days: I have felt sad or miserable.",
    options: [
      { score: 3, text: "3 - Yes, most of the time" },
      { score: 2, text: "2 - Yes, quite often" },
      { score: 1, text: "1 - Not very often" },
      { score: 0, text: "0 - No, not at all" }
    ]
  },
  {
    index: 9,
    key: 'q9_cry',
    question: "In the past 7 days: I have been so unhappy that I have been crying.",
    options: [
      { score: 3, text: "3 - Yes, most of the time" },
      { score: 2, text: "2 - Yes, quite often" },
      { score: 1, text: "1 - Only occasionally" },
      { score: 0, text: "0 - No, never" }
    ]
  },
  {
    index: 10,
    key: 'q10_selfharm',
    question: "In the past 7 days: The thought of harming myself has occurred to me.",
    options: [
      { score: 3, text: "3 - Yes, quite often" },
      { score: 2, text: "2 - Sometimes" },
      { score: 1, text: "1 - Hardly ever" },
      { score: 0, text: "0 - Never" }
    ]
  }
];

// =============================================================================
// PAGE ROUTING & PER-HOSPITAL SUBDOMAINS (hospital1.mumalink.com)
// =============================================================================
const RESERVED_SUBDOMAINS = new Set(['www', 'admin', 'api', 'app', 'mail', 'ftp']);

function sanitizeSubdomain(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

function extractSubdomain(req) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || req.hostname || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .split(':')[0];
  if (!rawHost) return null;

  if (rawHost.endsWith('.mumalink.com')) {
    const sub = rawHost.slice(0, -'.mumalink.com'.length);
    if (sub && sub !== 'www') return sub;
  }
  if (rawHost.endsWith('.localhost')) {
    const sub = rawHost.slice(0, -'.localhost'.length);
    if (sub && sub !== 'www') return sub;
  }
  return null;
}

app.get('/', async (req, res) => {
  try {
    const sub = extractSubdomain(req);
    if (sub === 'admin') {
      return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    }
    if (sub && !RESERVED_SUBDOMAINS.has(sub)) {
      return res.sendFile(path.join(__dirname, 'public', 'login.html'));
    }
  } catch (err) {
    console.error('Root tenant routing notice:', err.message);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/h/:subdomain', (req, res) => {
  const slug = sanitizeSubdomain(req.params.subdomain);
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .split(':')[0];
  if (slug && (rawHost === 'mumalink.com' || rawHost.endsWith('.mumalink.com'))) {
    return res.redirect(302, `https://${slug}.mumalink.com`);
  }
  res.redirect(`/login?hospital=${encodeURIComponent(slug)}`);
});

app.get(['/signup', '/register'], (_req, res) => {
  res.redirect('/login');
});

app.get(['/login', '/auth'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Subdomain / Hospital Tenant Context Lookup
app.get('/api/tenant', async (req, res) => {
  try {
    const slug = sanitizeSubdomain(req.query.hospital || extractSubdomain(req));
    if (!slug || RESERVED_SUBDOMAINS.has(slug)) {
      return res.json({ is_subdomain: false, subdomain: null, hospital: null });
    }
    const { rows } = await pool.query(
      'SELECT id, name, subdomain, state, phone, contact_email FROM hospitals WHERE LOWER(subdomain) = LOWER($1) LIMIT 1',
      [slug]
    );
    res.json({
      is_subdomain: rows.length > 0,
      subdomain: slug,
      hospital: rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(401).json({ error: 'Token expired or invalid.' });
    req.user = user;
    next();
  });
}

// =============================================================================
// CLINICIAN AUTH API
// =============================================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password, subdomain } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT c.*, h.name as hospital_name, h.subdomain as hospital_subdomain
      FROM clinicians c
      JOIN hospitals h ON c.hospital_id = h.id
      WHERE LOWER(c.email) = LOWER($1)
    `, [email.trim()]);

    if (rows.length === 0) {
      return res.status(401).json({ error: 'No clinician found with this email.' });
    }

    const clinician = rows[0];
    const isMatch = await bcrypt.compare(password, clinician.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid password credentials.' });
    }

    const activeSlug = sanitizeSubdomain(subdomain || extractSubdomain(req));
    if (activeSlug && !RESERVED_SUBDOMAINS.has(activeSlug)) {
      const { rows: hospRows } = await pool.query(
        'SELECT id, name FROM hospitals WHERE LOWER(subdomain) = LOWER($1) LIMIT 1',
        [activeSlug]
      );
      if (hospRows.length > 0 && clinician.hospital_id !== hospRows[0].id && clinician.role !== 'Super Admin') {
        return res.status(403).json({
          error: `This clinician account belongs to ${clinician.hospital_name}, not ${hospRows[0].name}.`
        });
      }
    }

    const token = jwt.sign(
      {
        id: clinician.id,
        hospital_id: clinician.hospital_id,
        hospital_name: clinician.hospital_name,
        hospital_subdomain: clinician.hospital_subdomain,
        full_name: clinician.full_name,
        email: clinician.email,
        role: clinician.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      clinician: {
        id: clinician.id,
        hospital_id: clinician.hospital_id,
        hospital_name: clinician.hospital_name,
        hospital_subdomain: clinician.hospital_subdomain,
        full_name: clinician.full_name,
        email: clinician.email,
        role: clinician.role
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
});

app.post('/api/auth/register', async (_req, res) => {
  return res.status(403).json({
    error: 'Public sign-up is disabled. Clinician accounts must be created by a MumaLINK Super Admin or an authorized Hospital team member on the dashboard.'
  });
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.hospital_id, c.full_name, c.email, c.role, h.name as hospital_name, h.subdomain as hospital_subdomain
      FROM clinicians c
      JOIN hospitals h ON c.hospital_id = h.id
      WHERE c.id = $1
    `, [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Clinician not found' });

    const clinician = rows[0];
    const activeSlug = sanitizeSubdomain(req.query.hospital || extractSubdomain(req));
    if (activeSlug && !RESERVED_SUBDOMAINS.has(activeSlug)) {
      const { rows: hospRows } = await pool.query(
        'SELECT id, name FROM hospitals WHERE LOWER(subdomain) = LOWER($1) LIMIT 1',
        [activeSlug]
      );
      if (hospRows.length > 0 && clinician.hospital_id !== hospRows[0].id && clinician.role !== 'Super Admin') {
        return res.status(403).json({
          error: `This clinician account belongs to ${clinician.hospital_name}, not ${hospRows[0].name}.`
        });
      }
    }

    res.json(clinician);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public List of Partner Hospitals (For Clinician Registration dropdown)
app.get('/api/hospitals/public', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, subdomain, state FROM hospitals ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All Partner Hospitals with metrics (For Dashboard & Hospital Management)
app.get('/api/hospitals', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        h.*,
        COUNT(DISTINCT m.id) as mothers_count,
        COUNT(DISTINCT c.id) as clinicians_count
      FROM hospitals h
      LEFT JOIN mothers m ON h.id = m.hospital_id
      LEFT JOIN clinicians c ON h.id = c.hospital_id
      GROUP BY h.id
      ORDER BY h.name ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register New Partner Hospital + Optional Initial Clinician Login (Super Admin only)
async function handleCreateHospital(req, res) {
  if (req.user.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Only Super Administrators can onboard new healthcare facilities.' });
  }

  const { name, subdomain, state, contact_email, phone, admin_name, admin_email, admin_password } = req.body;
  if (!name || !name.trim() || !state || !state.trim()) {
    return res.status(400).json({ error: 'Hospital name and state are required.' });
  }

  const slug = sanitizeSubdomain(subdomain || name.trim().replace(/\s+/g, '-').slice(0, 24));
  if (!slug || RESERVED_SUBDOMAINS.has(slug)) {
    return res.status(400).json({ error: 'Please provide a valid subdomain slug (e.g. hospital1).' });
  }

  if (admin_email && !admin_password) {
    return res.status(400).json({ error: 'Please enter a password for the initial hospital clinician account.' });
  }

  const id = 'hosp_' + Date.now().toString(36);
  try {
    const dupSub = await pool.query('SELECT id FROM hospitals WHERE LOWER(subdomain) = LOWER($1) LIMIT 1', [slug]);
    if (dupSub.rows.length > 0) {
      return res.status(400).json({ error: `The subdomain "${slug}.mumalink.com" is already assigned to another hospital.` });
    }

    if (admin_email && admin_email.trim()) {
      const dupDoc = await pool.query('SELECT id FROM clinicians WHERE LOWER(email) = LOWER($1) LIMIT 1', [admin_email.trim()]);
      if (dupDoc.rows.length > 0) {
        return res.status(400).json({ error: `A clinician account with email "${admin_email.trim()}" already exists.` });
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO hospitals (id, name, subdomain, state, contact_email, phone)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [id, name.trim(), slug, state.trim(), contact_email?.trim() || null, phone?.trim() || null]);

    let clinicianCreated = null;
    if (admin_email && admin_email.trim() && admin_password) {
      const docId = 'doc_' + Date.now().toString(36);
      const passwordHash = await bcrypt.hash(admin_password, 10);
      const clinicianName = (admin_name && admin_name.trim()) ? admin_name.trim() : `${name.trim()} Lead Clinician`;
      const docRes = await pool.query(`
        INSERT INTO clinicians (id, hospital_id, full_name, email, password_hash, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, full_name, email, role, hospital_id
      `, [docId, id, clinicianName, admin_email.trim(), passwordHash, 'Hospital Lead Clinician']);
      clinicianCreated = docRes.rows[0];
    }

    const portalSubdomainUrl = `https://${slug}.mumalink.com`;
    const directPortalUrl = `https://mumalink.com/h/${slug}`;
    const notifyList = [];
    if (contact_email && contact_email.trim()) notifyList.push({ email: contact_email.trim(), name: name.trim() });
    if (admin_email && admin_email.trim()) notifyList.push({ email: admin_email.trim(), name: admin_name?.trim() || name.trim() });
    if (req.user?.email) notifyList.push({ email: req.user.email, name: req.user.full_name });

    const emailRows = [
      { label: 'Clinic / Hospital Name', value: name.trim() },
      { label: 'State / Region', value: state.trim() },
      { label: 'Emergency Line', value: phone?.trim() || 'Not provided' },
      { label: 'Subdomain Portal', value: portalSubdomainUrl },
      { label: 'Direct Login URL', value: directPortalUrl }
    ];
    if (clinicianCreated) {
      emailRows.push({ label: 'Admin Full Name', value: clinicianCreated.full_name });
      emailRows.push({ label: 'Admin Login Email', value: clinicianCreated.email });
      emailRows.push({ label: 'Initial Password', value: admin_password });
    }

    const emailRes = await sendNotificationEmailSafe({
      to: notifyList,
      subject: `[MumaLINK] ${name.trim()} is Now Live on MumaLINK`,
      html: buildBrandedEmailHtml({
        badge: 'Clinic Live on MumaLINK',
        title: `${name.trim()} is Now Live`,
        subtitle: `Your clinic workspace has been created on MumaLINK. Authorized team members can sign in right away using your dedicated clinic portal link below.`,
        rows: emailRows,
        ctaLabel: 'Open Clinic Login Portal',
        ctaUrl: portalSubdomainUrl
      })
    });

    res.json({
      success: true,
      hospital: rows[0],
      clinician: clinicianCreated,
      email_dispatched: Boolean(emailRes?.success),
      email_recipients: emailRes?.recipients || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/hospitals', authenticateToken, handleCreateHospital);
app.post('/api/admin/hospitals', authenticateToken, handleCreateHospital);

async function sendClinicianAccessEmail({ clinician, hospital, passwordProvided, updated }) {
  const sub = hospital?.subdomain || '';
  const portalUrl = sub ? `https://${sub}.mumalink.com` : 'https://mumalink.com/login';
  const directUrl = sub ? `https://mumalink.com/h/${sub}` : 'https://mumalink.com/login';
  const toList = [{ email: clinician.email, name: clinician.full_name }];
  if (hospital?.contact_email) {
    toList.push({ email: hospital.contact_email, name: hospital.name });
  }

  return await sendNotificationEmailSafe({
    to: toList,
    subject: `[MumaLINK] Your Clinician Portal Access for ${hospital?.name || 'MumaLINK'}`,
    html: buildBrandedEmailHtml({
      badge: updated ? 'Clinician Access Updated' : 'Clinician Account Created',
      title: `Welcome, ${clinician.full_name}`,
      subtitle: updated
        ? `Your clinician account credentials for ${hospital?.name || 'your hospital'} on MumaLINK have been updated.`
        : `You have been added to ${hospital?.name || 'your hospital'} on MumaLINK. Sign in using your authorized portal link below.`,
      rows: [
        { label: 'Hospital / Clinic', value: hospital?.name || clinician.hospital_id },
        { label: 'Clinical Role', value: clinician.role },
        { label: 'Login Email', value: clinician.email },
        { label: 'Password', value: passwordProvided ? passwordProvided : 'Unchanged (use existing password)' },
        { label: 'Portal Subdomain', value: portalUrl },
        { label: 'Direct Login Link', value: directUrl }
      ],
      ctaLabel: 'Sign In to Clinic Portal',
      ctaUrl: portalUrl
    })
  });
}

// Create or Update Clinician Login for a Hospital (Super Admin only)
app.post('/api/admin/clinicians', authenticateToken, async (req, res) => {
  if (req.user.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Only Super Administrators can manage hospital logins.' });
  }

  const { full_name, email, password, role, hospital_id } = req.body;
  if (!full_name || !full_name.trim() || !email || !email.trim() || !hospital_id) {
    return res.status(400).json({ error: 'Full name, email, and target hospital are required.' });
  }

  try {
    const { rows: hospRows } = await pool.query('SELECT id, name, subdomain, contact_email FROM hospitals WHERE id = $1 LIMIT 1', [hospital_id]);
    const targetHospital = hospRows[0] || { id: hospital_id, name: hospital_id };

    const existing = await pool.query('SELECT id FROM clinicians WHERE LOWER(email) = LOWER($1) LIMIT 1', [email.trim()]);
    if (existing.rows.length > 0) {
      if (password && password.trim()) {
        const passwordHash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(`
          UPDATE clinicians
          SET full_name = $1, hospital_id = $2, role = $3, password_hash = $4
          WHERE id = $5
          RETURNING id, full_name, email, role, hospital_id
        `, [full_name.trim(), hospital_id, role || 'Hospital Lead Clinician', passwordHash, existing.rows[0].id]);
        const emailRes = await sendClinicianAccessEmail({ clinician: rows[0], hospital: targetHospital, passwordProvided: password, updated: true });
        return res.json({ success: true, clinician: rows[0], updated: true, email_dispatched: Boolean(emailRes?.success) });
      }
      const { rows } = await pool.query(`
        UPDATE clinicians
        SET full_name = $1, hospital_id = $2, role = $3
        WHERE id = $4
        RETURNING id, full_name, email, role, hospital_id
      `, [full_name.trim(), hospital_id, role || 'Hospital Lead Clinician', existing.rows[0].id]);
      const emailRes = await sendClinicianAccessEmail({ clinician: rows[0], hospital: targetHospital, passwordProvided: null, updated: true });
      return res.json({ success: true, clinician: rows[0], updated: true, email_dispatched: Boolean(emailRes?.success) });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password (minimum 6 characters) is required for new accounts.' });
    }

    const id = 'doc_' + Date.now().toString(36);
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(`
      INSERT INTO clinicians (id, hospital_id, full_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, full_name, email, role, hospital_id
    `, [id, hospital_id, full_name.trim(), email.trim(), passwordHash, role || 'Hospital Lead Clinician']);

    const emailRes = await sendClinicianAccessEmail({ clinician: rows[0], hospital: targetHospital, passwordProvided: password, updated: false });
    res.json({ success: true, clinician: rows[0], updated: false, email_dispatched: Boolean(emailRes?.success) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add Team Member by Hospital Member (Own Hospital) or Super Admin
app.post('/api/clinicians', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const { full_name, email, password, role, hospital_id } = req.body;

  if (!full_name || !full_name.trim() || !email || !email.trim()) {
    return res.status(400).json({ error: 'Clinician full name and email are required.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  const targetHospitalId = (isSuperAdmin && hospital_id && hospital_id !== 'all')
    ? hospital_id
    : req.user.hospital_id;

  const requestedRole = (role && role.trim()) || 'Maternal Health Specialist';
  const assignedRole = (!isSuperAdmin && requestedRole === 'Super Admin')
    ? 'Maternal Health Specialist'
    : requestedRole;

  try {
    const existing = await pool.query('SELECT id FROM clinicians WHERE LOWER(email) = LOWER($1) LIMIT 1', [email.trim()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: `A clinician account with email "${email.trim()}" already exists.` });
    }

    const { rows: hospRows } = await pool.query('SELECT id, name, subdomain, contact_email FROM hospitals WHERE id = $1 LIMIT 1', [targetHospitalId]);
    if (hospRows.length === 0) {
      return res.status(404).json({ error: 'Target hospital facility not found.' });
    }
    const targetHospital = hospRows[0];

    const id = 'doc_' + Date.now().toString(36);
    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(`
      INSERT INTO clinicians (id, hospital_id, full_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, full_name, email, role, hospital_id
    `, [id, targetHospitalId, full_name.trim(), email.trim(), passwordHash, assignedRole]);

    const emailRes = await sendClinicianAccessEmail({
      clinician: rows[0],
      hospital: targetHospital,
      passwordProvided: password,
      updated: false
    });

    res.json({
      success: true,
      clinician: rows[0],
      email_dispatched: Boolean(emailRes?.success),
      email_recipients: emailRes?.recipients || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List clinicians (Super Admin can filter or inspect network; Hospital staff strictly see their own hospital)
app.get('/api/clinicians', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const requestedHospital = req.query.hospital_id;
  let filterHospital = null;

  if (isSuperAdmin) {
    if (requestedHospital && requestedHospital !== 'all') {
      filterHospital = requestedHospital;
    }
  } else {
    filterHospital = req.user.hospital_id;
  }

  try {
    let query = `
      SELECT c.id, c.full_name, c.email, c.role, c.hospital_id, c.created_at, h.name as hospital_name
      FROM clinicians c
      LEFT JOIN hospitals h ON c.hospital_id = h.id
    `;
    const params = [];
    if (filterHospital) {
      params.push(filterHospital);
      query += ' WHERE c.hospital_id = $1';
    }
    query += ' ORDER BY c.created_at DESC';

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Super Admin Bird's-Eye Overview: Network & Per-Hospital KPIs, Mothers, and WhatsApp Chats
app.get('/api/admin/overview', authenticateToken, async (req, res) => {
  if (req.user.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Only Super Administrators can access the network overview.' });
  }

  const requestedHospital = req.query.hospital_id;
  const filterHospital = (requestedHospital && requestedHospital !== 'all') ? requestedHospital : null;

  try {
    const params = filterHospital ? [filterHospital] : [];
    const hospWhereM = filterHospital ? 'WHERE m.hospital_id = $1' : '';
    const hospWhereW = filterHospital ? 'WHERE m.hospital_id = $1' : '';
    const hospWhereC = filterHospital ? 'WHERE c.hospital_id = $1' : '';

    const [hospRes, kpiRes, clinCountRes, msgCountRes, mothersRes, recentMsgsRes] = await Promise.all([
      filterHospital
        ? pool.query('SELECT * FROM hospitals WHERE id = $1', [filterHospital])
        : pool.query('SELECT COUNT(*)::int AS total_hospitals FROM hospitals'),
      pool.query(`
        SELECT
          COUNT(*)::int AS total_mothers,
          COALESCE(SUM(CASE WHEN current_risk_tier = 'critical' THEN 1 ELSE 0 END), 0)::int AS critical_count,
          COALESCE(SUM(CASE WHEN current_risk_tier = 'moderate' THEN 1 ELSE 0 END), 0)::int AS moderate_count,
          COALESCE(SUM(CASE WHEN current_risk_tier = 'normal' THEN 1 ELSE 0 END), 0)::int AS normal_count
        FROM mothers m
        ${hospWhereM}
      `, params),
      pool.query(`SELECT COUNT(*)::int AS total_clinicians FROM clinicians c ${hospWhereC}`, params),
      pool.query(`
        SELECT COUNT(*)::int AS total_messages
        FROM whatsapp_messages w
        JOIN mothers m ON w.mother_id = m.id
        ${hospWhereW}
      `, params),
      pool.query(`
        SELECT m.*,
          h.name AS hospital_name,
          h.subdomain AS hospital_subdomain,
          (SELECT COUNT(*)::int FROM whatsapp_messages wm WHERE wm.mother_id = m.id) AS messages_count,
          (SELECT wm.message FROM whatsapp_messages wm WHERE wm.mother_id = m.id ORDER BY wm.created_at DESC LIMIT 1) AS last_whatsapp_message,
          (SELECT wm.created_at FROM whatsapp_messages wm WHERE wm.mother_id = m.id ORDER BY wm.created_at DESC LIMIT 1) AS last_message_at,
          (SELECT wm.sender_type FROM whatsapp_messages wm WHERE wm.mother_id = m.id ORDER BY wm.created_at DESC LIMIT 1) AS last_sender_type
        FROM mothers m
        JOIN hospitals h ON m.hospital_id = h.id
        ${hospWhereM}
        ORDER BY
          CASE m.current_risk_tier WHEN 'critical' THEN 1 WHEN 'moderate' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
          COALESCE((SELECT MAX(wm.created_at) FROM whatsapp_messages wm WHERE wm.mother_id = m.id), m.last_checkin_date, m.delivery_date::timestamp) DESC
      `, params),
      pool.query(`
        SELECT w.*, m.full_name AS mother_name, m.phone_number AS mother_phone, h.name AS hospital_name, h.subdomain AS hospital_subdomain
        FROM whatsapp_messages w
        JOIN mothers m ON w.mother_id = m.id
        JOIN hospitals h ON m.hospital_id = h.id
        ${hospWhereW}
        ORDER BY w.created_at DESC
        LIMIT 40
      `, params)
    ]);

    const selectedHospital = filterHospital ? (hospRes.rows[0] || null) : null;
    const totalHospitals = filterHospital ? (selectedHospital ? 1 : 0) : (hospRes.rows[0]?.total_hospitals || 0);

    res.json({
      hospital: selectedHospital,
      stats: {
        total_hospitals: totalHospitals,
        total_mothers: kpiRes.rows[0]?.total_mothers || 0,
        critical_count: kpiRes.rows[0]?.critical_count || 0,
        moderate_count: kpiRes.rows[0]?.moderate_count || 0,
        normal_count: kpiRes.rows[0]?.normal_count || 0,
        total_clinicians: clinCountRes.rows[0]?.total_clinicians || 0,
        total_messages: msgCountRes.rows[0]?.total_messages || 0
      },
      mothers: mothersRes.rows,
      recent_messages: recentMsgsRes.rows
    });
  } catch (err) {
    console.error('Admin overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reassign clinician to hospital (Super Admin only)
app.post('/api/clinicians/assign-hospital', authenticateToken, async (req, res) => {
  if (req.user.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Super Admin access required.' });
  }

  const { clinician_id, hospital_id } = req.body;
  if (!clinician_id || !hospital_id) {
    return res.status(400).json({ error: 'clinician_id and hospital_id are required.' });
  }

  try {
    await pool.query('UPDATE clinicians SET hospital_id = $1 WHERE id = $2', [hospital_id, clinician_id]);
    res.json({ success: true, message: 'Clinician reassigned successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// CLINICIAN DASHBOARD DATA (RENDER POSTGRESQL REAL DATA)
// =============================================================================

// 1. Dashboard KPI Metrics (Multi-tenant & Network Overview)
app.get('/api/stats', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const requestedHospital = req.query.hospital_id;
  let filterHospital = null;
  if (!isSuperAdmin) {
    filterHospital = req.user.hospital_id;
  } else if (requestedHospital && requestedHospital !== 'all') {
    filterHospital = requestedHospital;
  }

  try {
    let statsQuery = `
      SELECT 
        COUNT(*) as total_mothers,
        SUM(CASE WHEN current_risk_tier = 'critical' THEN 1 ELSE 0 END) as critical_count,
        SUM(CASE WHEN current_risk_tier = 'moderate' THEN 1 ELSE 0 END) as moderate_count,
        SUM(CASE WHEN current_risk_tier = 'normal' THEN 1 ELSE 0 END) as normal_count
      FROM mothers
    `;
    const params = [];
    if (filterHospital) {
      params.push(filterHospital);
      statsQuery += ` WHERE hospital_id = $1`;
    }

    const statsResult = await pool.query(statsQuery, params);

    let checkinQuery = `SELECT COUNT(*) as count FROM checkins WHERE DATE(created_at) = CURRENT_DATE`;
    const checkinParams = [];
    if (filterHospital) {
      checkinParams.push(filterHospital);
      checkinQuery += ` AND hospital_id = $1`;
    }
    const checkinsToday = await pool.query(checkinQuery, checkinParams);

    let hospitalName = 'Network Overview (All Partner Hospitals)';
    if (filterHospital) {
      const { rows: hospRows } = await pool.query('SELECT name FROM hospitals WHERE id = $1', [filterHospital]);
      hospitalName = hospRows.length > 0 ? hospRows[0].name : 'Mother & Child Hospital';
    }

    const row = statsResult.rows[0];
    res.json({
      total_mothers: parseInt(row.total_mothers, 10) || 0,
      critical_count: parseInt(row.critical_count, 10) || 0,
      moderate_count: parseInt(row.moderate_count, 10) || 0,
      normal_count: parseInt(row.normal_count, 10) || 0,
      today_checkins: parseInt(checkinsToday.rows[0].count, 10) || 0,
      pilot_hospital: hospitalName,
      lead_clinician: req.user.full_name,
      is_super_admin: isSuperAdmin,
      current_hospital_id: filterHospital || 'all'
    });

  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Live Clinical Triage Notifications from PostgreSQL (checkins, clinical notes, whatsapp messages)
app.get('/api/notifications', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const requestedHospital = req.query.hospital_id;
  let filterHospital = null;
  if (!isSuperAdmin) {
    filterHospital = req.user.hospital_id;
  } else if (requestedHospital && requestedHospital !== 'all') {
    filterHospital = requestedHospital;
  }

  try {
    const params = filterHospital ? [filterHospital] : [];
    const hospWhere = filterHospital ? 'WHERE m.hospital_id = $1' : '';

    const [checkinsRes, notesRes, msgsRes] = await Promise.all([
      pool.query(`
        SELECT c.id, c.mother_id, c.checkin_day_label, c.epds_score, c.risk_tier, c.mother_notes, c.created_at,
               m.full_name as mother_name
        FROM checkins c
        JOIN mothers m ON c.mother_id = m.id
        ${hospWhere}
        ORDER BY c.created_at DESC
        LIMIT 12
      `, params),
      pool.query(`
        SELECT n.id, n.mother_id, n.clinician_name, n.action_type, n.note, n.resolved_alert, n.created_at,
               m.full_name as mother_name
        FROM clinical_notes n
        JOIN mothers m ON n.mother_id = m.id
        ${hospWhere}
        ORDER BY n.created_at DESC
        LIMIT 12
      `, params),
      pool.query(`
        SELECT w.id, w.mother_id, w.direction, w.sender_type, w.sender_name, w.message, w.created_at,
               m.full_name as mother_name
        FROM whatsapp_messages w
        JOIN mothers m ON w.mother_id = m.id
        ${hospWhere}
        ORDER BY w.created_at DESC
        LIMIT 12
      `, params)
    ]);

    const notifications = [];

    checkinsRes.rows.forEach(c => {
      const severity = c.risk_tier === 'critical' ? 'critical' : (c.risk_tier === 'moderate' ? 'moderate' : 'normal');
      const title = c.risk_tier === 'critical'
        ? `Critical Risk Flagged — ${c.mother_name}`
        : (c.risk_tier === 'moderate' ? `Moderate Distress Flagged — ${c.mother_name}` : `Check-in Completed — ${c.mother_name}`);
      const noteSnippet = c.mother_notes ? ` — ${String(c.mother_notes).slice(0, 120)}` : '';
      notifications.push({
        id: 'chk_' + c.id,
        type: 'checkin',
        severity,
        mother_id: c.mother_id,
        title,
        description: `${c.checkin_day_label} (EPDS ${c.epds_score}/30)${noteSnippet}`,
        created_at: c.created_at
      });
    });

    notesRes.rows.forEach(n => {
      notifications.push({
        id: 'note_' + n.id,
        type: 'note',
        severity: 'info',
        mother_id: n.mother_id,
        title: `Intervention Logged — ${n.mother_name}`,
        description: `${n.clinician_name} (${n.action_type}): ${String(n.note).slice(0, 120)}`,
        created_at: n.created_at
      });
    });

    msgsRes.rows.forEach(w => {
      const isInbound = w.direction === 'inbound';
      notifications.push({
        id: 'msg_' + w.id,
        type: 'whatsapp',
        severity: isInbound ? 'info' : 'normal',
        mother_id: w.mother_id,
        title: isInbound ? `Inbound WhatsApp — ${w.mother_name}` : `WhatsApp Dispatched — ${w.mother_name}`,
        description: String(w.message || '').slice(0, 140),
        created_at: w.created_at
      });
    });

    notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(notifications.slice(0, 20));
  } catch (err) {
    console.error('Notifications query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Live Hospital Facility Settings (PostgreSQL + Infobip Gateway Status)
app.get('/api/hospital-settings', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const requestedHospital = req.query.hospital_id;
  let targetHospitalId = req.user.hospital_id;

  if (isSuperAdmin && requestedHospital && requestedHospital !== 'all') {
    targetHospitalId = requestedHospital;
  }

  try {
    let { rows } = await pool.query(`
      SELECT h.*,
        (SELECT COUNT(*)::int FROM mothers m WHERE m.hospital_id = h.id) AS mothers_count,
        (SELECT COUNT(*)::int FROM clinicians c WHERE c.hospital_id = h.id) AS clinicians_count
      FROM hospitals h
      WHERE h.id = $1
    `, [targetHospitalId]);

    if (rows.length === 0) {
      const fallback = await pool.query(`
        SELECT h.*,
          (SELECT COUNT(*)::int FROM mothers m WHERE m.hospital_id = h.id) AS mothers_count,
          (SELECT COUNT(*)::int FROM clinicians c WHERE c.hospital_id = h.id) AS clinicians_count
        FROM hospitals h
        ORDER BY h.created_at ASC
        LIMIT 1
      `);
      rows = fallback.rows;
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No hospital facility found in database.' });
    }

    const senderNum = String(process.env.INFOBIP_SENDER || '2348138048129').replace(/[^\d]/g, '');
    const formattedSender = senderNum.startsWith('234') && senderNum.length === 13
      ? `+234 ${senderNum.slice(3, 6)} ${senderNum.slice(6, 9)} ${senderNum.slice(9)}`
      : `+${senderNum}`;
    const whatsapp_gateway = infobip.isConfigured()
      ? `${formattedSender} • Active`
      : 'WhatsApp Line Inactive';

    res.json({
      hospital: rows[0],
      surveillance_window: '42 Days Post-Discharge (WHO Standard)',
      whatsapp_gateway,
      can_edit: isSuperAdmin || req.user.hospital_id === rows[0].id
    });
  } catch (err) {
    console.error('Get hospital settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/hospital-settings', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const { hospital_id, name, subdomain, state, phone, contact_email } = req.body;
  const targetHospitalId = (isSuperAdmin && hospital_id && hospital_id !== 'all') ? hospital_id : req.user.hospital_id;

  if (!isSuperAdmin && targetHospitalId !== req.user.hospital_id) {
    return res.status(403).json({ error: 'Not authorized to update another hospital.' });
  }

  if (!name || !name.trim() || !state || !state.trim()) {
    return res.status(400).json({ error: 'Hospital name and state are required.' });
  }

  const cleanSub = subdomain ? sanitizeSubdomain(subdomain) : null;
  if (cleanSub && RESERVED_SUBDOMAINS.has(cleanSub)) {
    return res.status(400).json({ error: 'That subdomain name is reserved.' });
  }

  try {
    if (cleanSub) {
      const dup = await pool.query(
        'SELECT id FROM hospitals WHERE LOWER(subdomain) = LOWER($1) AND id <> $2 LIMIT 1',
        [cleanSub, targetHospitalId]
      );
      if (dup.rows.length > 0) {
        return res.status(400).json({ error: `Subdomain "${cleanSub}.mumalink.com" is already in use.` });
      }
    }

    const { rows } = await pool.query(`
      UPDATE hospitals
      SET name = $1, state = $2, phone = $3, contact_email = $4, subdomain = COALESCE($5, subdomain)
      WHERE id = $6
      RETURNING *
    `, [name.trim(), state.trim(), phone ? phone.trim() : null, contact_email ? contact_email.trim() : null, cleanSub, targetHospitalId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Hospital record not found.' });
    }

    res.json({ success: true, hospital: rows[0] });
  } catch (err) {
    console.error('Update hospital settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 2. Patient Roster & Triage Filtering (Multi-tenant & Network Overview)
app.get('/api/mothers', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const requestedHospital = req.query.hospital_id;
  let filterHospital = null;
  if (!isSuperAdmin) {
    filterHospital = req.user.hospital_id;
  } else if (requestedHospital && requestedHospital !== 'all') {
    filterHospital = requestedHospital;
  }

  const { tier, search } = req.query;
  const conditions = [];
  const params = [];

  if (filterHospital) {
    params.push(filterHospital);
    conditions.push(`m.hospital_id = $${params.length}`);
  }

  if (tier && tier !== 'all') {
    params.push(tier);
    conditions.push(`m.current_risk_tier = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(m.full_name ILIKE $${params.length} OR m.phone_number ILIKE $${params.length})`);
  }

  let query = `
    SELECT m.*,
      h.name AS hospital_name,
      (
        SELECT wm.message FROM whatsapp_messages wm
        WHERE wm.mother_id = m.id
        ORDER BY wm.created_at DESC
        LIMIT 1
      ) AS last_whatsapp_message,
      (
        SELECT ch.mother_notes FROM checkins ch
        WHERE ch.mother_id = m.id
        ORDER BY ch.created_at DESC
        LIMIT 1
      ) AS last_mother_note
    FROM mothers m
    LEFT JOIN hospitals h ON m.hospital_id = h.id
  `;
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += `
    ORDER BY 
      CASE m.current_risk_tier
        WHEN 'critical' THEN 1
        WHEN 'moderate' THEN 2
        WHEN 'normal' THEN 3
        ELSE 4
      END,
      m.last_checkin_date DESC NULLS LAST
  `;

  try {
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Mothers query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 3. Mother Deep-Dive (Patient Drawer)
app.get('/api/mothers/:id', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const { id } = req.params;

  try {
    let motherRes;
    if (isSuperAdmin) {
      motherRes = await pool.query('SELECT * FROM mothers WHERE id = $1', [id]);
    } else {
      motherRes = await pool.query(
        'SELECT * FROM mothers WHERE id = $1 AND hospital_id = $2',
        [id, req.user.hospital_id]
      );
    }

    if (motherRes.rows.length === 0) {
      return res.status(404).json({ error: 'Mother record not found.' });
    }

    const checkinsRes = await pool.query(
      'SELECT * FROM checkins WHERE mother_id = $1 ORDER BY created_at DESC',
      [id]
    );

    const notesRes = await pool.query(
      'SELECT * FROM clinical_notes WHERE mother_id = $1 ORDER BY created_at DESC',
      [id]
    );

    res.json({
      mother: motherRes.rows[0],
      checkins: checkinsRes.rows,
      notes: notesRes.rows
    });

  } catch (err) {
    console.error('Mother detail error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Enroll Mother Post-Discharge
app.post('/api/mothers', authenticateToken, async (req, res) => {
  const isSuperAdmin = req.user.role === 'Super Admin';
  const hospital_id = (isSuperAdmin && req.body.hospital_id) ? req.body.hospital_id : req.user.hospital_id;
  const { full_name, baby_name, phone_number, delivery_date, delivery_type, parity } = req.body;

  if (!full_name || !phone_number || !delivery_date) {
    return res.status(400).json({ error: 'Full name, WhatsApp phone number, and delivery date are required.' });
  }

  const normalizedPhone = normalizePhoneNumber(phone_number);
  const cleanDigits = normalizedPhone.replace(/[^\d]/g, '');
  if (cleanDigits.length < 8) {
    return res.status(400).json({ error: 'Please enter a valid WhatsApp phone number with country code.' });
  }

  const id = 'mom_' + Date.now().toString(36);
  const enrolled_date = new Date().toISOString().split('T')[0];

  try {
    const existing = await pool.query(
      "SELECT id FROM mothers WHERE REPLACE(REPLACE(REPLACE(phone_number, ' ', ''), '-', ''), '+', '') LIKE $1 LIMIT 1",
      [`%${cleanDigits.slice(-10)}%`]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'A mother with this phone number is already enrolled.' });
    }

    const { rows: hospRows } = await pool.query('SELECT name, phone, subdomain FROM hospitals WHERE id = $1', [hospital_id]);
    const hospitalName = hospRows.length > 0 ? hospRows[0].name : 'Mother & Child Hospital';
    const hospitalPhone = hospRows.length > 0 ? hospRows[0].phone : null;
    const hospitalSubdomain = hospRows.length > 0 ? hospRows[0].subdomain : null;

    await pool.query(`
      INSERT INTO mothers (
        id, hospital_id, full_name, baby_name, phone_number, delivery_date, delivery_type, parity,
        enrolled_date, current_risk_tier, last_score, status, conversation_state, last_checkin_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'normal', 0, 'active', 'AWAITING_MOOD', CURRENT_TIMESTAMP)
    `, [
      id,
      hospital_id,
      full_name.trim(),
      baby_name ? baby_name.trim() : null,
      normalizedPhone,
      delivery_date,
      delivery_type || 'Spontaneous Vaginal Delivery',
      parity || 'Primiparous (First-time mother)',
      enrolled_date
    ]);

    const motherObj = {
      id,
      hospital_id,
      hospital_name: hospitalName,
      hospital_phone: hospitalPhone,
      full_name: full_name.trim(),
      baby_name: baby_name ? baby_name.trim() : null,
      phone_number: normalizedPhone
    };

    const greetingMessage = buildInitialGreetingMessage(motherObj);
    const dispatchResult = await sendWhatsAppAndLog(motherObj, greetingMessage, 'bot', 'MumaLINK Care Bot', {
      templateName: 'mumalink_checkin_initial',
      placeholders: [motherObj.full_name, hospitalName]
    });

    const enrollRecipients = await getHospitalRecipients(hospital_id);
    const portalDashUrl = hospitalSubdomain ? `https://${hospitalSubdomain}.mumalink.com/dashboard` : 'https://mumalink.com/dashboard';
    await sendNotificationEmailSafe({
      to: enrollRecipients,
      subject: `[MumaLINK Enrollment] ${motherObj.full_name} Enrolled for 42-Day Postpartum Surveillance`,
      html: buildBrandedEmailHtml({
        badge: 'Patient Post-Discharge Enrollment',
        title: `New Mother Enrolled: ${motherObj.full_name}`,
        subtitle: `Enrolled at ${hospitalName} by ${req.user.full_name}. Immediate WhatsApp post-discharge greeting was triggered.`,
        rows: [
          { label: 'Mother Name', value: motherObj.full_name },
          { label: 'Baby Name', value: motherObj.baby_name || 'Not specified' },
          { label: 'WhatsApp Phone', value: normalizedPhone },
          { label: 'Delivery Date', value: delivery_date },
          { label: 'Delivery Type', value: delivery_type || 'Spontaneous Vaginal Delivery' },
          { label: 'WhatsApp Greeting', value: (dispatchResult && (dispatchResult.success || dispatchResult.simulated)) ? 'Dispatched immediately' : 'Queued / Fallback logged' }
        ],
        ctaLabel: 'View Patient in Triage Dashboard',
        ctaUrl: portalDashUrl
      })
    });

    console.log(`[Enrollment] Mother ${motherObj.full_name} enrolled (${normalizedPhone}). Immediate WhatsApp greeting dispatched.`);

    res.json({
      success: true,
      mother_id: id,
      whatsapp_dispatched: Boolean(dispatchResult && (dispatchResult.success || dispatchResult.simulated))
    });

  } catch (err) {
    console.error('Enroll error:', err);
    if (err.code === '23505') {
      return res.status(400).json({ error: 'A mother with this phone number is already enrolled.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// 5. Add Clinical Intervention Note
app.post('/api/mothers/:id/notes', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { action_type, note, resolved_alert } = req.body;
  const isSuperAdmin = req.user.role === 'Super Admin';

  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'Clinical note cannot be empty.' });
  }

  const noteId = 'note_' + Date.now().toString(36);
  const clinician_name = req.user.full_name;

  try {
    const motherRes = isSuperAdmin
      ? await pool.query('SELECT m.*, h.name as hospital_name, h.subdomain as hospital_subdomain FROM mothers m LEFT JOIN hospitals h ON m.hospital_id = h.id WHERE m.id = $1', [id])
      : await pool.query('SELECT m.*, h.name as hospital_name, h.subdomain as hospital_subdomain FROM mothers m LEFT JOIN hospitals h ON m.hospital_id = h.id WHERE m.id = $1 AND m.hospital_id = $2', [id, req.user.hospital_id]);

    if (motherRes.rows.length === 0) {
      return res.status(404).json({ error: 'Mother record not found or unauthorized.' });
    }
    const mother = motherRes.rows[0];

    await pool.query(`
      INSERT INTO clinical_notes (id, mother_id, clinician_name, action_type, note, resolved_alert)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [noteId, id, clinician_name, action_type || 'observation', note.trim(), resolved_alert ? true : false]);

    if (resolved_alert) {
      await pool.query(
        "UPDATE mothers SET current_risk_tier = 'moderate' WHERE id = $1 AND current_risk_tier = 'critical'",
        [id]
      );
    }

    await pool.query('UPDATE mothers SET notes_count = notes_count + 1 WHERE id = $1', [id]);

    const recipients = await getHospitalRecipients(mother.hospital_id);
    const dashUrl = mother.hospital_subdomain ? `https://${mother.hospital_subdomain}.mumalink.com/dashboard` : 'https://mumalink.com/dashboard';
    await sendNotificationEmailSafe({
      to: recipients,
      subject: `[MumaLINK Triage Update] Clinical Note Logged for ${mother.full_name}`,
      html: buildBrandedEmailHtml({
        badge: 'Clinical Intervention Logged',
        title: `Triage Update: ${mother.full_name}`,
        subtitle: `${clinician_name} recorded a clinical intervention note at ${mother.hospital_name || 'your facility'}.`,
        rows: [
          { label: 'Patient', value: mother.full_name },
          { label: 'Clinician', value: clinician_name },
          { label: 'Action Type', value: action_type || 'observation' },
          { label: 'Clinical Note', value: note.trim() },
          { label: 'Alert Stepped Down', value: resolved_alert ? 'Yes (Moved from Critical to Moderate)' : 'No' }
        ],
        ctaLabel: 'Open Patient Record',
        ctaUrl: dashUrl
      })
    });

    res.json({ success: true, note_id: noteId });

  } catch (err) {
    console.error('Note add error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper to record a message in the live PostgreSQL chat stream
async function logWhatsAppMessage({ mother_id, hospital_id, direction, sender_type, sender_name, message, sendpulse_message_id }) {
  if (!mother_id || !message) return;
  try {
    const id = 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
    await pool.query(`
      INSERT INTO whatsapp_messages (id, mother_id, hospital_id, direction, sender_type, sender_name, message, sendpulse_message_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, mother_id, hospital_id || null, direction, sender_type, sender_name || null, message, sendpulse_message_id || null]);
  } catch (err) {
    console.error('[Chat Logger Error]:', err);
  }
}

// Primary WhatsApp Dispatcher: Infobip (Primary Carrier) with SendPulse fallback
async function dispatchOutboundWhatsApp(mother, text, options = {}) {
  if (infobip.isConfigured()) {
    try {
      if (options.templateName) {
        const tmplRes = await infobip.sendWhatsAppTemplate({
          to: mother.phone_number,
          templateName: options.templateName,
          placeholders: options.placeholders || []
        });
        if (tmplRes && tmplRes.success) {
          return tmplRes;
        }
        console.warn(`[Infobip] Template ${options.templateName} notice, falling back to session text message...`);
      }
      const res = await infobip.sendMessage(mother, text);
      if (res && res.success) {
        return res;
      }
      console.warn('[Infobip] Delivery notice, attempting fallback carrier if available...');
    } catch (err) {
      console.error('[Infobip Exception]:', err.message);
    }
  }
  return await sendpulse.sendMessage(mother, text);
}

// Unified helper to send via WhatsApp (Infobip primary) and immediately record into live chat history
async function sendWhatsAppAndLog(mother, text, sender_type = 'bot', sender_name = 'MumaLINK Bot', options = {}) {
  if (!mother || !text) return null;
  const res = await dispatchOutboundWhatsApp(mother, text, options);
  await logWhatsAppMessage({
    mother_id: mother.id,
    hospital_id: mother.hospital_id,
    direction: 'outbound',
    sender_type,
    sender_name,
    message: text
  });
  return res;
}

// 6. Direct Trigger: Send WhatsApp Check-in to Mother from Dashboard
app.post('/api/mothers/:id/send-checkin', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const isSuperAdmin = req.user.role === 'Super Admin';

  try {
    const querySql = isSuperAdmin
      ? `SELECT m.*, h.name as hospital_name, (CURRENT_DATE - m.delivery_date) as postpartum_days FROM mothers m JOIN hospitals h ON m.hospital_id = h.id WHERE m.id = $1`
      : `SELECT m.*, h.name as hospital_name, (CURRENT_DATE - m.delivery_date) as postpartum_days FROM mothers m JOIN hospitals h ON m.hospital_id = h.id WHERE m.id = $1 AND m.hospital_id = $2`;
    const params = isSuperAdmin ? [id] : [id, req.user.hospital_id];
    const { rows } = await pool.query(querySql, params);

    if (rows.length === 0) return res.status(404).json({ error: 'Mother not found or unauthorized.' });
    const mother = rows[0];
    const days = parseInt(mother.postpartum_days, 10) || 0;
    const isInitial = !mother.last_checkin_date || days <= 5;
    const templateName = isInitial ? 'mumalink_checkin_initial' : 'mumalink_checkin_followup';
    const greetingMessage = isInitial ? buildInitialGreetingMessage(mother) : buildFollowupGreetingMessage(mother);

    await sendWhatsAppAndLog(mother, greetingMessage, 'clinician', req.user.full_name, {
      templateName,
      placeholders: [mother.full_name, mother.hospital_name]
    });

    await pool.query(
      "UPDATE mothers SET conversation_state = 'AWAITING_MOOD', last_checkin_date = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );

    res.json({
      success: true,
      message: `WhatsApp check-in dispatched to ${mother.full_name} (${mother.phone_number}).`
    });
  } catch (err) {
    console.error('Send check-in error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Automated Postpartum Surveillance Scheduler (Founder cadence: Week 1 negative follow-up / Day 14 routine follow-up)
async function runAutomatedPostpartumCheckins() {
  try {
    const query = `
      SELECT m.*, h.name as hospital_name,
             (CURRENT_DATE - m.delivery_date) as postpartum_days,
             (CURRENT_DATE - COALESCE(m.last_checkin_date::date, '2000-01-01'::date)) as days_since_last_checkin
      FROM mothers m
      JOIN hospitals h ON m.hospital_id = h.id
      WHERE m.status = 'active'
        AND COALESCE(m.conversation_state, 'IDLE') NOT LIKE 'EPDS_Q%'
        AND COALESCE(m.conversation_state, 'IDLE') <> 'AWAITING_EPDS_CONSENT'
        AND (
          m.last_checkin_date IS NULL
          OR (COALESCE(m.consecutive_negative_moods, 0) >= 1 AND (CURRENT_DATE - m.last_checkin_date::date) >= 7)
          OR (CURRENT_DATE - m.last_checkin_date::date) >= 14
        )
    `;
    const { rows } = await pool.query(query);

    for (const mother of rows) {
      const days = parseInt(mother.postpartum_days, 10) || 0;
      const useInitial = !mother.last_checkin_date || days <= 5;
      const templateName = useInitial ? 'mumalink_checkin_initial' : 'mumalink_checkin_followup';
      const messageText = useInitial ? buildInitialGreetingMessage(mother) : buildFollowupGreetingMessage(mother);

      console.log(`[Automated Check-in] Triggering Day ${days} surveillance (${templateName}) for ${mother.full_name} (${mother.phone_number})`);
      await sendWhatsAppAndLog(mother, messageText, 'bot', 'MumaLINK Automated Surveillance', {
        templateName,
        placeholders: [mother.full_name, mother.hospital_name]
      });

      await pool.query(
        "UPDATE mothers SET conversation_state = 'AWAITING_MOOD', last_checkin_date = CURRENT_TIMESTAMP WHERE id = $1",
        [mother.id]
      );
    }
  } catch (err) {
    console.error('[Automated Check-in Error]:', err.message);
  }
}

// Run check-in scan every 30 minutes in background
setInterval(runAutomatedPostpartumCheckins, 30 * 60 * 1000);

// Endpoint to view WhatsApp template approval status
app.get('/api/whatsapp/templates', authenticateToken, async (req, res) => {
  try {
    const key = process.env.INFOBIP_API_KEY;
    const sender = process.env.INFOBIP_SENDER || '2348138048129';
    if (!key) return res.json({ templates: [] });

    const response = await axios.get(`https://api.infobip.com/whatsapp/2/senders/${sender}/templates`, {
      headers: { 'Authorization': `App ${key}` },
      timeout: 10000
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Get WhatsApp Chat Stream (Two-way live conversation history)
app.get('/api/mothers/:id/messages', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const isSuperAdmin = req.user.role === 'Super Admin';

  try {
    let motherCheck;
    if (isSuperAdmin) {
      motherCheck = await pool.query('SELECT id, full_name, phone_number, current_risk_tier, sendpulse_contact_id FROM mothers WHERE id = $1', [id]);
    } else {
      motherCheck = await pool.query('SELECT id, full_name, phone_number, current_risk_tier, sendpulse_contact_id FROM mothers WHERE id = $1 AND hospital_id = $2', [id, req.user.hospital_id]);
    }

    if (motherCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Mother record not found.' });
    }

    const { rows: messages } = await pool.query(`
      SELECT * FROM whatsapp_messages
      WHERE mother_id = $1
      ORDER BY created_at ASC
    `, [id]);

    res.json({
      mother: motherCheck.rows[0],
      messages
    });
  } catch (err) {
    console.error('Fetch messages error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 8. Send WhatsApp Message from Web Dashboard (Live Two-Way Real-time Chat)
app.post('/api/mothers/:id/messages', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { message } = req.body;
  const isSuperAdmin = req.user.role === 'Super Admin';

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  try {
    let motherCheck;
    if (isSuperAdmin) {
      motherCheck = await pool.query('SELECT * FROM mothers WHERE id = $1', [id]);
    } else {
      motherCheck = await pool.query('SELECT * FROM mothers WHERE id = $1 AND hospital_id = $2', [id, req.user.hospital_id]);
    }

    if (motherCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Mother record not found or unauthorized.' });
    }

    const mother = motherCheck.rows[0];

    // Dispatch live to WhatsApp via Infobip (or SendPulse fallback)
    const dispatchResult = await dispatchOutboundWhatsApp(mother, message.trim());

    // Record into PostgreSQL chat table
    const msgId = 'msg_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5);
    const { rows } = await pool.query(`
      INSERT INTO whatsapp_messages (id, mother_id, hospital_id, direction, sender_type, sender_name, message, status)
      VALUES ($1, $2, $3, 'outbound', 'clinician', $4, $5, 'delivered')
      RETURNING *
    `, [msgId, mother.id, mother.hospital_id, req.user.full_name, message.trim()]);

    await pool.query('UPDATE mothers SET last_checkin_date = CURRENT_TIMESTAMP WHERE id = $1', [mother.id]);

    res.json({
      success: true,
      message: rows[0],
      dispatchResult
    });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// WHATSAPP WEBHOOK (INFOBIP MO_OTT_CONTACT & SENDPULSE UNIVERSAL PROCESSOR)
// =============================================================================
const WEBHOOK_PATHS = [
  '/api/webhook/sendpulse',
  '/api/webhook/whatsapp',
  '/api/webhook/infobip',
  '/api/webhook/infobip/whatsapp'
];

// Verification GET routes for Webhook endpoints
app.get(WEBHOOK_PATHS, (_req, res) => {
  res.status(200).send('MumaLINK WhatsApp Webhook Active (Infobip & SendPulse)');
});

// Central Incoming WhatsApp Message Processor
async function processIncomingMotherMessage({ rawPhone, incomingText, contactName = 'Postpartum Mother', contactId = null, isOutbound = false, provider = 'infobip' }) {
  if (!rawPhone && !contactId) return;

  console.log(`[WhatsApp Webhook - ${provider.toUpperCase()}] Processing:`, { phone: rawPhone, contactId, message: incomingText });

  // Match phone against mothers table (matching last 10 digits to handle international formats)
  const cleanDigits = String(rawPhone).replace(/[^0-9]/g, '').slice(-10);
  const { rows } = await pool.query(`
    SELECT m.*, h.name as hospital_name, h.phone as hospital_phone
    FROM mothers m
    LEFT JOIN hospitals h ON m.hospital_id = h.id
    WHERE REPLACE(REPLACE(REPLACE(m.phone_number, ' ', ''), '-', ''), '+', '') LIKE $1
  `, [`%${cleanDigits}%`]);

  let mother = null;

  if (rows.length === 0) {
    // Auto-enroll mother so anyone texting the hospital bot immediately receives maternal care
    console.log(`[Webhook] New mother contacted bot: ${rawPhone}. Auto-enrolling into triage database...`);
    const newMotherId = 'm_' + Date.now().toString(36);
    const motherName = contactName || 'Postpartum Mother';
    const formattedPhone = normalizePhoneNumber(rawPhone);

    const hospLookup = await pool.query("SELECT id, name, phone FROM hospitals ORDER BY CASE WHEN id = 'hosp_ondo_01' THEN 0 ELSE 1 END, created_at ASC LIMIT 1");
    const defaultHospitalId = hospLookup.rows[0]?.id || 'hosp_ondo_01';

    const insertRes = await pool.query(`
      INSERT INTO mothers (
        id, hospital_id, full_name, phone_number, delivery_date, delivery_type, parity,
        enrolled_date, current_risk_tier, sendpulse_contact_id, conversation_state, consecutive_negative_moods, last_checkin_date
      ) VALUES (
        $1, $2, $3, $4, CURRENT_DATE, 'Spontaneous Vaginal Delivery',
        'Primiparous (First-time mother)', CURRENT_DATE, 'normal', $5, 'AWAITING_MOOD', 0, CURRENT_TIMESTAMP
      ) RETURNING *
    `, [newMotherId, defaultHospitalId, motherName, formattedPhone, contactId]);

    mother = insertRes.rows[0];
    mother.hospital_name = hospLookup.rows[0]?.name || 'Mother & Child Hospital';
    mother.hospital_phone = hospLookup.rows[0]?.phone || null;

    // Log mother's inbound initiation message
    if (incomingText) {
      await logWhatsAppMessage({
        mother_id: mother.id,
        hospital_id: mother.hospital_id,
        direction: 'inbound',
        sender_type: 'mother',
        sender_name: mother.full_name,
        message: incomingText
      });
    }

    const welcomeMsg = buildInitialGreetingMessage(mother);
    await sendWhatsAppAndLog(mother, welcomeMsg, 'bot', 'MumaLINK Care Bot');
    return;
  } else {
    mother = rows[0];
  }

  // Save contactId on mother record if present
  if (contactId && mother.sendpulse_contact_id !== contactId) {
    await pool.query('UPDATE mothers SET sendpulse_contact_id = $1 WHERE id = $2', [contactId, mother.id]);
    mother.sendpulse_contact_id = contactId;
  }

  // Check if this webhook event represents an outbound message sent from Live Chat directly
  if (isOutbound) {
    if (incomingText) {
      await logWhatsAppMessage({
        mother_id: mother.id,
        hospital_id: mother.hospital_id,
        direction: 'outbound',
        sender_type: 'clinician',
        sender_name: 'Live Chat Agent',
        message: incomingText
      });
    }
    return;
  }

  // Record incoming message from mother in PostgreSQL live chat history
  if (incomingText) {
    await logWhatsAppMessage({
      mother_id: mother.id,
      hospital_id: mother.hospital_id,
      direction: 'inbound',
      sender_type: 'mother',
      sender_name: mother.full_name || 'Mother',
      message: incomingText
    });
  }

  let state = mother.conversation_state || 'IDLE';
  let stateData = mother.state_data || {};
  let negCount = parseInt(mother.consecutive_negative_moods, 10) || 0;
  const lowerText = incomingText.toLowerCase().trim();

  // Patient Opt-Out Command
  if (lowerText === 'stop' || lowerText === 'unsubscribe') {
    await pool.query("UPDATE mothers SET status = 'paused', conversation_state = 'IDLE' WHERE id = $1", [mother.id]);
    const stopMsg = `Mommy ${mother.full_name}, automated check-in messages have been paused as requested. You can reply *START* at any time to resume check-ins or contact ${mother.hospital_name || 'your hospital'}.`;
    await sendWhatsAppAndLog(mother, stopMsg, 'bot', 'MumaLINK Care Bot');
    return;
  }

  // Reset / Resume command
  if (lowerText === 'reset' || lowerText === 'start') {
    state = 'IDLE';
    negCount = 0;
    stateData = {};
    if (mother.status !== 'active') {
      await pool.query("UPDATE mothers SET status = 'active' WHERE id = $1", [mother.id]);
    }
  }

  // Immediate Clinical Emergency / Help Trigger
  if (['talk', 'help', 'emergency', 'doctor', 'nurse', 'urgent'].some(w => lowerText === w || lowerText.startsWith(w))) {
    await pool.query(`
      UPDATE mothers 
      SET current_risk_tier = 'critical', last_score = GREATEST(COALESCE(last_score, 0), 16),
          conversation_state = 'IDLE', last_checkin_date = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [mother.id]);

    const alertMsg = `Mommy ${mother.full_name}, we hear you.
Your message has been escalated to your hospital maternal care team as an urgent clinical priority. A doctor or midwife has been alerted on your portal.

If you are experiencing severe distress or a medical emergency, please call your maternity unit immediately:
Hospital Emergency Line: ${mother.hospital_phone || 'your maternity clinic'}

You are not alone, and your care team is standing by.`;

    await sendWhatsAppAndLog(mother, alertMsg, 'bot', 'MumaLINK Alert System');
    await sendCriticalRiskAlertEmail(mother, {
      reason: `Immediate Help Keyword Triggered ("${incomingText.slice(0, 80)}")`,
      score: Math.max(parseInt(mother.last_score, 10) || 0, 16)
    });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATE MACHINE (Founder Voice Note Specifications)
  // ─────────────────────────────────────────────────────────────────────────

  // STATE 1: IDLE — Initiates with congratulatory post-discharge check-in
  if (state === 'IDLE') {
    const greetingMsg = buildInitialGreetingMessage(mother);
    await sendWhatsAppAndLog(mother, greetingMsg, 'bot', 'MumaLINK Care Bot');

    await pool.query(
      "UPDATE mothers SET conversation_state = 'AWAITING_MOOD', last_checkin_date = CURRENT_TIMESTAMP WHERE id = $1",
      [mother.id]
    );
    return;
  }

  // STATE 2: AWAITING_MOOD — Supports single or multi-mood selection (Founder Voice Note 2)
  if (state === 'AWAITING_MOOD') {
    const moodParsed = parseMoodSelection(incomingText);

    if (moodParsed.selections.length === 0) {
      const clarifyMsg = `Thank you for messaging, Mommy ${mother.full_name}. Please reply with one or more mood numbers (1 to 5) so we can log how you feel:
1 - Happy / Peaceful
2 - Tired but coping
3 - Unhappy / Overwhelmed
4 - Anxious / Worried
5 - Sad / Low mood`;
      await sendWhatsAppAndLog(mother, clarifyMsg, 'bot', 'MumaLINK Care Bot');
      return;
    }

    const moodSummary = `Selected Moods: ${moodParsed.labels.join(', ')} | Raw Reply: ${incomingText}`;

    if (moodParsed.hasPositive && !moodParsed.hasNegative) {
      // Positive Response
      const reply = `We are glad to hear that, Mommy ${mother.full_name}.
Motherhood is a tender journey, and you are doing wonderfully. Please remember to rest whenever baby rests. Your care team at ${mother.hospital_name || 'your hospital'} is always by your side. We will check in on you again soon.`;

      await sendWhatsAppAndLog(mother, reply, 'bot', 'MumaLINK Care Bot');

      const checkinId = 'chk_' + Date.now().toString(36);
      await pool.query(`
        INSERT INTO checkins (id, mother_id, hospital_id, checkin_day_label, epds_score, risk_tier, mother_notes)
        VALUES ($1, $2, $3, 'WhatsApp Mood Check-in', 3, 'normal', $4)
      `, [checkinId, mother.id, mother.hospital_id, moodSummary]);

      await pool.query(`
        UPDATE mothers 
        SET conversation_state = 'IDLE', consecutive_negative_moods = 0, current_risk_tier = 'normal', last_score = 3, last_checkin_date = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [mother.id]);
      return;
    }

    // Negative Response (includes mixed positive+negative selections where distress is present)
    negCount += 1;
    const checkinId = 'chk_' + Date.now().toString(36);
    await pool.query(`
      INSERT INTO checkins (id, mother_id, hospital_id, checkin_day_label, epds_score, risk_tier, mother_notes)
      VALUES ($1, $2, $3, 'WhatsApp Mood Alert', 11, 'moderate', $4)
    `, [checkinId, mother.id, mother.hospital_id, moodSummary]);

    await pool.query(`
      UPDATE mothers 
      SET current_risk_tier = 'moderate', last_score = 11, consecutive_negative_moods = $1, last_checkin_date = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [negCount, mother.id]);

    // If persistent negative mood (>= 2 times as founder specified), invite the 10 EPDS questions with approved template
    if (negCount >= 2) {
      const hospitalLabel = mother.hospital_name || 'Mother & Child Hospital';
      const consentMsg = `Thank you for sharing honestly, Mommy ${mother.full_name}.
Because your mood has been low across recent check-ins, would you like to answer 10 quick questions to help us assess your wellbeing and ensure your care team at ${hospitalLabel} supports you properly?

Reply *YES* to begin or *NO* to pause.`;

      await sendWhatsAppAndLog(mother, consentMsg, 'bot', 'MumaLINK Care Bot', {
        templateName: 'mumalink_assessment_invite',
        placeholders: [mother.full_name, hospitalLabel]
      });

      await pool.query("UPDATE mothers SET conversation_state = 'AWAITING_EPDS_CONSENT' WHERE id = $1", [mother.id]);
      return;
    } else {
      // First negative check-in: warm empathy & reassurance
      const firstNegMsg = `Thank you for sharing honestly with us, Mommy ${mother.full_name}.
The early postpartum days bring tremendous emotional and physical adjustments. Please be gentle with yourself — your feelings are completely valid and you are never alone.

Our maternal care team has noted your response. We will follow up with you again soon. If you need someone to talk to right now, reply *TALK*.`;

      await sendWhatsAppAndLog(mother, firstNegMsg, 'bot', 'MumaLINK Care Bot');

      await pool.query("UPDATE mothers SET conversation_state = 'IDLE' WHERE id = $1", [mother.id]);
      return;
    }
  }

  // STATE 3: AWAITING_EPDS_CONSENT — Consent to 10 Questions
  if (state === 'AWAITING_EPDS_CONSENT') {
    const agrees = ['yes', 'sure', 'ok', 'okay', 'ready', 'yep', '1', 'start'].some(w => lowerText.includes(w));

    if (agrees) {
      stateData = { answers: {}, qIndex: 1 };
      const q1 = EPDS_QUESTIONS[0];
      const qMsg = `Starting EPDS Health Check-in (1 of 10):
*${q1.question}*

${q1.options.map(o => o.text).join('\n')}

Reply with 0, 1, 2, or 3.`;

      await sendWhatsAppAndLog(mother, qMsg, 'bot', 'MumaLINK EPDS Bot');

      await pool.query(
        "UPDATE mothers SET conversation_state = 'EPDS_Q1', state_data = $1 WHERE id = $2",
        [JSON.stringify(stateData), mother.id]
      );
      return;
    } else {
      const declineMsg = `We completely understand, Mommy ${mother.full_name}.
You can take the screening whenever you feel ready. Take care of yourself, and remember your care team at ${mother.hospital_name} is always here.`;

      await sendWhatsAppAndLog(mother, declineMsg, 'bot', 'MumaLINK Care Bot');

      await pool.query("UPDATE mothers SET conversation_state = 'IDLE' WHERE id = $1", [mother.id]);
      return;
    }
  }

  // STATES 4 TO 13: EPDS_Q1 THROUGH EPDS_Q10
  if (state.startsWith('EPDS_Q')) {
    const currentQNum = parseInt(state.replace('EPDS_Q', ''), 10);
    const currentQObj = EPDS_QUESTIONS.find(q => q.index === currentQNum);

    if (!currentQObj) {
      await pool.query("UPDATE mothers SET conversation_state = 'IDLE' WHERE id = $1", [mother.id]);
      return;
    }

    // Parse score from input (0, 1, 2, or 3)
    let score = null;
    const match = incomingText.match(/[0-3]/);
    if (match) {
      score = parseInt(match[0], 10);
    } else {
      score = 1; // fallback
    }

    stateData.answers = stateData.answers || {};
    stateData.answers[currentQObj.key] = score;

    // Special safety check for Question 10 (self-harm risk)
    if (currentQObj.key === 'q10_selfharm' && score > 0) {
      stateData.flagged_selfharm = true;
    }

    // If more questions remain:
    if (currentQNum < 10) {
      const nextQNum = currentQNum + 1;
      const nextQObj = EPDS_QUESTIONS.find(q => q.index === nextQNum);
      stateData.qIndex = nextQNum;

      const nextMsg = `Question ${nextQNum} of 10:
*${nextQObj.question}*

${nextQObj.options.map(o => o.text).join('\n')}

Reply with 0, 1, 2, or 3.`;

      await sendWhatsAppAndLog(mother, nextMsg, 'bot', 'MumaLINK EPDS Bot');

      await pool.query(
        "UPDATE mothers SET conversation_state = $1, state_data = $2 WHERE id = $3",
        ['EPDS_Q' + nextQNum, JSON.stringify(stateData), mother.id]
      );
      return;
    }

    // ALL 10 QUESTIONS COMPLETED: Calculate score & risk tier
    const a = stateData.answers;
    const totalScore = (a.q1_laugh || 0) + (a.q2_enjoyment || 0) + (a.q3_blame || 0) + 
                       (a.q4_anxious || 0) + (a.q5_scared || 0) + (a.q6_cope || 0) + 
                       (a.q7_sleep || 0) + (a.q8_sad || 0) + (a.q9_cry || 0) + (a.q10_selfharm || 0);

    let finalTier = 'normal';
    if (totalScore >= 13 || a.q10_selfharm > 0) {
      finalTier = 'critical';
    } else if (totalScore >= 10) {
      finalTier = 'moderate';
    }

    const checkinId = 'chk_' + Date.now().toString(36);
    await pool.query(`
      INSERT INTO checkins (
        id, mother_id, hospital_id, channel, checkin_day_label, epds_score, risk_tier,
        q1_laugh, q2_enjoyment, q3_blame, q4_anxious, q5_scared, q6_cope, q7_sleep, q8_sad, q9_cry, q10_selfharm,
        mother_notes
      ) VALUES ($1, $2, $3, 'whatsapp', 'EPDS 10-Question Screening', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `, [
      checkinId, mother.id, mother.hospital_id, totalScore, finalTier,
      a.q1_laugh || 0, a.q2_enjoyment || 0, a.q3_blame || 0, a.q4_anxious || 0, a.q5_scared || 0,
      a.q6_cope || 0, a.q7_sleep || 0, a.q8_sad || 0, a.q9_cry || 0, a.q10_selfharm || 0,
      `Completed all 10 EPDS questions. Final Score: ${totalScore}/30.`
    ]);

    await pool.query(`
      UPDATE mothers 
      SET current_risk_tier = $1, last_score = $2, conversation_state = 'IDLE', consecutive_negative_moods = 0, state_data = '{}'::jsonb, last_checkin_date = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [finalTier, totalScore, mother.id]);

    // Clinical Completion Message
    let completionMsg = '';
    if (finalTier === 'critical') {
      completionMsg = `Thank you for completing this, Mommy ${mother.full_name}.
Your responses indicate significant emotional distress. We have prioritized your record for your hospital care team at ${mother.hospital_name}. A maternal clinician will reach out to you shortly with support.

You are doing your absolute best for your baby, and support is right here.
Hospital Maternity Line: ${mother.hospital_phone || '+234 800 686 2546'}`;
    } else if (finalTier === 'moderate') {
      completionMsg = `Thank you, Mommy ${mother.full_name}.
Your screening indicates noticeable postpartum fatigue and adjustment stress. Your clinical team has received your assessment and will monitor your recovery. Remember to rest and hydrate whenever you can.`;
    } else {
      completionMsg = `Thank you, Mommy ${mother.full_name}.
Your screening indicates healthy emotional recovery and coping. We will continue checking in with you periodically. We celebrate you!`;
    }

    await sendWhatsAppAndLog(mother, completionMsg, 'bot', 'MumaLINK Care Bot');
    if (finalTier === 'critical') {
      await sendCriticalRiskAlertEmail(mother, {
        reason: a.q10_selfharm > 0
          ? 'EPDS Screening Completed (Question 10 Self-Harm Risk Flagged)'
          : 'EPDS Screening Completed (Score >= 13 Critical Threshold)',
        score: totalScore
      });
    }
    console.log(`[Screening Complete] ${mother.full_name} -> Score: ${totalScore}/30 Tier: ${finalTier.toUpperCase()}`);
    return;
  }
}

// Webhook HTTP Receiver
app.post(WEBHOOK_PATHS, async (req, res) => {
  // Always acknowledge immediately with HTTP 200
  res.status(200).json({ status: 'received' });

  try {
    const rawBody = req.body || {};

    // 1. INFOBIP MO_OTT_CONTACT Inbound format
    if (Array.isArray(rawBody.results) && rawBody.results.length > 0) {
      console.log(`[Infobip Webhook] Received ${rawBody.results.length} message(s)`);
      for (const item of rawBody.results) {
        const toPhone = String(item.to || '').replace(/[^0-9]/g, '');
        const expectedSender = String(process.env.INFOBIP_SENDER || '2348138048129').replace(/[^0-9]/g, '');
        if (toPhone && toPhone !== expectedSender) {
          console.log(`[Infobip Webhook] Ignoring message sent to non-MumaLINK number: ${toPhone}`);
          continue;
        }

        const fromPhone = item.from || item.contact?.phoneNumber || '';
        const text = item.message?.text || (typeof item.message === 'string' ? item.message : '') || item.cleanText || '';
        const name = item.contact?.name || 'Postpartum Mother';
        const contactId = item.from || item.contact?.phoneNumber || item.messageId || null;

        if (fromPhone) {
          await processIncomingMotherMessage({
            rawPhone: fromPhone,
            incomingText: String(text).trim(),
            contactName: name,
            contactId,
            isOutbound: false,
            provider: 'infobip'
          });
        }
      }
      return;
    }

    // 2. SENDPULSE Webhook format (Fallback & multi-provider)
    const body = Array.isArray(rawBody) ? (rawBody[0] || {}) : rawBody;
    const isOutbound = body.service === 'out' || body.title === 'outgoing_message' || body.direction === 'outbound';

    if (body.title && body.title !== 'incoming_message' && !isOutbound) {
      return;
    }

    const info = body.info || {};
    const contact = info.contact || body.contact || {};
    const contactId = contact.id || info.contact_id || body.contact_id || null;
    const rawPhone = contact.phone || info.phone || body.phone || '';
    const contactName = contact.name || 'Postpartum Mother';

    let incomingText = '';
    if (typeof info.message === 'string') incomingText = info.message;
    else if (info.message?.text?.body) incomingText = info.message.text.body;
    else if (info.message?.text) incomingText = typeof info.message.text === 'string' ? info.message.text : (info.message.text.body || '');
    else if (body.last_message_data?.message?.text) incomingText = body.last_message_data.message.text;
    else if (body.last_message_data?.message?.audio?.audio_transcription?.text) incomingText = body.last_message_data.message.audio.audio_transcription.text;
    else if (contact.last_message) incomingText = contact.last_message;
    else if (body.message) incomingText = typeof body.message === 'string' ? body.message : (body.message?.text || '');

    incomingText = (incomingText || '').trim();

    if (rawPhone || contactId) {
      await processIncomingMotherMessage({
        rawPhone,
        incomingText,
        contactName,
        contactId,
        isOutbound,
        provider: 'sendpulse'
      });
    }
  } catch (err) {
    console.error('[WhatsApp Webhook Handler Error]:', err);
  }
});

// =============================================================================
// INTERACTIVE SIMULATOR (FOR DASHBOARD DEMO & TESTING)
// =============================================================================
app.post('/api/simulate-checkin', authenticateToken, async (req, res) => {
  const { mother_id, scenario } = req.body;
  const isSuperAdmin = req.user.role === 'Super Admin';

  try {
    const querySql = isSuperAdmin
      ? 'SELECT m.*, h.name as hospital_name, h.phone as hospital_phone FROM mothers m LEFT JOIN hospitals h ON m.hospital_id = h.id WHERE m.id = $1'
      : 'SELECT m.*, h.name as hospital_name, h.phone as hospital_phone FROM mothers m LEFT JOIN hospitals h ON m.hospital_id = h.id WHERE m.id = $1 AND m.hospital_id = $2';
    const params = isSuperAdmin ? [mother_id] : [mother_id, req.user.hospital_id];
    const { rows } = await pool.query(querySql, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Mother not found or unauthorized.' });

    const mother = rows[0];
    let score = 4;
    let tier = 'normal';
    let notes = "Feeling rested, family is supportive, baby feeding well.";
    let qValues = [0, 0, 1, 1, 0, 1, 0, 1, 0, 0];

    if (scenario === 'critical') {
      score = 17;
      tier = 'critical';
      notes = "Mother reported feeling unable to cope, crying frequently without clear reason, panic episodes.";
      qValues = [2, 2, 2, 2, 2, 2, 2, 1, 2, 0];
    } else if (scenario === 'moderate') {
      score = 11;
      tier = 'moderate';
      notes = "Experiencing anxiety regarding infant latching, noticeable fatigue and self-blame.";
      qValues = [1, 1, 2, 1, 1, 1, 1, 1, 2, 0];
    }

    const checkinId = 'chk_' + Date.now().toString(36);
    const dayLabels = ['Day 3 Check-in', 'Week 1 Check-in', 'Week 2 Check-in', 'Month 1 Check-in'];
    const label = dayLabels[Math.floor(Math.random() * dayLabels.length)];

    await pool.query(`
      INSERT INTO checkins (
        id, mother_id, hospital_id, checkin_day_label, epds_score, risk_tier,
        q1_laugh, q2_enjoyment, q3_blame, q4_anxious, q5_scared, q6_cope, q7_sleep, q8_sad, q9_cry, q10_selfharm,
        mother_notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `, [
      checkinId, mother.id, mother.hospital_id, label, score, tier,
      ...qValues, notes
    ]);

    await pool.query(`
      UPDATE mothers
      SET current_risk_tier = $1, last_score = $2, last_checkin_date = CURRENT_TIMESTAMP
      WHERE id = $3
    `, [tier, score, mother.id]);

    // Record into live chat history so simulator check-ins show in conversation
    await logWhatsAppMessage({
      mother_id: mother.id,
      hospital_id: mother.hospital_id,
      direction: 'inbound',
      sender_type: 'mother',
      sender_name: mother.full_name,
      message: notes
    });

    await logWhatsAppMessage({
      mother_id: mother.id,
      hospital_id: mother.hospital_id,
      direction: 'outbound',
      sender_type: 'bot',
      sender_name: 'MumaLINK Bot',
      message: `Screening evaluation completed. EPDS Score: ${score}/30. Status: ${tier.toUpperCase()}.`
    });

    if (tier === 'critical') {
      await sendCriticalRiskAlertEmail(mother, {
        reason: 'Simulated Severe Postpartum Distress Check-in',
        score
      });
    }

    res.json({
      success: true,
      mother_id: mother.id,
      score,
      risk_tier: tier,
      checkin_label: label
    });

  } catch (err) {
    console.error('Simulator error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`MumaLINK Server active on http://localhost:${PORT}`);
  console.log(`Coming Soon Landing Page: http://localhost:${PORT}/`);
  console.log(`Clinician Auth: http://localhost:${PORT}/login`);
  console.log(`Clinician Triage Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`Infobip WhatsApp Webhook: http://localhost:${PORT}/api/webhook/sendpulse (also /api/webhook/infobip)`);
});
