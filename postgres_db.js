const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL;

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function initPostgresDatabase() {
  if (!pool) {
    console.log('No DATABASE_URL provided. Running in standalone static mode.');
    return;
  }
  const client = await pool.connect();
  try {
    console.log('Connecting to Render PostgreSQL database...');

    // 1. Hospitals (Tenants)
    await client.query(`
      CREATE TABLE IF NOT EXISTS hospitals (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        subdomain VARCHAR(100) UNIQUE,
        state VARCHAR(100) NOT NULL,
        contact_email VARCHAR(255),
        phone VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS subdomain VARCHAR(100) UNIQUE;
    `);

    // 2. Clinicians / Doctors (with authentication credentials)
    await client.query(`
      CREATE TABLE IF NOT EXISTS clinicians (
        id VARCHAR(64) PRIMARY KEY,
        hospital_id VARCHAR(64) NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(100) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Mothers (Patients)
    await client.query(`
      CREATE TABLE IF NOT EXISTS mothers (
        id VARCHAR(64) PRIMARY KEY,
        hospital_id VARCHAR(64) NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
        full_name VARCHAR(255) NOT NULL,
        baby_name VARCHAR(255),
        phone_number VARCHAR(50) NOT NULL UNIQUE,
        delivery_date DATE NOT NULL,
        delivery_type VARCHAR(100) DEFAULT 'Spontaneous Vaginal Delivery',
        parity VARCHAR(100) DEFAULT 'Primiparous (First-time mother)',
        enrolled_date DATE NOT NULL DEFAULT CURRENT_DATE,
        current_risk_tier VARCHAR(50) DEFAULT 'normal', -- normal, moderate, critical
        last_score INT DEFAULT 0,
        last_checkin_date TIMESTAMP WITH TIME ZONE,
        status VARCHAR(50) DEFAULT 'active',
        notes_count INT DEFAULT 0,
        sendpulse_contact_id VARCHAR(100),
        conversation_state VARCHAR(50) DEFAULT 'IDLE',
        consecutive_negative_moods INT DEFAULT 0,
        state_data JSONB DEFAULT '{}'::jsonb
      );
      ALTER TABLE mothers ADD COLUMN IF NOT EXISTS baby_name VARCHAR(255);
      ALTER TABLE mothers ADD COLUMN IF NOT EXISTS sendpulse_contact_id VARCHAR(100);
      ALTER TABLE mothers ADD COLUMN IF NOT EXISTS conversation_state VARCHAR(50) DEFAULT 'IDLE';
      ALTER TABLE mothers ADD COLUMN IF NOT EXISTS consecutive_negative_moods INT DEFAULT 0;
      ALTER TABLE mothers ADD COLUMN IF NOT EXISTS state_data JSONB DEFAULT '{}'::jsonb;
    `);

    // 4. Checkin Sessions (EPDS Screening Records)
    await client.query(`
      CREATE TABLE IF NOT EXISTS checkins (
        id VARCHAR(64) PRIMARY KEY,
        mother_id VARCHAR(64) NOT NULL REFERENCES mothers(id) ON DELETE CASCADE,
        hospital_id VARCHAR(64) NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
        channel VARCHAR(50) DEFAULT 'whatsapp',
        checkin_day_label VARCHAR(100) NOT NULL,
        epds_score INT NOT NULL,
        risk_tier VARCHAR(50) NOT NULL,
        q1_laugh INT DEFAULT 0,
        q2_enjoyment INT DEFAULT 0,
        q3_blame INT DEFAULT 0,
        q4_anxious INT DEFAULT 0,
        q5_scared INT DEFAULT 0,
        q6_cope INT DEFAULT 0,
        q7_sleep INT DEFAULT 0,
        q8_sad INT DEFAULT 0,
        q9_cry INT DEFAULT 0,
        q10_selfharm INT DEFAULT 0,
        mother_notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Clinical Intervention Notes
    await client.query(`
      CREATE TABLE IF NOT EXISTS clinical_notes (
        id VARCHAR(64) PRIMARY KEY,
        mother_id VARCHAR(64) NOT NULL REFERENCES mothers(id) ON DELETE CASCADE,
        clinician_name VARCHAR(255) NOT NULL,
        action_type VARCHAR(100) NOT NULL,
        note TEXT NOT NULL,
        resolved_alert BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 6. WhatsApp Live Chat Messages (Inbound & Outbound)
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id VARCHAR(64) PRIMARY KEY,
        mother_id VARCHAR(64) NOT NULL REFERENCES mothers(id) ON DELETE CASCADE,
        hospital_id VARCHAR(64) REFERENCES hospitals(id) ON DELETE CASCADE,
        direction VARCHAR(20) NOT NULL, -- 'inbound' or 'outbound'
        sender_type VARCHAR(50) NOT NULL, -- 'mother', 'bot', 'clinician'
        sender_name VARCHAR(255),
        message TEXT NOT NULL,
        sendpulse_message_id VARCHAR(100),
        status VARCHAR(50) DEFAULT 'delivered',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_mother ON whatsapp_messages(mother_id, created_at ASC);
    `);

    // 7. Coming Soon Waitlist & Pilot Access Requests
    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist (
        id VARCHAR(64) PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        hospital_name VARCHAR(255),
        role VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('PostgreSQL schema verified and ready.');

    // Backfill default subdomains for seeded hospitals without overwriting custom edits
    const defaultSubdomains = [
      ['hosp_ondo_01', 'akure'],
      ['hosp_ondo_02', 'ikare'],
      ['hosp_ondo_03', 'ondocity'],
      ['hosp_ondo_04', 'owo']
    ];
    for (const [hospId, slug] of defaultSubdomains) {
      await client.query(
        "UPDATE hospitals SET subdomain = $2 WHERE id = $1 AND (subdomain IS NULL OR subdomain = '')",
        [hospId, slug]
      );
    }

    // Ensure primary owner account has Super Admin privileges
    await client.query(
      "UPDATE clinicians SET role = 'Super Admin' WHERE LOWER(email) = 'susanadefinance@gmail.com'"
    );

    // Seed default records if empty
    const { rows } = await client.query('SELECT COUNT(*) as count FROM hospitals');
    if (parseInt(rows[0].count, 10) === 0) {
      await seedPostgresData(client);
    }

  } catch (err) {
    console.error('Error initializing PostgreSQL database:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function seedPostgresData(client) {
  console.log('Seeding initial clinical data to Render PostgreSQL...');

  // 1. Partner Hospitals across Ondo State Healthcare Network
  const hospitals = [
    ['hosp_ondo_01', 'Ondo State Mother & Child Specialist Hospital (Akure)', 'akure', 'Ondo State', 'akure-mch@mumalink.com', '+234 803 123 4567'],
    ['hosp_ondo_02', 'State Specialist Hospital (Ikare-Akoko)', 'ikare', 'Ondo State', 'ikare-ssh@mumalink.com', '+234 803 234 5678'],
    ['hosp_ondo_03', 'Mother & Child Hospital (Ondo City)', 'ondocity', 'Ondo State', 'ondocity-mch@mumalink.com', '+234 803 345 6789'],
    ['hosp_ondo_04', 'General Hospital (Owo)', 'owo', 'Ondo State', 'owo-gh@mumalink.com', '+234 803 456 7890']
  ];

  for (const [id, name, subdomain, state, email, phone] of hospitals) {
    await client.query(`
      INSERT INTO hospitals (id, name, subdomain, state, contact_email, phone)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET name = $2, subdomain = COALESCE(hospitals.subdomain, $3), state = $4, contact_email = $5, phone = $6;
    `, [id, name, subdomain, state, email, phone]);
  }

  // 2. Default Clinician: doctor@mumalink.com / Password123!
  const passwordHash = await bcrypt.hash('Password123!', 10);
  await client.query(`
    INSERT INTO clinicians (id, hospital_id, full_name, email, password_hash, role)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (email) DO NOTHING;
  `, [
    'doc_01',
    'hosp_ondo_01',
    'Dr. Akomolafe Motilayo',
    'doctor@mumalink.com',
    passwordHash,
    'Lead Maternal Health Specialist'
  ]);

  // 3. Super Admin: admin@mumalink.com / AdminPassword123!
  const adminPasswordHash = await bcrypt.hash('AdminPassword123!', 10);
  await client.query(`
    INSERT INTO clinicians (id, hospital_id, full_name, email, password_hash, role)
    VALUES ('admin_super', 'hosp_ondo_01', 'MumaLINK System Administrator', 'admin@mumalink.com', $1, 'Super Admin')
    ON CONFLICT (email) DO UPDATE SET password_hash = $1, role = 'Super Admin', full_name = 'MumaLINK System Administrator';
  `, [adminPasswordHash]);

  console.log('PostgreSQL default hospitals, clinician, and super admin verified.');
}

module.exports = {
  pool,
  initPostgresDatabase
};
