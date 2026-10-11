# Payout Central Discord Bot

Node.js 20+, Discord.js 14, Express, and SQLite. Bot-facing messages are in English.

## Included in this repository
- Configurable prefix, help, owner/admin grants, and runtime statistics
- OAuth2 identity verification using the `identify` scope
- Authorization and stock counters
- Join-request queue with pause/resume, priority, and removal controls
- Server blacklist, maintenance mode, cooldown settings, profile lookup, announcements, and log channels
- Railway-compatible HTTP server with `/health` endpoint and SQLite persistence

## Consent and safety
The OAuth flow links the Discord identity after explicit authorization. It does not automatically add users to servers or bulk-inflate member counts. Join requests are recorded in a queue; any membership action must respect the member's explicit consent and Discord's policies.

## Setup
1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable Message Content Intent in the Bot settings so prefix commands can read messages.
3. Invite the bot with only the permissions it needs.
4. Add the variables from `.env.example` to Railway Variables. Use newly generated credentials; do not commit `.env` or any real secrets.
5. Set `PUBLIC_BASE_URL` to the public HTTPS URL for the Railway service.
6. Add `${PUBLIC_BASE_URL}/oauth/callback` as an OAuth2 redirect URI in the Discord Developer Portal.
7. Deploy with Node.js 20+ and the start command `npm start`.
8. Attach a persistent volume mounted at `/app/data` to keep SQLite data across redeploys.

## Commands
Member: `!help`, `!verify`, `!checkserver <serverID>`, `!join <serverID>`, `!profile [@user]`.

Owner/admin: `!stats`, `!auth`, `!stock`, `!restock <amount>`, `!remove <amount>`, `!prefix set <prefix>`, `!grant @user <command|all>`, `!grant revoke @user <command|all>`, `!permission @user`, `!link`, `!link define <text>`, `!blacklist <serverID> <reason>`, `!blacklist list`, `!blacklist revoke <serverID>`, `!queue`, `!queue pause|resume|clear|remove|info|priority|move`, `!maintenance enable|disable`, `!maintenance allowed|revoke @user`, `!cooldown <seconds>`, `!server leave <serverID>`, `!logfarm`, `!logserver`, `!logerrors`, `!logadmin`, `!logs status`, `!announce <serverID|all> <message>`, and `!update <prompt>`.

`!update <prompt>` stores a note for review; it does not execute arbitrary code or change source files remotely. Destructive actions use confirmation buttons.

## Limitations
- `!checkserver` can inspect only servers the bot is in.
- The bot's highest role must be above any role it is asked to manage.
- This starter project is not a guarantee of Discord verification approval.
