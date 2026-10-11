require("dotenv").config();
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const Database = require("better-sqlite3");
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const required = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "OWNER_ID", "PUBLIC_BASE_URL", "SESSION_SECRET"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("Missing environment variable: " + key);
    process.exit(1);
  }
}
const ownerId = process.env.OWNER_ID;
const clientId = process.env.DISCORD_CLIENT_ID;
const baseUrl = process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
const redirectUri = baseUrl + (process.env.OAUTH_REDIRECT_PATH || "/oauth/callback");
const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "payout-central.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS oauth_users (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS grants (user_id TEXT NOT NULL, command TEXT NOT NULL, PRIMARY KEY(user_id,command)); CREATE TABLE IF NOT EXISTS blacklist (guild_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS queue (guild_id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, reward INTEGER NOT NULL, created_at INTEGER NOT NULL, priority INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS usage (user_id TEXT PRIMARY KEY, commands INTEGER NOT NULL DEFAULT 0, joins INTEGER NOT NULL DEFAULT 0, last_command INTEGER); CREATE TABLE IF NOT EXISTS logs (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, channel_id TEXT); CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS maintenance_allowed (user_id TEXT PRIMARY KEY);");
const defaults = { prefix: "!", stock: "0", max_auth_ever: "0", base_reward: process.env.BASE_REWARD || "2", max_queue: process.env.MAX_QUEUE || "10", verify_role: process.env.VERIFIED_ROLE_ID || "", payout_server_id: process.env.PAYOUT_CENTRAL_SERVER_ID || "", link_text: "", cooldown_seconds: "0", maintenance: "0", queue_paused: "0" };
for (const [key, value] of Object.entries(defaults)) db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").run(key, String(value));
for (const kind of ["farm", "server", "errors", "admin"]) db.prepare("INSERT OR IGNORE INTO logs(kind,enabled) VALUES(?,0)").run(kind);
const get = key => db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value ?? "";
const set = (key, value) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
const now = () => Date.now();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const app = express();
app.set("trust proxy", 1);
const oauthStates = new Map();
const confirmations = new Map();
function isOwner(id) { return id === ownerId; }
function granted(id, command) { return isOwner(id) || !!db.prepare("SELECT 1 FROM grants WHERE user_id=? AND command IN (?, 'all')").get(id, command); }
function admin(id) { return isOwner(id) || granted(id, "admin"); }
function amount(value) { const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : null; }
function cleanCommand(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9_-]/g, ""); }
function userMention(message) { return message.mentions.users.first(); }
function usage(id) { db.prepare("INSERT OR IGNORE INTO usage(user_id) VALUES(?)").run(id); return db.prepare("SELECT * FROM usage WHERE user_id=?").get(id); }
async function log(kind, text) {
  const row = db.prepare("SELECT * FROM logs WHERE kind=?").get(kind);
  if (!row?.enabled || !row.channel_id) return;
  try { const channel = await client.channels.fetch(row.channel_id); if (channel?.isTextBased()) await channel.send({ content: text.slice(0, 1900) }); }
  catch (error) { console.error("Log delivery failed:", error.message); }
}
async function confirm(message, title, description, action) {
  const id = crypto.randomUUID();
  confirmations.set(id, { user: message.author.id, action });
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("confirm:" + id).setLabel("Confirm").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("cancel:" + id).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  return message.reply({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(0xED4245)], components: [buttons] });
}
const helpEmbed = () => new EmbedBuilder()
  .setColor(0x5865F2)
  .setTitle("Payout Central | Command Guide")
  .setDescription("A quick reference to available commands. Replace `!` with your configured prefix if it has been changed.")
  .addFields(
    { name: "👤 Member Commands", value: [
      "`!help` — Display this command guide",
      "`!verify` — Link and verify your Discord account",
      "`!checkserver <serverID>` — View server information",
      "`!join <serverID>` — Submit a join request",
      "`!profile [@user]` — View a user profile"
    ].join("\n") },
    { name: "🛡️ Administration", value: [
      "`!stats` — View bot statistics",
      "`!auth` — View authorization totals",
      "`!stock` — View current stock",
      "`!restock <amount>` — Increase the stock counter",
      "`!remove <amount>` — Remove from the stock counter",
      "`!prefix set <prefix>` — Change the command prefix",
      "`!grant @user <command|all>` — Grant command access",
      "`!grant revoke @user <command|all>` — Revoke command access",
      "`!permission @user` — View a user’s permissions",
      "`!link` — Display or configure verification-link text",
      "`!blacklist` — Manage the server blacklist",
      "`!queue` — View and manage join requests",
      "`!maintenance` — Manage maintenance mode",
      "`!cooldown <seconds>` — Set the join-request cooldown",
      "`!server leave <serverID>` — Remove the bot from a server",
      "`!logs status` — View logging settings",
      "`!logfarm`, `!logserver`, `!logerrors`, `!logadmin` — Configure log channels",
      "`!announce <serverID|all> <message>` — Send an announcement",
      "`!update` — Manage update requests"
    ].join("\n") }
  )
  .setFooter({ text: "Payout Central • Command Center" });

