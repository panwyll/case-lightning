# Cyber Essentials: what it takes for CONVEYi

Cyber Essentials (CE) is the UK government's baseline certificate, run by IASME for the NCSC. Law firms, their insurers and lender panels ask suppliers for it. It certifies **the organisation** (Case Lightning: its people, devices and cloud accounts), not the product. It is a yearly self-assessment questionnaire, marked by a certification body. **Cyber Essentials Plus** is the same five controls, checked by an assessor's hands-on audit. It has to be done within 3 months of passing CE.

Check the current requirements document (question set) and prices at iasme.co.uk before starting. The set is revised about once a year, and the notes below may be a version behind.

## Scope: everything that touches client data

CE covers every device and cloud service used to run the business. For us that is:

| Area | Items | Notes |
|---|---|---|
| Devices | Every laptop/desktop and phone used for work (including a personal phone that opens work email, Slack, GitHub or the admin app) | Personal phones used for work are in scope. |
| Code and hosting | GitHub, Vercel | Deploys go straight from main to prod. |
| Data | Supabase (Postgres, prod in eu-central-1, Frankfurt) | Client data lives here. |
| Identity and mail | Microsoft Entra / Azure app (Graph), Microsoft 365 or Google Workspace (our own mail), Resend | |
| AI | Anthropic, Groq, OpenAI / Voyage (embeddings) | Client text is sent here. Needs data processing agreements with the providers and zero data retention where offered. |
| Payments | Stripe | |
| Integrations | InfoTrack, LEAP, InTouch, WhatsApp (Meta), getAddress | Each console login is in scope. |
| Domain and DNS | Registrar and DNS provider for caselightning.co.uk | Often forgotten, and high impact: whoever controls DNS controls email. |

Out of scope: a firm's own devices and Microsoft 365. Those are their Cyber Essentials, not ours.

## The five controls, and what each means for us

### 1. Firewalls
- Every laptop has its operating system firewall on (macOS: System Settings → Network → Firewall).
- The home or office router has its default admin password changed, and no ports opened to the internet.
- Nothing we run listens on the open internet except through Vercel and Supabase.
- Check that the Supabase project does not allow direct database connections from anywhere. Use network restrictions if the plan allows them.

### 2. Secure configuration
- Remove software and accounts nobody uses, on devices and in every cloud console.
- Change every default password.
- Devices lock after a short idle time. Unlocking needs a PIN of at least 6 digits, or biometrics.
- No auto-run of downloaded files. macOS Gatekeeper stays on.
- Passwords: at least 12 characters, or at least 8 characters with multi-factor authentication (MFA). Use a password manager, with no reuse.

### 3. Security updates
- Automatic updates on for the operating system and browsers on every device.
- High and critical fixes installed within **14 days** of release, including phones.
- No unsupported software, for example an old macOS version that no longer gets security fixes.
- For our own code (good practice, not strictly CE): Dependabot or `npm audit` in continuous integration, and a monthly pass on dependencies.

### 4. User access control
- **MFA on every cloud service** in the scope table. This is the control most suppliers fail. It includes the domain registrar, Stripe, Supabase, Vercel, GitHub, the Anthropic console and every integration console.
- Separate everyday and admin use where the service allows it.
- Least privilege. For example, the read-only production database role (`claude_readonly`) is the right pattern for looking at prod data.
- Remove a leaver's access on the day they leave, and review who has access every quarter.
- Shared logins only where a service forces them, kept in the password manager.

### 5. Malware protection
- On macOS, the built-in XProtect and Gatekeeper protections, kept updated, are usually accepted. Confirm this against the current requirements.
- Alternatively, anti-malware software on every device.
- Phones: apps only from the official app stores.

## What firms will also ask, with CE or without

These are not in the certificate, but a firm's compliance officer will ask for them alongside it:

- **Data processing agreement:** the firm is the controller and we are their processor.
- **Sub-processor list:** the AI, integration and infrastructure services above, with where each processes data.
- **Data protection impact assessment (DPIA):** covers AI reading client documents, and ID and financial data.
- **International transfers:** the AI providers are in the US. We need the UK–US data bridge or the international data transfer agreement (IDTA) / addendum, and zero data retention where available.
- **Incident response:** who does what if data leaks, including telling the firm within their 72-hour reporting window.
- **Product security:**
  - Files go to clients as secure links, with a code and access logging (`lib/server/file-shares.ts`).
  - Bank details are never emailed.
  - Tenant isolation is enforced by row-level security in the database.
  - Tokens and codes are stored hashed.
  - Sign-in is through Microsoft (the firm's own MFA applies) or single-use email links.
- **Penetration test:** once a year, by an independent tester. It is usually asked for alongside CE Plus.

## Plan

| Step | What | Who | Effort |
|---|---|---|---|
| 1 | Fill in the scope table for real: every device, every account, who has access | Peter | 1–2 hours |
| 2 | Turn on MFA everywhere in scope, and move passwords into a password manager | Peter | Half a day |
| 3 | Check each device: firewall, automatic updates, screen lock, supported OS, no unused software | Peter | 1 hour per device |
| 4 | Remove unused accounts and API keys; rotate any key that has been pasted anywhere | Peter | 1–2 hours |
| 5 | Answer the CE questionnaire through IASME or a certification body (assessed within days) | Peter | 1 day |
| 6 | Data processing agreement template, sub-processor list, DPIA, privacy notice, incident plan | Draft with Claude, check with a lawyer | 2–3 days |
| 7 | CE Plus audit (within 3 months of CE) and a penetration test | External | When a firm or lender panel asks |
| 8 | ISO 27001 | External | Only when a larger firm or panel requires it |

**Cost (indicative; confirm with IASME):**
- CE for a micro organisation: a few hundred pounds a year.
- CE Plus: typically low thousands, depending on the number of devices.
- Penetration test: typically low-to-mid thousands.

**Renewal:** every 12 months. Diary it.
