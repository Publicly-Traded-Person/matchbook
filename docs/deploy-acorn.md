# Deploying Matchbook on Acorn (launchd, no Docker)

Runbook for the first live install: the KmikeyM Discord, hosted on Acorn, the
always-on Mac mini that already runs the fleet's other daemons. Written
2026-09-22. It supersedes the Docker-based install guide from 2026-09-16 for
this host; Docker stays in the repo for anyone else self-hosting.

This is Task 15 of the build 1 plan (`docs/superpowers/plans/`, local only): the
manual install that the fleet run could not do.

## Why launchd and not Docker

Acorn has no Docker, and it should not get Docker for one bot. Every daemon on
it runs the same way, and Matchbook matches that pattern:

- a **launchd agent** in `~/Library/LaunchAgents/`, loaded in the `gui/501`
  domain (the one `com.kmikeym.discord-charlie` runs in);
- a **wrapper script** that sources a gitignored `.env`, because launchd has no
  `EnvironmentFile=`. The token never enters the plist, the repo or a chat;
- **Homebrew Bun** at `/opt/homebrew/bin/bun` (1.4.2 on 2026-09-22).

Reference implementation to read before writing anything:
`ssh acorn 'cat ~/discord-charlie/setup/charlie-run.sh'` and
`ssh acorn 'plutil -p ~/Library/LaunchAgents/com.kmikeym.discord-charlie.plist'`.

## Who does what

| Step | Who | Needs |
|---|---|---|
| 1. Add the launchd files to the repo | agent | nothing |
| 2. Clone, install, check config on Acorn (unloaded) | agent | `ssh acorn` |
| 3. Create the Discord application, collect 3 ids | **Mike** | Discord admin |
| 4. Write the token into `.env` on Acorn | **Mike** | a terminal |
| 5. Fill `config.toml`, print the invite, Mike clicks it | agent, then Mike | the ids from 3 |
| 6. Load the agent, verify | agent | the token in place |
| 7. First pairing | Mike plus one member | Discord |
| 8. Tell the host's operator, record the proof | agent | |

The agent never asks for, reads, echoes or logs the token. If a step would need
it, stop and hand that step to Mike.

## 1. Add the launchd files (agent, by PR)

Create two files under `deploy/launchd/`, open a PR, merge after tests pass.

`deploy/launchd/matchbook-run.sh`:

```sh
#!/bin/sh
# launchd entrypoint for Matchbook. launchd has no EnvironmentFile=, so this
# wrapper sources the gitignored .env itself and secrets never enter the plist.
set -eu

HOME_DIR="${MATCHBOOK_HOME:-$HOME/matchbook}"
BUN_BIN="${MATCHBOOK_BUN:-/opt/homebrew/bin/bun}"

if [ -f "$HOME_DIR/.env" ]; then
  set -a
  . "$HOME_DIR/.env"
  set +a
fi

# No token is a setup state, not a crash. Exit 0 so KeepAlive (SuccessfulExit
# false) does not restart-loop a bot that cannot log in.
if [ -z "${DISCORD_TOKEN:-}" ]; then
  echo "matchbook: DISCORD_TOKEN not set in $HOME_DIR/.env; not starting" >&2
  exit 0
fi

export MATCHBOOK_CONFIG="$HOME_DIR/config.toml"
export MATCHBOOK_DB="$HOME_DIR/data/matchbook.db"
cd "$HOME_DIR"
exec "$BUN_BIN" run src/main.ts
```

`deploy/launchd/com.kmikeym.matchbook.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.kmikeym.matchbook</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>/Users/acorn/matchbook/deploy/launchd/matchbook-run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/acorn/matchbook</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/acorn</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>/Users/acorn/matchbook/matchbook.out.log</string>
  <key>StandardErrorPath</key><string>/Users/acorn/matchbook/matchbook.err.log</string>
</dict>
</plist>
```

