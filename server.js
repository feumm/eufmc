try {
  require("dotenv").config();
} catch (e) {
  // Ignore if dotenv is not installed (e.g. on Railway/Replit where env vars are native)
}
const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Clean environment variables (e.g. remove leading/trailing quotes pasted by accident in Railway/Replit)
const cleanEnvVar = (val) => val ? val.replace(/^['"]|['"]$/g, "").trim() : undefined;

const BOT_TOKEN = cleanEnvVar(process.env.DISCORD_BOT_TOKEN);
const GUILD_ID = cleanEnvVar(process.env.DISCORD_GUILD_ID);
const CATEGORY_ID = cleanEnvVar(process.env.DISCORD_CATEGORY_ID);

const hasDiscordConfig = !!(BOT_TOKEN && GUILD_ID);
if (!hasDiscordConfig) {
  console.warn("⚠️ DISCORD_BOT_TOKEN or DISCORD_GUILD_ID not set! App will run in preview/mock mode.");
}

app.use(express.json());

// ── Static Files & SPA fallback ────────────────────────────────────────────────
// Try to serve Vite build output if it exists (for deployment)
const distPath = path.join(process.cwd(), "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("/", (req, res) => res.sendFile(path.join(distPath, "index.html")));
} else {
  // Otherwise serve current root (development fallback)
  app.use(express.static(process.cwd()));
  app.get("/", (req, res) => res.sendFile(path.join(process.cwd(), "index.html")));
}


// ── Helper: Discord API Request ────────────────────────────────────────────────
/**
 * Call Discord REST API
 */
async function discordRequest(endpoint, options = {}) {
  const url = `https://discord.com/api/v10${endpoint}`;
  
  const headers = {
    "Authorization": `Bot ${BOT_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  const res = await fetch(url, {
    ...options,
    headers
  });

  if (!res.ok) {
    const errorData = await res.text();
    console.error(`[Discord API Error] ${res.status} ${res.statusText} at ${endpoint}`);
    console.error(`Response auth prefix used: Bot ${BOT_TOKEN.substring(0,5)}...`);
    console.error(`Error details:`, errorData);
    throw new Error(`Discord API Error: ${res.status} ${res.statusText}`);
  }

  // Handle 204 No Content
  if (res.status === 204) return null;
  return await res.json();
}

// ── Helper: Search exact member by username ────────────────────────────────────
/**
 * Scans the guild for a member whose standard or global username exactly matches.
 * Note: For very large guilds, `limit: 1000` is the max per request. 
 * If your guild is >1000, you need an exact query or pagination. Let's use the query param.
 */
async function findMember(username) {
  if (!username) return null;
  const q = username.toLowerCase().trim();
  
  try {
    // Search members by query
    const results = await discordRequest(`/guilds/${GUILD_ID}/members/search?query=${encodeURIComponent(q)}&limit=100`);
    if (!results || !Array.isArray(results)) return null;

    // Filter to exact match
    const found = results.find(m => {
      // modern discord usernames are in user.username, sometimes user.global_name
      // legacy discord used user.username#discriminator (discriminator === "0" now usually)
      const u = m.user;
      if (!u) return false;
      
      const pUsername = (u.username || "").toLowerCase();
      const pGlobal = (u.global_name || "").toLowerCase();
      
      // Some users might type "username#0" or just "username"
      return pUsername === q || pGlobal === q || `${pUsername}#${u.discriminator}` === q;
    });

    return found;
  } catch (e) {
    console.error("Error finding member:", e);
    return null;
  }
}

// ── Helper: Auto-Find "Tickets" Category if config missing ────────────────────
async function ensureCategoryId() {
  if (CATEGORY_ID) return CATEGORY_ID;
  
  try {
    const channels = await discordRequest(`/guilds/${GUILD_ID}/channels`);
    // Find a category channel containing "ticket"
    const cat = channels.find(c => c.type === 4 && c.name.toLowerCase().includes("ticket"));
    if (cat) return cat.id;
  } catch(e) {
    console.error("Could not fetch categories:", e);
  }
  return null;
}

