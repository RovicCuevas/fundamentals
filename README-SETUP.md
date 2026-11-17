# AI guardrail kit - setup (5 minutes)

1. Copy everything in this folder into the **root of your project** (next to `backend/` and `frontend/`):
   `.github/`, `scripts/`, `docs/`, `AGENTS.md`. Append `.gitignore.additions` to your `.gitignore`.
2. `git init` if you have not (this kit assumes git). **Do not commit `backend/.env`.**
3. In VS Code open Copilot Chat -> **Agent** mode. Type `/` and you should see the prompts (`00-start-session`, `fix-01...`).
   - If the prompts, skills or instructions do not show up: Command Palette -> "Chat: Configure Instructions / Prompt Files / Skills" and confirm the `.github/` folders are listed. Agent Skills may need a recent VS Code and the skills setting enabled; if skills do not load, the rules in `copilot-instructions.md` still apply and you can paste a SKILL.md into chat when needed.
4. Run `bash scripts/verify.sh` once on Windows via Git Bash or WSL (it is a bash script).
5. Start with `/00-start-session`, then follow `docs/FIX-PLAN.md`.

## Brevo email notifications

The backend keeps `console` notifications as the default. Configure one of these providers in your local, untracked `backend/.env` file:

```text
NOTIFICATION_PROVIDER=brevo-api
BREVO_API_KEY=your-brevo-api-key
BREVO_API_URL=https://api.brevo.com/v3/smtp/email
NOTIFICATION_FROM_EMAIL=verified-sender@example.com
NOTIFICATION_FROM_NAME=SmartCare Dental Clinic
```

For Brevo SMTP instead:

```text
NOTIFICATION_PROVIDER=brevo-smtp
BREVO_SMTP_HOST=smtp-relay.brevo.com
BREVO_SMTP_PORT=587
BREVO_SMTP_USER=your-brevo-smtp-login
BREVO_SMTP_PASSWORD=your-brevo-smtp-password
NOTIFICATION_FROM_EMAIL=verified-sender@example.com
NOTIFICATION_FROM_NAME=SmartCare Dental Clinic
```

Use only one provider at a time. Never commit `backend/.env`, API keys, SMTP passwords, or real credentials. The sender email must be verified in Brevo. Password-reset and verification messages use the same configured transport.

What each part does:
- `.github/copilot-instructions.md` + `AGENTS.md` - always-on rules.
- `.github/instructions/*.instructions.md` - extra rules when editing backend / frontend / tests.
- `.github/skills/*/SKILL.md` - checklists the agent loads when relevant (`verify`, `plan-first`, `fix-with-test`, `security-review`, `dual-db-check`, `payments-safety`).
- `.github/agents/reviewer.agent.md` - read-only skeptical reviewer.
- `.github/prompts/*.prompt.md` - one ready prompt per issue in the report.
- `.github/workflows/ci.yml` - GitHub Actions: tests, types, lint, build, secret check.
- `scripts/verify.sh` - the single "is it really OK" command.
