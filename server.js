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
  console.warn("\n⚠️ WARNING: DISCORD_BOT_TOKEN or DISCORD_GUILD_ID is not set in the environment.");
  console.warn("The server will run in PREVIEW MODE. Simulated orders will be logged to the console.\n");
}

// Global Headers for Discord API
const DISCORD_API = "https://discord.com/api/v10";
const botHeaders = {
  Authorization: `Bot ${BOT_TOKEN}`,
  "Content-Type": "application/json",
};

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── In-Memory Rate Limiting ────────────────────────────────────────────────────
// Simple in-memory tracker per IP / simple identifier to prevent spam
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000 * 5; // 5 minutes
const MAX_REQUESTS = 3;

function isRateLimited(req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown_ip";
  const now = Date.now();
  let tracker = rateLimitMap.get(ip);

  if (!tracker) {
    tracker = { count: 1, firstRequest: now };
    rateLimitMap.set(ip, tracker);
    return false;
  }

  // Reset the window if enough time has passed
  if (now - tracker.firstRequest > RATE_LIMIT_WINDOW_MS) {
    tracker.count = 1;
    tracker.firstRequest = now;
    return false;
  }

  tracker.count += 1;
  return tracker.count > MAX_REQUESTS;
}

// Optional Discord Role restriction logic (placeholder for user configurability)
// If you want only members with a specific role to be able to order, verify it here.
const ALLOWED_ROLE_ID = process.env.DISCORD_ALLOWED_ROLE_ID || null; // Optional

// ── Sanitize functions ───────────────────────────────────────────────────────
function safeText(str) {
  if (!str) return "";
  return String(str).replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim().slice(0, 100);
}

// ── Logging to file (simulating a basic DB/log for audit purposes) ─────────────
function appendToAuditLog(order) {
  const logLine = `[${new Date().toISOString()}] Username: ${order.username} | OptUsername: ${order.optUsername} | Item: ${order.item} | Price: $${order.price} | DiscordTicket: ${order.ticketChannel || "N/A"}\n`;
  try {
    fs.appendFileSync(path.join(__dirname, "orders.log"), logLine);
  } catch (err) {
    console.error("Failed writing to audit log:", err);
  }
}

