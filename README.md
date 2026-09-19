# Slip Builder — mobile companion

## What's wired vs. what isn't

**Working end to end:**
- **New Slip tab.** Your form (leagues, legs, entry type, bankroll, notes,
  slip count) builds a message, sends it to the Slip Builder agent, polls
  from the browser until it's done, and pulls a structured slip out of
  its reply.
- **Leagues chips + lines.** Come from PrizePicks (the default source): the chips are the per-game boards it's posting, and Generate fetches those leagues' real lines and hands them to the agent. SportsGameOdds is supporting data only. PrizePicks has no official API — this uses the endpoint its own web app calls (`partner-api.prizepicks.com`), so it can break without warning. It fails loudly (clear error, no session started) instead of returning empty lines. `GET /api/prizepicks-lines?league=MLB` shows the full board including goblin/demon lines. Tests: `node --test test/prizepicks.test.js`.
- **Headshots.** After slips render, `POST /api/headshots` resolves each player to an ESPN athlete (search + strict name matching from `player-match.mjs`, copied from prizepicks-tracker) and fills in the photo. No confident match = silhouette, never a guess. Tests: `node --test test/headshots.test.mjs`.
- **History tab.** Every real Generate is saved as a record in the memory store and listed here (see "History and the saved-slip format" below).
- **Player stats dropdown.** Tap a player on a slip card: the row highlights and a panel opens with a large headshot, the bet's stat over the last 5 games (season avg, last-5 avg, how many cleared the line, a bar chart with each opponent's logo, the actual stat and the date, and the agent's hit chance and reasoning) and per-game season averages. `POST /api/player-stats` (ESPN game logs; a player it can't match confidently shows "no confident ESPN match", never someone else's numbers). The bet-stat comparison is mapped for common MLB/NFL/NBA/WNBA stats; anything else still gets the season-average grid. Tests: `node --test test/player-stats.test.mjs`.

The app has two tabs, Slip and History.

## Required environment variables

Set in Netlify → Site settings → Environment variables.

| Variable | Where to find it | Secret? |
|---|---|---|
| `ANTHROPIC_API_KEY` | Console → API keys — make a **new key** for this app, don't reuse an existing one | Yes |
| `SLIP_BUILDER_AGENT_ID` | Managed Agents → Agents → PrizePicks Slip Builder | No |
| `ENVIRONMENT_ID` | Managed Agents → Environments → your environment | No |
| `VAULT_ID` | Managed Agents → Credential vaults → Sports API | No |
| `MEMORY_STORE_ID` | Managed Agents → Memory stores → Slip Memory | No |
| `SPORTSGAMEODDS_API_KEY` | Your SportsGameOdds account key — **a separate copy** of the same key you put in the vault. This function runs outside the agent's sandbox, so it needs its own copy of the value. | Optional, your call |

## One thing to verify once you have real usage

The Sessions API is beta and I couldn't confirm the exact `POST /v1/sessions`
payload shape against a live call. If tapping "Generate Slips" gives a
500 with something like `Anthropic API 400`, open
`netlify/functions/start-session.js`, check the request body against the
current spec at platform.claude.com/docs/en/api/beta/sessions, and adjust.

## History and the saved-slip format

Every real Generate saves its slips to the shared memory store as one JSON file each (demo slips are never saved), so History accumulates across days and devices. Files follow the daily-folder rule in `Rules.md`:

    /slips/2026/09/19 MLB 3-LEG PENDING/<id>.json

Each file is a `slip-v1` record (see `netlify/functions/_slips.js`): `status` is `pending | won | lost`; each leg has `status` (`open | hit | miss | push | void`) and `result` (the player's actual stat). History shows only `slip-v1` `.json` files; agent notes (markdown) are ignored, and an unreadable `.json` is reported as a warning on the tab.

**To grade slips** (Results-Logger or by hand): for each `pending` file, set each leg's `status`/`result`, set the slip `status` to `won` or `lost` (and `payout` if it won), then rename the folder's `PENDING` to `WIN` or `LOSS`. History reads the fields, not the folder name. Tests: `node --test test/history.test.js`.
