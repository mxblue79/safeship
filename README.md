# safeship

> Pre-deploy security CLI for vibe-coded services.
> Catches the most common AI-generated mistakes before they ship.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](https://nodejs.org)

The biggest risk of vibe coding (ChatGPT / Claude / Cursor / Copilot-driven development) is pushing *"code that works"* to production without security review. safeship is a **first-line defense** you run in your deploy pipeline to catch the classic mistakes that AI-generated code keeps reproducing.

---

## Why this exists

When working with AI code-gen tools, the same sharp edges show up over and over:

- Supabase deployed without Row Level Security → entire DB public
- `service_role` key leaked into a `NEXT_PUBLIC_*` env var
- Payment webhook accepts "success" response without signature verification
- Auth checks only in the frontend — the API is wide open
- `isAdmin = true` test backdoor left in production
- Tenant A can read Tenant B's data in a multi-tenant SaaS

safeship catches these patterns across three layers:

1. **Static analysis** — greps your source for known-bad patterns
2. **Runtime probing** — hits your Supabase with anon/authed keys to verify RLS
3. **HTTP header audit** — checks your deployed URL for CSP, HSTS, CORS misconfig

---

## Install

```bash
git clone https://github.com/<your-username>/safeship
cd safeship
npm install

# Optional: register as a global command
npm link
```

---

## Quick Start

### 1. Static analysis (no config needed)

```bash
# Scan current directory
node safeship.js static .

# Or another project
node safeship.js static /path/to/your-project
```

### 2. Supabase runtime check

```bash
cp safeship.config.example.yaml safeship.config.yaml
# Edit: fill in url, anonKey, tables
# WARNING: never commit safeship.config.yaml — it contains keys

node safeship.js supabase
```

### 3. HTTP header audit of a deployed URL

```bash
node safeship.js http https://your-domain.com
```

### 4. Run everything (config-driven)

```bash
node safeship.js all
```

### 5. JSON output for CI

```bash
node safeship.js static . --json > report.json
```

---

## What it checks

### 🔍 Static analysis (`static`)

**Secret exposure**
- Stripe `sk_live_*` / `sk_test_*`
- AWS `AKIA*` access keys
- Google API keys
- GitHub Personal Access Tokens
- OpenAI API keys
- Hardcoded `password`, `secret`, `api_key` variables

**Next.js pitfalls**
- `NEXT_PUBLIC_*` containing `SERVICE_ROLE` / `SECRET` / `PRIVATE_KEY`
- Supabase `service_role` key used in a client file

**Privilege bypass**
- Hardcoded `isAdmin = true`, `bypassAuth = true`
- Hardcoded `role: "admin"`
- Security-tagged TODO/FIXME comments
- `NODE_ENV !== "production"` conditional bypasses

**Auth / API**
- `dangerouslySetInnerHTML` usage
- `cors` with `origin: *`
- Client-supplied `user_id` / `tenant_id` / `role`
- `.insert({ tenant_id: req.body.tenant_id })` patterns
- API route files with no auth code (opt out with `// @public`)

**Webhooks / rate limits**
- Routes named `webhook` without signature verification code
- `/login`, `/signup`, `/payment` without rate limit middleware

**SQL / RLS**
- `CREATE TABLE` without `ENABLE ROW LEVEL SECURITY`
- `USING (true)` open-all policies
- INSERT/UPDATE policies missing `WITH CHECK`

**Environment**
- `.env` files not in `.gitignore`
- `.env` with real secrets that could still be committed

### 🔍 Supabase runtime checks (`supabase`)

**anon key probing**
- Attempt `SELECT` on each table with the anon key
- Attempt `INSERT` with the anon key

**Multi-tenant isolation**
With two test users configured, runs four scenarios:
- User A `SELECT`s User B's tenant_id data → critical if rows return
- User A `INSERT`s with User B's tenant_id → critical if accepted
- User A `UPDATE`s User B's data → critical if affected
- (DELETE inferred from UPDATE result; destructive tests are skipped)

### 🔍 HTTP header audit (`http`)

- HTTP → HTTPS redirect
- `Strict-Transport-Security` (HSTS, `max-age ≥ 1 year`)
- `X-Content-Type-Options`, `X-Frame-Options`
- `Content-Security-Policy`
- `Referrer-Policy`, `Permissions-Policy`
- Framework/server fingerprint (`Server`, `X-Powered-By`)
- `Access-Control-Allow-Origin: *` (+ `credentials` combo)

---

## CI/CD integration

GitHub Actions:

```yaml
# .github/workflows/security.yml
name: Security Check

on: [push, pull_request]

jobs:
  safeship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
        working-directory: ./safeship
      - name: Static analysis
        run: node safeship/safeship.js static .
      # Critical/High issues exit with code 1 → deploy blocked
```

Vercel / other platforms — add to `prebuild`:

```json
{
  "scripts": {
    "prebuild": "node safeship/safeship.js static ."
  }
}
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No issues, or Medium-and-below only → deploy OK |
| `1` | Critical/High issue found → deploy should be blocked |
| `2` | safeship itself errored (missing config, etc.) |

---

## Limits (important)

safeship is **an alert system, not a full audit.** It does not catch:

- Logical correctness of JWT verification
- Intent of complex RLS policies
- Cloudflare / Vercel dashboard settings
- Infrastructure security (firewalls, VPC, etc.)
- Business-logic vulnerabilities (IDOR, price tampering)
- Runtime-only permission errors

**Commercial services still need human code review and periodic third-party penetration testing.** safeship just raises the floor.

---

## Companion guides

This repo also ships prose guides you can share with teammates / peers:

- **[AI_CODING_SECURITY_GUIDE.md](./AI_CODING_SECURITY_GUIDE.md)** — 10-minute practical playbook for people building services with AI coding tools. Copy-paste prompts to brief your AI, per-feature one-liners, post-generation audit questions, pre-deploy manual checks, and 16 common "AI landmines" with before/after code. **Read this first if you're new to securing AI-generated code.** (Korean)
- **[guides/](./guides/)** — 8 topic-specific deep dives, one file per feature area. Only read the one you're currently implementing:
  - [01-payment-webhooks.md](./guides/01-payment-webhooks.md) — Stripe / Toss / LemonSqueezy / PayPal
  - [02-database.md](./guides/02-database.md) — Postgres / Supabase / MongoDB, RLS, IDOR
  - [03-auth-session.md](./guides/03-auth-session.md) — login, magic link, OAuth, sessions
  - [04-file-upload.md](./guides/04-file-upload.md) — image/doc upload, SVG/XSS, storage
  - [05-ai-llm-integration.md](./guides/05-ai-llm-integration.md) — OpenAI/Claude API, prompt injection, cost control
  - [06-cors-api.md](./guides/06-cors-api.md) — CORS, CSRF, rate limit, error handling
  - [07-email-sms.md](./guides/07-email-sms.md) — SendGrid/Twilio, SPF/DKIM, toll fraud
  - [08-deployment-infra.md](./guides/08-deployment-infra.md) — Vercel/Railway/AWS, env vars, backups
- **[vibe-coding-security-checklist-v2.md](./vibe-coding-security-checklist-v2.md)** — comprehensive deploy-readiness checklist for Next.js + Supabase + Go + payments. Dense, exhaustive reference. (Korean)

---

## Extending

Add a new check by dropping a module that returns issues in this shape:

```js
{
  severity: "critical" | "high" | "medium" | "low" | "info",
  title: "Human-readable title",
  location: "file path or target (optional)",
  detail: "details (optional)",
  hint: "fix hint (optional)"
}
```

Then register it under `all` in `safeship.js`.

---

## Contributing

PRs welcome. Especially useful:
- New static patterns that caught a real bug in your code
- Go / Rust / Python equivalents of the Next.js checks
- Better false-positive filtering

---

## License

MIT. See [LICENSE](./LICENSE).