Add `*.log` to `.gitignore`. The plist hardcodes `/Users/acorn`; that is fine,
it is this host's file, and a self-hoster edits two paths.

Differences from Discord Charlie, on purpose: `KeepAlive` restarts only on a
non-zero exit, and the wrapper exits 0 when there is no token, so a missing
`.env` is a quiet stop rather than a restart loop every 30 seconds.

**Check:** `bunx tsc --noEmit && bun test` green; `plutil -lint` passes on the
plist; `sh -n` passes on the script; no em dashes in either file.

## 2. Clone, install, check config (agent, nothing loaded)

```sh
ssh acorn 'git clone https://github.com/Publicly-Traded-Person/matchbook ~/matchbook \
  && cd ~/matchbook && /opt/homebrew/bin/bun install \
  && cp config.example.toml config.toml && mkdir -p data \
  && /opt/homebrew/bin/bun run src/main.ts --check-config config.toml'
```

`bun.lock` is gitignored, so this is a fresh resolve. Expect `guilds: 1` with
zero ids and the seven permissions. Do not copy the plist into
`~/Library/LaunchAgents/` yet.

## 3. Create the Discord application (Mike, about 5 minutes)

1. discord.com/developers/applications → **New Application** → name it
   `Matchbook`.
2. **General Information**: copy the **Application ID**. Not secret. Give it to
   the agent.
3. **Bot** page: **Reset Token**, copy it. This is the one secret; Discord shows
   it once. Keep it for step 4 and paste it nowhere else.
4. Still on **Bot**: leave all three Privileged Gateway Intents **off**
   (Matchbook records that someone posted in a thread, never what). Turn **Public
   Bot** off.
5. In the Discord app, User Settings → Advanced → **Developer Mode** on, then
   copy three ids and give them to the agent:
   - **Guild id**: right-click the KmikeyM server icon → Copy Server ID.
   - **Thread parent channel id**: the text channel pairing threads hang under
     (threads are private, so `#chatter` works; a `#matchbook` channel is
     tidier). Right-click → Copy Channel ID.
   - **Voice category id**: create a category `Matchbook Rooms` (right-click the
     server name → Create Category), then right-click it → Copy Category ID.

## 4. Put the token on Acorn (Mike)

From the laptop, anywhere on the tailnet:

```sh
ssh acorn 'umask 077; cat > ~/matchbook/.env'
```

Type `DISCORD_TOKEN=`, paste the token, press Return, then Ctrl-D. The file is
mode 600 and gitignored. To confirm without printing it:
`ssh acorn 'grep -c ^DISCORD_TOKEN= ~/matchbook/.env'` should print `1`.

## 5. Fill the config and invite the bot (agent, then Mike)

Edit `~/matchbook/config.toml` on Acorn: replace the three zero strings in the
`[[guilds]]` block with the ids from step 3, keeping the quotes. Leave every
other setting at its default for the pilot (cadence 14 days, 30-minute calls,
round-robin only). Then:

```sh
ssh acorn 'cd ~/matchbook && DISCORD_CLIENT_ID=<application id> \
  /opt/homebrew/bin/bun run src/main.ts --check-config config.toml'
```

Expect `permissions=360778304528`, the seven permissions by name (View Channels,
Send Messages, Create Private Threads, Send Messages in Threads, Manage Threads,
Manage Channels, Connect), and an `invite:` URL. Give Mike the URL. He opens it
signed in as himself, picks the KmikeyM server, and checks the permissions
screen lists exactly those seven. **If it lists Move Members, Mute Members,
Manage Events or Manage Roles, stop.** Then Authorize. The bot appears offline.

## 6. Load and verify (agent)

```sh
ssh acorn 'chmod +x ~/matchbook/deploy/launchd/matchbook-run.sh \
  && cp ~/matchbook/deploy/launchd/com.kmikeym.matchbook.plist ~/Library/LaunchAgents/ \
  && launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.kmikeym.matchbook.plist'
ssh acorn 'launchctl print gui/501/com.kmikeym.matchbook | grep -E "state|pid"; tail -20 ~/matchbook/matchbook.out.log ~/matchbook/matchbook.err.log'
```

