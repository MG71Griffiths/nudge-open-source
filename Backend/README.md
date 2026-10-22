# Independent Nudge backend setup

This independent source export contains no service credentials, authentication tenant, owner exemption, active cron or scheduled GitHub workflow. It is not connected to the original operator's service. Original code uses the MIT licence; bundled food data keeps the separate terms in THIRD_PARTY_NOTICES.md.

Use Node 24+ and the pnpm version pinned in `package.json`. Run `pnpm install --frozen-lockfile`. `pnpm test` uses synthetic fixtures/mocked providers; use the root offline runner for explicit outbound-network denial. `pnpm check` bundles a local Wrangler dry run; it does not publish.

For a separately operated service:

1. Set a unique Worker name and R2 bucket in `wrangler.toml`. The SQLite Durable Object bindings/migrations remain included. Create resources in your own Cloudflare account. Do not deploy against another operator's project.
2. Configure your own authentication provider with email-code signup/sign-in, email verification and working SMTP. Set email OTP length to six digits and verify both the provider setting and an actual email-code sign-in before inviting users. The ordinary app onboarding is passwordless; an existing-password route remains available separately for App Review access. No reviewer credentials or fixed code are included. Put its public project origin and publishable key into `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. Review provider settings and account-deletion access using disposable accounts.
3. Supply `OPENAI_API_KEY` and `SUPABASE_SECRET_KEY` through Wrangler's secret prompts in your own account. Never put them in source, the iPhone bundle, command arguments or chat. If intentionally enabling the private developer route, generate your own private-device token and supply only its SHA-256 as `PRIVATE_ACCESS_TOKEN_SHA256`. Managed users should use account sign-in instead.
4. Keep owner exemptions, automatic enrichment and cron disabled until quotas, retention, billing and recovery have been verified. Enabling AI routes can incur charges. Model capability/access must be checked for your account. The separate optional ChatGPT photo route runs directly on the iPhone; a ChatGPT plan does not cover this backend's API or transcription costs.
5. Replace the reserved origin in `src/reviewed-catalogue.js` and `src/product-images.js` with your own public service origin before publishing community source URLs or image metadata. Configure `NudgeBackendURL` in the native Info.plist to the same origin.
6. Use explicit deployment only after reviewing the configuration. This source does not deploy itself. Check account deletion, consent, failed uploads and retention before inviting users.

`.dev.vars.example` shows variable names with empty values for local setup. Copy it to ignored `.dev.vars` and fill it privately only when needed; it is not required for offline tests. A blank example value does not enable any service.

## Administrative tools

Before networked catalogue/enrichment/image/scoring commands, explicitly set `NUDGE_ADMIN_ORIGIN` to your own HTTPS origin with no trailing slash. No default production destination exists. Existing recipient-pinning checks remain: `--origin`/`--base-url` must match the configured destination where the tool enforces pinning. The contribution-review tool can instead take its own explicit `--base-url`.

Supply administrator tokens through the existing separate token file or environment mechanisms, never as command arguments. Do not run administrative tools against an unrelated service. The import/upload tools also require an explicit upload URL. The weekly production workflow has been omitted; add your own scheduler only after testing.

Generated `scripts/catalogue-refresh-cli.mjs` and the two Web photo adapters have reproducible build scripts and source manifests. Rebuild after dependency installation whenever shared source changes. Run the photo builders with `--check` to verify generated output and pinned source hashes.

## Data and review limitations

Personal captures are processed by the backend when configured. Review `src/private-capture-jobs.js`, contribution retention and current consent/privacy code before making public retention promises. No live providers, email delivery, account lifecycle, AI analysis or cloud deployment were tested by the exporter. Offline success does not verify those operations.