// ── Discord helpers ────────────────────────────────────────────────────────────
async function findMember(rawUsername) {
  const clean = rawUsername.split("#")[0].trim().toLowerCase();
  console.log(`[DISCORD] Searching for member "${clean}" in Guild ${GUILD_ID}...`);

  // Strategy 1: If clean is a Discord User ID, look it up directly
  if (/^\d{17,20}$/.test(clean)) {
    console.log(`[DISCORD] Input looks like a Discord User ID. Fetching user directly: ${clean}`);
    try {
      const res = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members/${clean}`, { headers: botHeaders });
      if (res.ok) {
        const member = await res.json();
        console.log(`[DISCORD SUCCESS] Found member directly by User ID: "${member.user.username}"`);
        return member;
      }
    } catch (e) {
      console.error(`[DISCORD ERROR] Failed direct ID lookup:`, e.message);
    }
  }

  // Strategy 2: Call the search endpoint
  let searchMembers = [];
  try {
    const res = await fetch(
      `${DISCORD_API}/guilds/${GUILD_ID}/members/search?query=${encodeURIComponent(clean)}&limit=10`,
      { headers: botHeaders }
    );
    if (res.ok) {
      searchMembers = await res.json();
      console.log(`[DISCORD] /members/search returned ${searchMembers.length} result(s).`);
    } else {
      const errMsg = await res.text().catch(() => "Unknown error");
      console.error(`[DISCORD WARNING] Search endpoint returned status ${res.status}:`, errMsg);
    }
  } catch (e) {
    console.error(`[DISCORD ERROR] Failed to query search endpoint:`, e.message);
  }

  // Match search results
  let found = searchMembers.find((m) => {
    const uLow = m.user.username.toLowerCase();
    const tag = m.user.discriminator && m.user.discriminator !== "0"
      ? `${m.user.username}#${m.user.discriminator}`.toLowerCase() : null;
    const nickLow = m.nick ? m.nick.toLowerCase() : null;
    const dispLow = m.user.global_name ? m.user.global_name.toLowerCase() : null;
    
    return uLow === clean || 
           (tag && tag === rawUsername.trim().toLowerCase()) ||
           nickLow === clean ||
           dispLow === clean;
  });

  if (found) {
    console.log(`[DISCORD SUCCESS] Found matching user in search results: "${found.user.username}"`);
    return found;
  }

  // Strategy 3: Direct list-guild-members fallback (bypasses Discord index limitations)
  console.log(`[DISCORD] No direct match from search endpoint. Fetching direct member list fallback...`);
  try {
    const res = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members?limit=1000`, { headers: botHeaders });
    if (res.ok) {
      const allMembers = await res.json();
      console.log(`[DISCORD] Successfully listed ${allMembers.length} member(s) from guild.`);
      
      // Look for an exact match first
      found = allMembers.find((m) => {
        const uLow = m.user.username.toLowerCase();
        const nickLow = m.nick ? m.nick.toLowerCase() : null;
        const dispLow = m.user.global_name ? m.user.global_name.toLowerCase() : null;
        return uLow === clean || nickLow === clean || dispLow === clean;
      });

      // If no exact match, try looser substring matching (fuzzy username/nick containing the query)
      if (!found) {
        found = allMembers.find((m) => {
          const uLow = m.user.username.toLowerCase();
          const nickLow = m.nick ? m.nick.toLowerCase() : null;
          const dispLow = m.user.global_name ? m.user.global_name.toLowerCase() : null;
          return uLow.includes(clean) || 
                 (nickLow && nickLow.includes(clean)) || 
                 (dispLow && dispLow.includes(dispLow));
        });
      }
    } else {
      const errMsg = await res.text().catch(() => "Unknown error");
      console.error(`[DISCORD WARNING] Failed listing members. Status ${res.status}:`, errMsg);
    }
  } catch (e) {
    console.error(`[DISCORD ERROR] Failed listing members:`, e.message);
  }

  if (found) {
    console.log(`[DISCORD SUCCESS] Found matching user via fallback member list: "${found.user.username}" (ID: ${found.user.id})`);
  } else {
    // If still not found, try the first search result if any existed as a last-resort best-guess
    if (searchMembers.length > 0) {
      found = searchMembers[0];
      console.log(`[DISCORD WARNING] No resilient match succeeded. Defaulting to first search result: "${found.user.username}"`);
    } else {
      console.warn(`[DISCORD FAILED] Resilient lookup failed. "${rawUsername}" is truly not found or bot cannot see them.`);
    }
  }

  return found;
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

app.post("/api/checkout", async (req, res) => {
  if (isRateLimited(req)) {
    return res.status(429).json({ error: "Too many valid requests. Please wait a few minutes." });
  }

  const { item, username, optUsername, price } = req.body;
  if (!item || !username || !price) {
    return res.status(400).json({ error: "Missing required order information." });
  }

  const discordUsername = safeText(username);
  const optionalExtra = safeText(optUsername);

  // If we lack config, just fake a success sequence (perfect for preview mode).
  if (!hasDiscordConfig) {
    console.log(`[PREVIEW MODE] Order received: ${item} for ${discordUsername} ($${price})`);
    if (optionalExtra) console.log(`[PREVIEW MODE] Optional Extra Info: ${optionalExtra}`);
    
    // Simulate successful order logs
    appendToAuditLog({ username: discordUsername, optUsername: optionalExtra, item, price, ticketChannel: "#mock-ticket-channel" });
    
    return res.json({
      success: true,
      ticketUrl: "https://discord.com/app",
      message: "Simulated checkout successful. (No real webhook fired)."
    });
  }

  try {
    const member = await findMember(discordUsername);
    if (!member) return res.status(403).json({ error: "User not found in Discord server" });

    const userId = member.user.id;
    const safeUser = discordUsername.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18) || "user";
    // Construct ticket channel string: ticket-username-item
    const cleanItemName = item.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 15);
    const channelName = `ticket-${safeUser}-${cleanItemName}`;

    // 1. Create a channel for this order
    const createPayload = {
      name: channelName,
      type: 0, // Guild Text
      topic: `Order ticket for ${discordUsername}. User ID: ${userId}`,
      permission_overwrites: [
        {
          id: GUILD_ID,
          type: 0,
          deny: "1024", // View channel
        },
        {
          id: userId,
          type: 1, // User
          allow: "3072", // View channel + Send Messages
        },
      ],
    };

    if (CATEGORY_ID) {
      createPayload.parent_id = CATEGORY_ID;
    }

    const chanRes = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/channels`, {
      method: "POST",
      headers: botHeaders,
      body: JSON.stringify(createPayload),
    });

    if (!chanRes.ok) {
      const errTxt = await chanRes.text();
      console.error("[DISCORD] Failed to create channel:", errTxt);
      return res.status(500).json({ error: "Failed to create Discord ticket." });
    }

    const channel = await chanRes.json();
    const ticketUrl = `https://discord.com/channels/${GUILD_ID}/${channel.id}`;

    // Log internally
    appendToAuditLog({ username: discordUsername, optUsername: optionalExtra, item, price, ticketChannel: channelName });

    // 2. Post the introductory embed into the newly created channel
    const msgPayload = {
      content: `<@${userId}> Welcome to your secure purchasing ticket! 🎫`,
      embeds: [
        {
          title: "New Order Request",
          color: 0x5865f2,
          fields: [
            { name: "Product", value: item, inline: true },
            { name: "Price", value: `$${price}`, inline: true },
            { name: "Buyer Context / Additional Info", value: optionalExtra || "None provided", inline: false },
          ],
          description: "Our support and sales team has been notified. Please wait here, and a staff member will assist you shortly with the payment process.\n\n_Do not share passwords or sensitive credentials here._",
          timestamp: new Date().toISOString(),
          footer: { text: "Secure Order Fulfillment" }
        },
      ],
    };

    const msgRes = await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: botHeaders,
      body: JSON.stringify(msgPayload),
    });

    if (!msgRes.ok) {
      console.warn("[DISCORD] Failed to send initialization embed to ticket:", await msgRes.text());
      // We still return success because the channel was created successfully
    }

    res.json({ success: true, ticketUrl });
  } catch (err) {
    console.error("Checkout route error:", err);
    res.status(500).json({ error: "An internal server error occurred." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