Pass when: `state = running`, the log shows the client logged in and guild
commands registered, and Mike sees nine entries under Matchbook when he types
`/`: join, timezone, availability, pause, resume, forget, and the three admin
subcommands matchbook config, matchbook status, matchbook pair. (Seven commands
are registered; Discord's picker lists each subcommand as its own row and hides
the bare parent, so seven registered shows as nine.)

**Restart survival without rebooting a shared box:**
`ssh acorn 'launchctl kickstart -k gui/501/com.kmikeym.matchbook'` and confirm it
comes back running with a new pid. A real reboot of Acorn is not the agent's
call; it takes down every daemon on it.

**Backups:** the database is `~/matchbook/data/matchbook.db`. Acorn runs a
nightly Time Machine job (`~/.local/bin/tm-nightly`); confirm it covers
`~/matchbook`, and say so in the hand-off either way.

## 7. The first pairing (Mike plus one member)

1. `/join`, timezone by autocomplete (`oak` finds America/Los_Angeles; `kos` or
   `beograd` finds Europe/Belgrade). The bot replies privately.
2. `/availability`: leave **Any reasonable hour** for the first call.
3. The second person runs `/join`. Within a minute or two (the job tick is 60
   seconds) a private thread appears under the parent channel with the
   introduction and a proposed slot 3 to 10 days out.
4. Both tap **Works for me**, or one counters once. When both confirm, the bot
   posts an `.ics`.
5. Ten minutes before the call a private voice room appears under Matchbook
   Rooms; it is deleted an hour after the end.
6. 24 hours after the end the thread asks **Did you two connect?**

## 8. Hand-off and proof

- Tell the host's operator a fourth daemon is on the box: label
  `com.kmikeym.matchbook`, logs `~/matchbook/*.log`, restart with
  `launchctl kickstart -k gui/501/com.kmikeym.matchbook`. (KmikeyM fleet: Warren,
  via the BBS.)
- Comment on the Matchbook card (operations#618) with what was verified and
  when, and what was not.

Task 15's proof is observations, each with a timestamp:

- the invite URL used was the one `--check-config` printed;
- nine entries listed under `/` (seven commands, `/matchbook` expanded to three);
- `kickstart -k` brought it back running;
- both `/join` times and the thread's creation time;
- the thread is under the configured channel and a third member cannot see it;
- the proposal's post time and slot; both confirmations and the `.ics` filename;
- the room-link post (9 to 11 minutes before start); the room gone (61+ minutes
  after the end);
- the follow-up post (24 to 25 hours after the end) and each answer.

## Updating a running install

```sh
ssh acorn 'cd ~/matchbook && git pull && /opt/homebrew/bin/bun install \
  && launchctl kickstart -k gui/501/com.kmikeym.matchbook'
```

A post that predates a button (the first locked post of 2026-09-23 went out
before Can't make it existed) is re-posted by hand through the bot's own port,
once, with the pairing id read from `~/matchbook/data/matchbook.db`. That is the
one time a locked post is repeated; the token stays in `.env` and the script is
not committed.

## If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `state = not running`, err log says DISCORD_TOKEN not set | `.env` missing or misspelled key | Mike redoes step 4, then `kickstart -k` |
| Exits with a field name in the error | `config.toml` typo | fix the field, `--check-config`, `kickstart -k` |
| `guilds: 0` | the `[[guilds]]` header was lost | restore it from `config.example.toml` |
| Commands never appear | bot not invited to this guild, or wrong guild id | re-run step 5 |
| `bootstrap` says already loaded | it is loaded | `launchctl bootout gui/501/com.kmikeym.matchbook`, then bootstrap again |
