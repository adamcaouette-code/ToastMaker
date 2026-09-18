# Slip Builder — mobile companion

## What's wired vs. what isn't

**Working end to end:**
- **New Slip tab.** Your form (leagues, legs, entry type, bankroll, notes,
  slip count) builds a message, sends it to the Slip Builder agent, polls
  from the browser until it's done, and pulls a structured slip out of
  its reply.
- **Leagues chips.** Pulled live from SportsGameOdds each time the page
  loads — whatever has games today shows up, nothing hardcoded.
- **Review tab.** Reads any memory file with "review" in its name and
  shows it as a note card.

**Working, but rough — needs a follow-up you already know about:**
- **History tab.** Your four agents don't yet write slip records in one
  consistent format, so this can only build a full card if a memory file
  happens to contain a matching JSON block. Anything else shows as a
  plain note instead of a proper win/loss card. Fixing this means
  standardizing what Slip Builder / Bet-Sizing / Results-Logger write —
  a task we've flagged before, not done yet.

**Not built — was out of scope on purpose:**
- **Stats tab** (player drilldown with hit-rate charts). Design's export
  included this with mock data; the function here just returns an empty
  list so it doesn't error. Building it for real means deciding which
  players it should show, which wasn't part of the original brief.

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
