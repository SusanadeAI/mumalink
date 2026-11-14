require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool, initPostgresDatabase } = require('./postgres_db');
const sendpulse = require('./sendpulse');
const infobip = require('./infobip');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mumalink_secure_jwt_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Render PostgreSQL tables & seed data
initPostgresDatabase()
  .then(() => console.log('Render PostgreSQL ready.'))
  .catch(err => console.error('Failed to init PostgreSQL:', err));

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
// PAGE ROUTING
// =============================================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(['/login', '/signup', '/register', '/auth'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT c.*, h.name as hospital_name 
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

    const token = jwt.sign(
      {
        id: clinician.id,
        hospital_id: clinician.hospital_id,
        hospital_name: clinician.hospital_name,
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

app.post('/api/auth/register', async (req, res) => {
  const { full_name, email, password, role, hospital_id } = req.body;

  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required.' });
  }

  try {
    const existing = await pool.query('SELECT id FROM clinicians WHERE LOWER(email) = LOWER($1)', [email.trim()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const id = 'doc_' + Date.now().toString(36);
    const targetHospital = hospital_id || 'hosp_ondo_01';
    const password_hash = await bcrypt.hash(password, 10);

    await pool.query(`
      INSERT INTO clinicians (id, hospital_id, full_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, targetHospital, full_name.trim(), email.trim(), password_hash, role || 'Maternal Health Specialist']);

    const { rows: hospRows } = await pool.query('SELECT name FROM hospitals WHERE id = $1', [targetHospital]);
    const hospital_name = hospRows.length > 0 ? hospRows[0].name : 'Mother & Child Specialist Hospital';

    const token = jwt.sign(
      { id, hospital_id: targetHospital, hospital_name, full_name, email, role: role || 'Maternal Health Specialist' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      clinician: {
        id,
        hospital_id: targetHospital,
        hospital_name,
        full_name,
        email,
        role: role || 'Maternal Health Specialist'
      }
    });

  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.hospital_id, c.full_name, c.email, c.role, h.name as hospital_name
      FROM clinicians c
      JOIN hospitals h ON c.hospital_id = h.id
      WHERE c.id = $1
    `, [req.user.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Clinician not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public List of Partner Hospitals (For Clinician Registration dropdown)
app.get('/api/hospitals/public', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, state FROM hospitals ORDER BY name ASC');
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

// Register New Partner Hospital (Super Admin only)
app.post('/api/hospitals', authenticateToken, async (req, res) => {
  if (req.user.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Only Super Administrators can onboard new healthcare facilities.' });
  }

  const { name, state, contact_email, phone } = req.body;
  if (!name || !state) {
    return res.status(400).json({ error: 'Hospital name and state are required.' });
  }

  const id = 'hosp_' + Date.now().toString(36);
  try {
    const { rows } = await pool.query(`
      INSERT INTO hospitals (id, name, state, contact_email, phone)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [id, name.trim(), state.trim(), contact_email?.trim() || null, phone?.trim() || null]);
    res.json({ success: true, hospital: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List clinicians across network (Super Admin only)
app.get('/api/clinicians', authenticateToken, async (req, res) => {
  if (req.user.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Super Admin access required to view clinician directory.' });
  }

  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.full_name, c.email, c.role, c.hospital_id, h.name as hospital_name
      FROM clinicians c
      LEFT JOIN hospitals h ON c.hospital_id = h.id
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
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
    conditions.push(`hospital_id = $${params.length}`);
  }

  if (tier && tier !== 'all') {
    params.push(tier);
    conditions.push(`current_risk_tier = $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(full_name ILIKE $${params.length} OR phone_number ILIKE $${params.length})`);
  }

  let query = 'SELECT * FROM mothers';
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += `
    ORDER BY 
      CASE current_risk_tier
        WHEN 'critical' THEN 1
        WHEN 'moderate' THEN 2
        WHEN 'normal' THEN 3
        ELSE 4
      END,
      last_checkin_date DESC NULLS LAST
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
  const { full_name, phone_number, delivery_date, delivery_type, parity } = req.body;

  if (!full_name || !phone_number || !delivery_date) {
    return res.status(400).json({ error: 'Full name, WhatsApp phone number, and delivery date are required.' });
  }

  const id = 'mom_' + Date.now().toString(36);
  const enrolled_date = new Date().toISOString().split('T')[0];

  try {
    await pool.query(`
      INSERT INTO mothers (
        id, hospital_id, full_name, phone_number, delivery_date, delivery_type, parity,
        enrolled_date, current_risk_tier, last_score, status, conversation_state
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'normal', 0, 'active', 'AWAITING_MOOD')
    `, [
      id,
      hospital_id,
      full_name.trim(),
      phone_number.trim(),
      delivery_date,
      delivery_type || 'Spontaneous Vaginal Delivery',
      parity || 'Primiparous (First-time mother)',
      enrolled_date
    ]);

    // Send initial congratulatory WhatsApp message via SendPulse if contact/channel available
    const { rows: hospRows } = await pool.query('SELECT name FROM hospitals WHERE id = $1', [hospital_id]);
    const hospitalName = hospRows.length > 0 ? hospRows[0].name : 'Mother & Child Hospital';
    
    console.log(`[Enrollment] Mother ${full_name} enrolled. WhatsApp post-discharge greeting queued.`);

    res.json({ success: true, mother_id: id });

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

  if (!note || !note.trim()) {
    return res.status(400).json({ error: 'Clinical note cannot be empty.' });
  }

  const noteId = 'note_' + Date.now().toString(36);
  const clinician_name = req.user.full_name;

  try {
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

  try {
    const { rows } = await pool.query(`
      SELECT m.*, h.name as hospital_name 
      FROM mothers m
      JOIN hospitals h ON m.hospital_id = h.id
      WHERE m.id = $1
    `, [id]);

    if (rows.length === 0) return res.status(404).json({ error: 'Mother not found' });
    const mother = rows[0];

    const greetingMessage = `Congratulations Mommy ${mother.full_name}.
We rejoice with you on the safe delivery of your baby from ${mother.hospital_name}.

Your hospital care team is checking in on you. How are you feeling today?
1 - Happy / Peaceful
2 - Tired but coping
3 - Overwhelmed
4 - Anxious / Restless
5 - Sad / Low mood

Reply with 1-5 or describe how you feel.`;

    await sendWhatsAppAndLog(mother, greetingMessage, 'clinician', req.user.full_name, {
      templateName: 'mumalink_checkin_initial',
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

// Automated Postpartum Surveillance Scheduler (Day 3, Day 7, Day 14, Day 28)
async function runAutomatedPostpartumCheckins() {
  try {
    const query = `
      SELECT m.*, h.name as hospital_name,
             (CURRENT_DATE - m.delivery_date) as postpartum_days,
             (CURRENT_DATE - COALESCE(m.last_checkin_date::date, '2000-01-01'::date)) as days_since_last_checkin
      FROM mothers m
      JOIN hospitals h ON m.hospital_id = h.id
      WHERE m.status = 'active'
        AND (CURRENT_DATE - COALESCE(m.last_checkin_date::date, '2000-01-01'::date)) >= 3
    `;
    const { rows } = await pool.query(query);

    for (const mother of rows) {
      const days = parseInt(mother.postpartum_days, 10);
      let templateName = 'mumalink_checkin_followup';
      let messageText = '';

      if (days <= 5) {
        templateName = 'mumalink_checkin_initial';
        messageText = `Congratulations Mommy ${mother.full_name}.
We rejoice with you on the safe delivery of your baby from ${mother.hospital_name}.

Your hospital care team is checking in on you. How are you feeling today?
1 - Happy / Peaceful
2 - Tired but coping
3 - Overwhelmed
4 - Anxious / Restless
5 - Sad / Low mood

Reply with 1-5 or describe how you feel.`;
      } else {
        templateName = 'mumalink_checkin_followup';
        messageText = `Good day Mommy ${mother.full_name}.
This is your post-discharge wellness check-in from ${mother.hospital_name}.

How is your emotional wellbeing, healing, and rest today?
1 - Doing well / Peaceful
2 - Tired but managing
3 - Struggling / Overwhelmed
4 - Feeling down or worried

Reply with 1-4 to update your care team.`;
      }

      console.log(`[Automated Check-in] Triggering Day ${days} surveillance for ${mother.full_name} (${mother.phone_number})`);
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
    const formattedPhone = String(rawPhone).startsWith('+') ? String(rawPhone) : ('+' + String(rawPhone).replace(/^\+/, ''));

    const insertRes = await pool.query(`
      INSERT INTO mothers (
        id, hospital_id, full_name, phone_number, delivery_date, delivery_type, parity,
        enrolled_date, current_risk_tier, sendpulse_contact_id, conversation_state, consecutive_negative_moods, last_checkin_date
      ) VALUES (
        $1, 'hosp_ondo_01', $2, $3, CURRENT_DATE, 'Spontaneous Vaginal Delivery',
        'Primiparous (First-time mother)', CURRENT_DATE, 'normal', $4, 'AWAITING_MOOD', 0, CURRENT_TIMESTAMP
      ) RETURNING *
    `, [newMotherId, motherName, formattedPhone, contactId]);

    mother = insertRes.rows[0];
    mother.hospital_name = 'Ondo State Mother & Child Specialist Hospital';
    mother.hospital_phone = '+234 800 686 2546';

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

    const welcomeMsg = `Congratulations Mommy ${mother.full_name}.
We rejoice with you on the safe delivery of your baby from ${mother.hospital_name}.

Your hospital care team is active on this line to monitor your healing, emotional wellbeing, and baby's progress.

How are you feeling today?
1 - Happy / Peaceful
2 - Tired but coping
3 - Overwhelmed
4 - Anxious / Restless
5 - Sad / Low mood

Reply with a number (1-5) or type how you feel.`;

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
  const lowerText = incomingText.toLowerCase();

  // Reset command
  if (lowerText === 'reset' || lowerText === 'start') {
    state = 'IDLE';
    negCount = 0;
    stateData = {};
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
Hospital Emergency Line: ${mother.hospital_phone || '+234 800 686 2546'}

You are not alone, and your care team is standing by.`;

    await sendWhatsAppAndLog(mother, alertMsg, 'bot', 'MumaLINK Alert System');
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATE MACHINE (Founder Voice Note Specifications)
  // ─────────────────────────────────────────────────────────────────────────

  // STATE 1: IDLE — Initiates with congratulatory post-discharge check-in
  if (state === 'IDLE') {
    const greetingMsg = `Congratulations Mommy ${mother.full_name}.
We rejoice with you on the safe delivery of your baby from ${mother.hospital_name || 'Mother & Child Hospital'}.

As your hospital care team, your healing, rest, and peace of mind matter deeply to us.

How are you feeling today?
1 - Happy / Peaceful
2 - Tired but coping
3 - Overwhelmed
4 - Anxious / Restless
5 - Sad / Low mood

Reply with a number (1-5) or type how you feel.`;

    await sendWhatsAppAndLog(mother, greetingMsg, 'bot', 'MumaLINK Care Bot');

    await pool.query(
      "UPDATE mothers SET conversation_state = 'AWAITING_MOOD', last_checkin_date = CURRENT_TIMESTAMP WHERE id = $1",
      [mother.id]
    );
    return;
  }

  // STATE 2: AWAITING_MOOD — Classifies positive vs. negative mood
  if (state === 'AWAITING_MOOD') {
    const isPositive = ['1', '2', 'happy', 'fine', 'good', 'great', 'coping', 'peaceful', 'blessed', 'okay', 'well'].some(
      w => lowerText.includes(w)
    );
    const isNegative = ['3', '4', '5', 'sad', 'overwhelmed', 'anxious', 'unhappy', 'depressed', 'crying', 'cry', 'exhausted', 'scared', 'bad', 'tired'].some(
      w => lowerText.includes(w)
    );

    if (isPositive && !isNegative) {
      // Positive Response
      const reply = `We are glad to hear that, Mommy ${mother.full_name}.
Motherhood is a tender journey, and you are doing wonderfully. Please remember to rest whenever baby rests. Your care team at ${mother.hospital_name} is always by your side. We will check in on you again soon.`;

      await sendWhatsAppAndLog(mother, reply, 'bot', 'MumaLINK Care Bot');

      const checkinId = 'chk_' + Date.now().toString(36);
      await pool.query(`
        INSERT INTO checkins (id, mother_id, hospital_id, checkin_day_label, epds_score, risk_tier, mother_notes)
        VALUES ($1, $2, $3, 'WhatsApp Mood Check-in', 3, 'normal', $4)
      `, [checkinId, mother.id, mother.hospital_id, incomingText]);

      await pool.query(`
        UPDATE mothers 
        SET conversation_state = 'IDLE', consecutive_negative_moods = 0, current_risk_tier = 'normal', last_score = 3, last_checkin_date = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [mother.id]);
      return;
    }

    // Negative Response
    negCount += 1;
    const checkinId = 'chk_' + Date.now().toString(36);
    await pool.query(`
      INSERT INTO checkins (id, mother_id, hospital_id, checkin_day_label, epds_score, risk_tier, mother_notes)
      VALUES ($1, $2, $3, 'WhatsApp Mood Alert', 11, 'moderate', $4)
    `, [checkinId, mother.id, mother.hospital_id, incomingText]);

    await pool.query(`
      UPDATE mothers 
      SET current_risk_tier = 'moderate', last_score = 11, consecutive_negative_moods = $1, last_checkin_date = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [negCount, mother.id]);

    // If persistent negative mood (>= 2 times as founder specified), offer the 10 EPDS questions
    if (negCount >= 2) {
      const consentMsg = `Thank you for sharing honestly, Mommy ${mother.full_name}.
Because you've been feeling overwhelmed and low lately, would you like to answer 10 quick clinical questions to help us assess your emotional wellbeing and ensure your hospital care team supports you properly?

Reply *YES* to begin or *NO* to pause.`;

      await sendWhatsAppAndLog(mother, consentMsg, 'bot', 'MumaLINK Care Bot');

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

  try {
    const { rows } = await pool.query('SELECT * FROM mothers WHERE id = $1', [mother_id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Mother not found' });

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