app.get("/", (_req, res) => res.status(200).send("Payout Central bot is online."));
app.get("/health", (_req, res) => res.json({ status: "ok", botReady: client.isReady() }));
app.get("/oauth/start", (req, res) => {
  const requestedDiscordId = String(req.query.discord_id || "");
  if (!/^\d{17,20}$/.test(requestedDiscordId)) return res.status(400).send("Start verification with the bot's !verify command.");
  const state = crypto.randomBytes(32).toString("hex");
  oauthStates.set(state, { requestedDiscordId, expires: now() + 600000 });
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});
app.get("/oauth/callback", async (req, res) => {
  const state = String(req.query.state || "");
  const record = oauthStates.get(state);
  oauthStates.delete(state);
  if (!record || record.expires < now()) return res.status(400).send("Verification session expired. Run !verify again.");
  if (req.query.error) return res.status(400).send("Authorization was cancelled. You may close this page.");
  if (typeof req.query.code !== "string") return res.status(400).send("Missing authorization code.");
  try {
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: req.query.code, redirect_uri: redirectUri }) });
    if (!tokenResponse.ok) throw new Error("OAuth token exchange failed");
    const token = await tokenResponse.json();
    const userResponse = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token.access_token } });
    if (!userResponse.ok) throw new Error("Discord profile lookup failed");
    const user = await userResponse.json();
    if (user.id !== record.requestedDiscordId) return res.status(403).send("The authorized Discord account does not match the account that requested verification.");
    db.prepare("INSERT INTO oauth_users(user_id,created_at,last_seen) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen=excluded.last_seen").run(user.id, now(), now());
    set("max_auth_ever", Math.max(Number(get("max_auth_ever")), db.prepare("SELECT COUNT(*) n FROM oauth_users").get().n));
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Verified</title></head><body style="font:16px system-ui;max-width:640px;margin:12vh auto;padding:24px"><h1>Verification complete</h1><p>Your Discord account has been linked. No server join happened automatically. You can close this page.</p></body></html>`);
  } catch (error) { console.error("OAuth callback failed:", error.message); res.status(500).send("Verification failed. Please try again or contact an administrator."); }
});
app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => console.log("HTTP server listening on port " + (process.env.PORT || 3000)));

client.once("ready", () => console.log("Logged in as " + client.user.tag));
client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;
  const [verb, id] = interaction.customId.split(":");
  const item = confirmations.get(id);
  if (!item) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xFEE75C).setTitle("Confirmation Expired").setDescription("This confirmation is no longer available. Run the command again if needed.")], ephemeral: true });
  if (interaction.user.id !== item.user) return interaction.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle("Not Authorized").setDescription("Only the user who initiated this action can confirm it.")], ephemeral: true });
  confirmations.delete(id);
  if (verb === "cancel") return interaction.update({ content: null, embeds: [new EmbedBuilder().setColor(0x99AAB5).setTitle("Action Cancelled").setDescription("No changes were made.").setFooter({ text: "Payout Central • Command Center" })], components: [] });
  try { await item.action(); await interaction.update({ content: null, embeds: [new EmbedBuilder().setColor(0x57F287).setTitle("Action Completed").setDescription("The requested action was completed successfully.").setFooter({ text: "Payout Central • Command Center" })], components: [] }); }
  catch (error) { console.error(error); await interaction.update({ content: null, embeds: [new EmbedBuilder().setColor(0xED4245).setTitle("Action Failed").setDescription("The action could not be completed. Please check the bot logs or contact an administrator.").setFooter({ text: "Payout Central • Command Center" })], components: [] }); }
});
client.on("messageCreate", async message => {
  const nativeReply = message.reply.bind(message);
  message.reply = (payload, ...rest) => {
    if (typeof payload === "string") {
      const description = payload.length > 4000 ? payload.slice(0, 3990) + "…" : payload;
      return nativeReply({ embeds: [new EmbedBuilder().setColor(0x5865F2).setDescription(description).setFooter({ text: "Payout Central • Command Center" })] }, ...rest);
    }
    return nativeReply(payload, ...rest);
  };
  if (message.author.bot || !message.guild || !message.content.startsWith(get("prefix"))) return;
  const raw = message.content.slice(get("prefix").length).trim();
  if (!raw) return;
  const parts = raw.split(/\s+/), cmd = parts[0].toLowerCase(), args = parts.slice(1), full = raw;
  const adminCommands = new Set(["stats","stock","auth","restock","remove","prefix","grant","permission","link","blacklist","queue","maintenance","cooldown","server","logfarm","logserver","logerrors","logadmin","logs","announce","update"]);
  if (adminCommands.has(cmd) && !admin(message.author.id) && !granted(message.author.id, cmd)) return message.reply("You are not authorized to use this command.");
  const u = usage(message.author.id);
  db.prepare("UPDATE usage SET commands=commands+1,last_command=? WHERE user_id=?").run(now(), message.author.id);
  if (get("maintenance") === "1" && !isOwner(message.author.id) && !db.prepare("SELECT 1 FROM maintenance_allowed WHERE user_id=?").get(message.author.id)) return message.reply("The bot is currently under maintenance.");
  try {
    switch (cmd) {
      case "help": return message.reply({ embeds: [helpEmbed()] });
      case "verify": {
        if (message.guild.id === get("payout_server_id")) return message.reply("Verification links are not available in this server.");
        const url = baseUrl + "/oauth/start?discord_id=" + message.author.id;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel("Verify account").setStyle(ButtonStyle.Link).setURL(url));
        return message.reply({ embeds: [new EmbedBuilder().setTitle("Account verification").setDescription("Review the requested permission before authorizing. This links your Discord identity only; it does not add you to any server.").setColor(0x5865F2)], components: [row] });
      }
      case "link": {
        if (args[0]?.toLowerCase() === "define") { set("link_text", full.slice(full.toLowerCase().indexOf("define") + 6).trim()); return message.reply("Verification link message updated."); }
        return message.reply(get("link_text") ? get("link_text").replaceAll("{link}", baseUrl + "/oauth/start") : "Run !verify in a server where verification is enabled.");
      }
      case "auth": {
        const total = db.prepare("SELECT COUNT(*) n FROM oauth_users").get().n;
        const recent = db.prepare("SELECT COUNT(*) n FROM oauth_users WHERE created_at>=?").get(now() - 86400000).n;
        const max = Math.max(Number(get("max_auth_ever")), total); set("max_auth_ever", max);
        return message.reply("OAuth authorizations\nCurrent: " + total + "\nAdded in the last 24 hours: " + recent + "\nAll-time maximum: " + max);
      }
      case "stock": return message.reply("Current stock: " + get("stock"));
      case "restock": {
        const n = amount(args[0]);
        if (n === null || n < 1) return message.reply("Usage: !restock <positive amount>");
        const available = db.prepare("SELECT COUNT(*) n FROM oauth_users").get().n;
        if (n > available) return message.reply("Not enough authorized accounts. Available: " + available + ".");
        set("stock", Number(get("stock")) + n);
        await log("admin", message.author.tag + " restocked " + n);
        return message.reply("Restocked " + n + ". Current stock: " + get("stock") + ". This is a counter, not an automatic join action.");
      }
      case "remove": {
        const n = amount(args[0]);
        if (n === null || n < 1 || n > Number(get("stock"))) return message.reply("Enter a positive amount no greater than current stock.");
        return confirm(message, "Confirm stock removal", "Remove " + n + " from the stock counter?", async () => set("stock", Number(get("stock")) - n));
      }
      case "prefix":
        if (args[0]?.toLowerCase() === "set" && args[1] && args[1].length <= 5) { set("prefix", args[1]); return message.reply("Prefix updated to " + args[1] + "."); }
        return message.reply("Usage: !prefix set <prefix>");
      case "grant": {
        const target = userMention(message);
        if (args[0]?.toLowerCase() === "revoke") {
          const what = cleanCommand(args[2]);
          if (!target || !what) return message.reply("Usage: !grant revoke @user <command|all>");
          if (what === "all") db.prepare("DELETE FROM grants WHERE user_id=?").run(target.id);
          else db.prepare("DELETE FROM grants WHERE user_id=? AND command=?").run(target.id, what);
          return message.reply("Permissions revoked.");
        }
        const what = cleanCommand(args[1]);
        if (!target || !what) return message.reply("Usage: !grant @user <command|all>");
        db.prepare("INSERT OR IGNORE INTO grants(user_id,command) VALUES(?,?)").run(target.id, what);
        return message.reply("Granted " + what + " to " + target + ".");
      }
      case "permission": {
        const target = userMention(message);
        if (!target) return message.reply("Usage: !permission @user");
        const rows = db.prepare("SELECT command FROM grants WHERE user_id=?").all(target.id).map(x => x.command);
        return message.reply(target.tag + " permissions: " + (rows.join(", ") || "none"));
      }
      case "checkserver": {
        const id = args[0]; if (!id) return message.reply("Usage: !checkserver <serverID>");
        const guild = client.guilds.cache.get(id);
        if (!guild) return message.reply("I am not in that server, so I cannot inspect it.");
        const black = db.prepare("SELECT reason FROM blacklist WHERE guild_id=?").get(id);
        return message.reply(guild.name + " (" + id + ")\nMembers: " + guild.memberCount + "\nStock counter: " + get("stock") + "\nBlacklisted: " + (black ? "Yes — " + black.reason : "No"));
      }
      case "join": {
        const id = args[0]; if (!id) return message.reply("Usage: !join <serverID>");
        if (db.prepare("SELECT 1 FROM blacklist WHERE guild_id=?").get(id)) return message.reply("This server is blacklisted.");
        const guild = client.guilds.cache.get(id);
        if (!guild) return message.reply("The bot must already be in the destination server.");
        if (get("queue_paused") === "1") return message.reply("The queue is currently paused.");
        const verifyRole = get("verify_role");
        if (verifyRole && !message.member.roles.cache.has(verifyRole)) return message.reply("You need the verified role before requesting a join.");
        if (db.prepare("SELECT 1 FROM queue WHERE guild_id=?").get(id)) return message.reply("A request for this server is already queued.");
        if (db.prepare("SELECT COUNT(*) n FROM queue").get().n >= Number(get("max_queue"))) return message.reply("The queue is full. Please try again later.");
        const cooldown = Number(get("cooldown_seconds")) * 1000;
        if (cooldown && u.last_command && now() - u.last_command < cooldown) return message.reply("Please wait before trying again.");
        const reward = Number(get("base_reward"));
        db.prepare("INSERT INTO queue(guild_id,requester_id,reward,created_at) VALUES(?,?,?,?)").run(id, message.author.id, reward, now());
        await log("farm", message.author.tag + " requested a join for " + guild.name + " (" + id + ").");
        return message.reply("Request queued for " + guild.name + ". No account will be added automatically; member consent is required.");
      }
      case "stats": {
        const auth = db.prepare("SELECT COUNT(*) n FROM oauth_users").get().n, queued = db.prepare("SELECT COUNT(*) n FROM queue").get().n;
        return message.reply("Global statistics\nOAuth authorizations: " + auth + "\nStock: " + get("stock") + "\nQueue: " + queued + "/" + get("max_queue") + "\nBot servers: " + client.guilds.cache.size);
      }
      case "blacklist": {
        if (args[0]?.toLowerCase() === "list") {
          const rows = db.prepare("SELECT * FROM blacklist ORDER BY created_at DESC").all();
          return message.reply(rows.length ? rows.map(r => r.guild_id + ": " + r.reason).join("\n").slice(0,1900) : "No blacklisted servers.");
        }
        if (args[0]?.toLowerCase() === "revoke" && args[1]) { db.prepare("DELETE FROM blacklist WHERE guild_id=?").run(args[1]); return message.reply("Blacklist entry removed."); }
        const id = args[0], reason = args.slice(1).join(" ");
        if (!id || !reason) return message.reply("Usage: !blacklist <serverID> <reason>");
        db.prepare("INSERT INTO blacklist(guild_id,reason,created_at) VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at").run(id, reason, now());
        return message.reply("Server blacklisted.");
      }
      case "queue": {
        const sub = args[0]?.toLowerCase();
        if (sub === "pause" || sub === "resume") { set("queue_paused", sub === "pause" ? "1" : "0"); return message.reply("Queue " + (sub === "pause" ? "paused." : "resumed.")); }
        if (sub === "clear") return confirm(message, "Clear queue", "Remove all queued requests?", async () => db.prepare("DELETE FROM queue").run());
        if (sub === "remove" && args[1]) return confirm(message, "Remove request", "Remove request for " + args[1] + "?", async () => db.prepare("DELETE FROM queue WHERE guild_id=?").run(args[1]));
        if (sub === "priority" && args[1]) { db.prepare("UPDATE queue SET priority=priority+1 WHERE guild_id=?").run(args[1]); return message.reply("Queue priority updated."); }
        if (sub === "move" && args[1] && amount(args[2]) !== null) { db.prepare("UPDATE queue SET priority=? WHERE guild_id=?").run(100000 - amount(args[2]), args[1]); return message.reply("Queue order updated."); }
        if (sub === "info" && args[1]) { const r = db.prepare("SELECT * FROM queue WHERE guild_id=?").get(args[1]); return message.reply(r ? "Server " + r.guild_id + "; requester <@" + r.requester_id + ">; allocation " + r.reward : "No request found."); }
        const rows = db.prepare("SELECT * FROM queue ORDER BY priority DESC,created_at ASC").all();
        return message.reply(rows.length ? rows.map((r, i) => (i + 1) + ". " + r.guild_id + " — <@" + r.requester_id + "> — " + r.reward).join("\n").slice(0,1900) : "The queue is empty.");
      }
      case "maintenance": {
        const sub = args[0]?.toLowerCase(), target = userMention(message);
        if (sub === "enable" || sub === "disable") { set("maintenance", sub === "enable" ? "1" : "0"); return message.reply("Maintenance " + (sub === "enable" ? "enabled." : "disabled.")); }
        if ((sub === "allowed" || sub === "revoke") && target) {
          if (sub === "allowed") db.prepare("INSERT OR IGNORE INTO maintenance_allowed(user_id) VALUES(?)").run(target.id);
          else db.prepare("DELETE FROM maintenance_allowed WHERE user_id=?").run(target.id);
          return message.reply("Maintenance access updated.");
        }
        return message.reply("Usage: !maintenance enable|disable, !maintenance allowed @user, !maintenance revoke @user");
      }
      case "cooldown": {
        const n = amount(args[0]); if (n === null) return message.reply("Usage: !cooldown <seconds>");
        set("cooldown_seconds", n); return message.reply("Join cooldown set to " + n + " seconds.");
      }
      case "profile": {
        const target = userMention(message) || message.author, row = usage(target.id);
        const linked = !!db.prepare("SELECT 1 FROM oauth_users WHERE user_id=?").get(target.id);
        const queued = db.prepare("SELECT guild_id FROM queue WHERE requester_id=?").all(target.id).map(r => r.guild_id);
        return message.reply("Profile: " + target.tag + "\nOAuth linked: " + (linked ? "Yes" : "No") + "\nCommands used: " + row.commands + "\nJoin requests: " + row.joins + "\nQueued destinations: " + (queued.join(", ") || "None"));
      }
      case "server": {
        if (args[0]?.toLowerCase() !== "leave" || !args[1]) return message.reply("Usage: !server leave <serverID>");
        return confirm(message, "Confirm server leave", "Make the bot leave server " + args[1] + "?", async () => { const guild = await client.guilds.fetch(args[1]); await guild.leave(); });
      }
      case "announce": {
        const target = args[0], text = args.slice(1).join(" ");
        if (!target || !text) return message.reply("Usage: !announce <serverID|all> <message>");
        return confirm(message, "Confirm announcement", "Send this announcement to " + target + "?", async () => {
          const guilds = target === "all" ? [...client.guilds.cache.values()] : [client.guilds.cache.get(target)].filter(Boolean);
          let sent = 0;
          for (const guild of guilds) {
            const channel = guild.systemChannel || guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has("SendMessages"));
            if (channel) try { await channel.send(text.slice(0,1900)); sent++; } catch {}
          }
          await log("admin", "Announcement delivered to " + sent + " servers.");
        });
      }
      case "logs": {
        if (args[0] !== "status") return message.reply("Usage: !logs status");
        const rows = db.prepare("SELECT * FROM logs").all();
        return message.reply(rows.map(r => r.kind + ": " + (r.enabled ? "enabled" : "disabled") + "; " + (r.channel_id ? "<#" + r.channel_id + ">" : "channel not set")).join("\n"));
      }
      case "logfarm": case "logserver": case "logerrors": case "logadmin": {
        const kind = cmd.slice(3), sub = args[0]?.toLowerCase();
        if (sub === "enable" || sub === "disable") { db.prepare("UPDATE logs SET enabled=? WHERE kind=?").run(sub === "enable" ? 1 : 0, kind); return message.reply(kind + " logging " + sub + "d."); }
        if (sub === "set") { const channel = message.mentions.channels.first(); if (!channel) return message.reply("Mention a channel: !" + cmd + " set #channel"); db.prepare("UPDATE logs SET channel_id=? WHERE kind=?").run(channel.id, kind); return message.reply(kind + " log channel set."); }
        return message.reply("Usage: !" + cmd + " enable|disable|set #channel");
      }
      case "update": {
        const sub = args[0]?.toLowerCase();
        if (sub === "status") { const r = db.prepare("SELECT * FROM updates ORDER BY id DESC LIMIT 1").get(); return message.reply(r ? "#" + r.id + " " + r.status + ": " + r.prompt : "No pending updates."); }
        if (sub === "history") { const rows = db.prepare("SELECT * FROM updates ORDER BY id DESC LIMIT 10").all(); return message.reply(rows.length ? rows.map(r => "#" + r.id + " [" + r.status + "] " + r.prompt).join("\n").slice(0,1900) : "No update history."); }
        if (sub === "cancel") { db.prepare("UPDATE updates SET status='cancelled' WHERE status='pending'").run(); return message.reply("Pending update notes cancelled."); }
        if (sub === "undo") { db.prepare("UPDATE updates SET status='undone' WHERE id=(SELECT id FROM updates WHERE status='applied' ORDER BY id DESC LIMIT 1)").run(); return message.reply("Latest update note marked undone; source code was not changed."); }
        const prompt = full.slice(full.indexOf(" ") + 1).trim();
        if (!prompt) return message.reply("Usage: !update <prompt>");
        db.prepare("INSERT INTO updates(prompt,status,created_at) VALUES(?,'pending',?)").run(prompt, now());
        return message.reply("Update request saved for review. Remote source execution is disabled.");
      }
      default: return;
    }
  } catch (error) {
    console.error("Command failed:", error);
    await log("errors", "Command " + cmd + " failed: " + error.message);
    return message.reply("An internal error occurred. Administrators have been notified.").catch(() => {});
  }
});
client.login(process.env.DISCORD_TOKEN);
