# case-lightning

## Deploying to Vercel

This repository uses **Next.js (App Router)** and is ready to deploy on Vercel.

### 1) Install dependencies

```bash
npm install
```

### 2) Run locally (optional)

```bash
npm run dev
```

### 3) Build locally (optional check)

```bash
npm run build
```

### 4) Deploy on Vercel

1. Import this repository in Vercel.
2. Keep the detected framework as **Next.js**.
3. Leave the default build command (`next build`) and output settings.
4. Deploy.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_STRIPE_PAYMENT_LINK` | **Yes** | Full Stripe Payment Link URL (e.g. `https://buy.stripe.com/xxxxx`). The `/start-trial` route redirects here, forwarding all UTM parameters so attribution is preserved in Stripe and GA4. |
| `NEXT_PUBLIC_GA_ID` | No | Google Analytics 4 measurement ID (e.g. `G-XXXXXXXXXX`). Enables CTA-click tracking and the `begin_trial` event fired just before the Stripe redirect. |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Supabase project URL. Used server-side to insert waitlist leads. |
| `SUPABASE_SECRET_KEY` | **Yes** | Supabase service-role secret key. **Never expose to the frontend.** |
| `RESEND_API_KEY` | No | [Resend](https://resend.com) API key. Used server-side only to send confirmation emails. **Never expose to the frontend.** If absent, confirmation emails are skipped but the lead is still saved. |
| `RESEND_FROM_EMAIL` | No | Verified sender address (e.g. `noreply@yourdomain.com`). Required alongside `RESEND_API_KEY` for confirmation emails to be sent. |

Set all variables in **Vercel → Project → Settings → Environment Variables**.
