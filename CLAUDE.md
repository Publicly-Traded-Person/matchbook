# CLAUDE.md

Guidance for an agent working in this repo.

## What this is

Matchbook: a Discord bot that introduces two members of a server every couple of
weeks and schedules the call. Bun + TypeScript, discord.js, SQLite. AGPL-3.0,
public. Built for the KmikeyM shareholder Discord; general-purpose by design.

- **Spec:** `docs/design.md`. The code implements it; when they disagree, say so.
- **Process:** `CONTRIBUTING.md`. A behavior-changing decision is filed as a
  `decision` issue first, then folded into the spec. Fold commits say "Folds
  in #N", never "Closes": decisions stay open while arguable.
- **Build 1** is on `main` (round-robin pairing, the full scheduling machine,
  follow-up). Scorers and the welcome pool are build 2 (#19).

## If you were started to deploy it

**Read `docs/deploy-acorn.md` and follow it in order.** It is the runbook for
the live install on Acorn (launchd, not Docker), with who-does-what per step.
Three of its steps need Mike's hands (the Discord application, the token, the
invite click). Stop at those and say exactly what you need. **Never ask for,
read, echo or log the bot token**; Mike writes it into `.env` on the host
himself.

## Checks

- `bunx tsc --noEmit && bun test` before every commit (316 tests on 2026-09-22).
- `discord.js` is imported only under `src/adapters/discord/` and `src/main.ts`.
- No em dashes in code, config, README or docs.
- `git branch --show-current` before the first commit; changes to `src/` go by PR.