// ── API routes ─────────────────────────────────────────────────────────────────
app.get("/api/validate-user", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.status(400).json({ error: "username required" });
  
  if (!hasDiscordConfig) {
    // Direct simulated validation in preview mode
    return res.json({ valid: true, userId: "1234567890", note: "Simulated in preview mode" });
  }

  try {
    const member = await findMember(username);
    if (!member) return res.status(404).json({ valid: false });
    res.json({ valid: true, userId: member.user.id });
  } catch (err) {
    console.error("validate-user:", err);
    res.status(500).json({ valid: false, error: "Internal error" });
  }
});

app.post("/api/order", async (req, res) => {
  const { discordUsername, packageName, price, duration, paymentMethod } = req.body;

  if (!discordUsername || !packageName || !price) {
    return res.status(400).json({ error: "Missing required order fields" });
  }

  if (!hasDiscordConfig) {
    console.log("Mock Order Created:", req.body);
    return res.json({
      success: true,
      ticketUrl: "https://discord.com/channels/mock_server/mock_channel",
      note: "Simulated preview response"
    });
  }

  try {
    const member = await findMember(discordUsername);
    if (!member) return res.status(403).json({ error: "User not found in Discord server" });

    const userId = member.user.id;
    const safeUser = discordUsername.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18) || "user";
    const rand = Math.floor(1000 + Math.random() * 9000);
    const channelName = `ticket-${safeUser}-${rand}`;
    
    const parentId = await ensureCategoryId();

    // Channel Permission Overwrites
    // type: 0 = role, 1 = member
    // id: the user id or guild id (for @everyone)
    // 1024 = VIEW_CHANNEL, 2048 = SEND_MESSAGES
    const permissionOverwrites = [
      {
        id: GUILD_ID, // @everyone role is same ID as the guild
        type: 0,
        deny: "1024" // Deny VIEW_CHANNEL
      },
      {
        id: userId,
        type: 1,
        allow: "3072" // Allow VIEW_CHANNEL + SEND_MESSAGES
      }
    ];

    // Create the channel under the category
    const channelCreatePayload = {
      name: channelName,
      type: 0, // GUILD_TEXT
      parent_id: parentId, // works even if null
      permission_overwrites: permissionOverwrites
    };

    const newChannel = await discordRequest(`/guilds/${GUILD_ID}/channels`, {
      method: "POST",
      body: JSON.stringify(channelCreatePayload)
    });

    if (!newChannel || !newChannel.id) {
      throw new Error("Discord API did not return a channel ID. " + JSON.stringify(newChannel));
    }

    // Prepare embedded message content
    const embed = {
      title: `🛍️ New Order: ${packageName}`,
      description: `Please proceed with your payment.\n\n**Buyer:** <@${userId}>\n**Price:** $${price}\n**Package:** ${packageName}\n**Duration:** ${duration || 'Lifetime'}\n**Method:** ${paymentMethod || 'Paypal / Cashapp / Crypto'}`,
      color: 0x5865F2, // Discord Blurple
      footer: { text: "eufmc Shop Automated System" },
      timestamp: new Date().toISOString()
    };

    const msgPayload = {
      content: `<@${userId}> Welcome to your purchase ticket! Please wait for staff to assist you.`,
      embeds: [embed]
    };

    // Send initial message
    await discordRequest(`/channels/${newChannel.id}/messages`, {
      method: "POST",
      body: JSON.stringify(msgPayload)
    });

    const ticketUrl = `https://discord.com/channels/${GUILD_ID}/${newChannel.id}`;
    
    // Return the ticket URL to the frontend
    res.json({ success: true, ticketUrl });

  } catch (err) {
    console.error("Order processing error:", err);
    res.status(500).json({ error: "Failed to create order ticket", details: err.message });
  }
});


// Catch-all SPA route
app.get("*", (req, res) => {
  if (fs.existsSync(distPath)) {
    res.sendFile(path.join(distPath, "index.html"));
  } else {
    res.sendFile(path.join(process.cwd(), "index.html"));
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server initialized on port ${PORT}`);
  if (hasDiscordConfig) {
    console.log(`✅ Discord configured. Target server ID: ${GUILD_ID}`);
  } else {
    console.log(`⚠️ Running in local preview mode without Discord integrations.`);
  }
});
