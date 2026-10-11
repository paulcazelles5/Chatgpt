# Payout Central Discord Bot

Node.js 20+, Discord.js 14, Express, and SQLite. Bot-facing messages are in English.

## Included
- Configurable command prefix (`!` by default)
- OAuth2 account verification with an explicit consent step
- Authorization and stock counters
- Queue requests, queue controls, server blacklist, maintenance mode
- Permission grants, role reward settings, profiles, statistics, and configurable log channels
- Railway-compatible HTTP listener and SQLite storage

## Safety and consent
The bot does **not** silently add people to servers or bulk-inflate member counts. OAuth2 records a user's authorization; a join request is queued for review. Any server membership action must respect the user's explicit consent and Discord's policies.

## Setup
1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable Message Content Intent and Server Members Intent if the commands you use require them.
3. Add a bot invite with only the permissions the bot needs.
4. Set the environment variables from `.env.example` in Railway Variables. Do not commit `.env` or secrets.
5. Set `PUBLIC_BASE_URL` to the deployed service's public HTTPS URL.
6. Add `${PUBLIC_BASE_URL}/oauth/callback` as an OAuth2 redirect URI in the Discord Developer Portal.
7. Deploy the repository with Node.js 20+. The start command is `npm start`.
8. Attach a persistent Railway volume mounted at `/app/data` so SQLite data survives redeploys.

## Commands
Member: `!help`, `!verify`, `!checkserver <serverID>`, `!join <serverID>`.

Owner/admin: `!stats`, `!stock`, `!auth`, `!restock <amount>`, `!remove <amount>`, `!prefix set <prefix>`, `!grant @user <command|all>`, `!grant revoke @user <command|all>`, `!permission @user`, `!link`, `!link define <text>`, `!basesend set <amount>`, `!send @role <amount>`, `!verifyrole set @role`, `!blacklist <serverID> <reason>`, `!blacklist list`, `!blacklist revoke <serverID>`, `!queue`, `!queue clear`, `!queue remove <serverID>`, `!queue info <serverID>`, `!queue priority <serverID>`, `!queue move <serverID> <position>`, `!queue pause`, `!queue resume`, `!logfarm enable|disable|set #channel`, `!logserver enable|disable|set #channel`, `!logerrors enable|disable|set #channel`, `!logadmin enable|disable|set #channel`, `!logs status`, `!maintenance enable|disable`, `!maintenance allowed @user`, `!maintenance revoke @user`, `!server leave <serverID>`, `!cooldown <seconds>`, `!profile @user`, `!announce <serverID|all> <message>`, and `!update status|history|cancel|undo|<prompt>`.

`!update <prompt>` saves a note for review; it does not execute arbitrary code or modify source files remotely. Destructive actions use confirmation buttons.

## Limitations
- `!checkserver` can inspect only servers the bot is in.
- The bot's highest role must be above a role it is asked to manage.
- This starter project is not a guarantee of Discord verification approval.
