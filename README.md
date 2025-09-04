# Garage Raiders AI Backend

This is a simple Node.js backend deployed on Vercel.

## Features
- **/api/inbound** → Twilio webhook for inbound SMS. Saves messages + leads to Supabase.
- **/api/reply** → Endpoint to send outbound SMS via Twilio. Also logs messages in Supabase.

## Stack
- **Vercel** → serverless hosting
- **Supabase** → Postgres DB
- **Twilio** → SMS send/receive

## Environment Variables
Set these in Vercel Project Settings → Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

## Deployment
Push changes to `main` → Vercel auto-deploys.

