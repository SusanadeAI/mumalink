# MumaLINK • Maternal Health Surveillance & Clinical Triage Platform

Continuous remote postpartum health tele-surveillance connecting newly delivered mothers to hospital clinical care teams.

---

## Clinical Overview

**MumaLINK** is a low-bandwidth maternal health platform designed for hospitals and healthcare authorities to deliver standardized 42-day postpartum surveillance, screening mothers for emotional distress and physical recovery complications after hospital discharge.

- **Low-Bandwidth WhatsApp Native**: Accessible to postpartum mothers without downloading mobile applications or requiring broadband connectivity.
- **EPDS Clinical Protocol**: Automated 10-question Edinburgh Postnatal Depression Scale risk scoring and triage stratification (Stable, Moderate, Critical).
- **Two-Way Clinical Inbox**: Enables hospital obstetricians and postnatal nurse leads to communicate directly with mothers and review automated check-in responses.
- **NDPR Healthcare Security**: Data encrypted in transit (TLS 1.3) and at rest (AES-256) in strict compliance with the Nigeria Data Protection Regulation (NDPR) and WHO digital health guidelines.

---

## Technical Stack

- **Runtime**: Node.js / Express
- **Database**: PostgreSQL (Multi-tenant hospital schema)
- **Messaging Gateway**: Official WhatsApp Business API
- **Authentication**: JWT, bcrypt, AES-256

---

## Local Development

```bash
# Install dependencies
npm install

# Start clinical triage server
npm start
```

---

© 2026 MumaLINK Maternal Health Network. All rights reserved.
