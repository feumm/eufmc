require("dotenv").config();
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
  console.warn("WARNING: DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are not set.");
  console.warn("The shop's Discord integration will run in simulated preview mode.");
}

const DISCORD_API = "https://discord.com/api/v10";
const botHeaders = { Authorization: `Bot ${BOT_TOKEN || ""}`, "Content-Type": "application/json" };

const CAPES = [
  { id: 1, name: "Minecraft Experience", accent: "#4c1d95", price: 79 },
  { id: 2, name: "Moonlight Trial",      accent: "#3b82f6", price: 359 },
  { id: 3, name: "Crafter",              accent: "#d97706", price: 1500 },
  { id: 4, name: "Follower's",           accent: "#16a34a", price: 865 },
  { id: 5, name: "Purple Heart",         accent: "#a855f7", price: 20 },
  { id: 6, name: "Menace",              accent: "#ef4444", price: 10 },
];

const HTML_PATH = path.join(__dirname, "index.html");
let baseHtml = null;
function getHtml() {
  if (!baseHtml) baseHtml = fs.readFileSync(HTML_PATH, "utf8");
  return baseHtml;
}

function injectOg(html, base, title, desc, imgPath) {
  const absImg = imgPath.startsWith("http") ? imgPath : `${base}${imgPath}`;
  return html
    .replace(/(<meta property="og:title" content=")[^"]*(")/,   `$1${title}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/,`$1${desc}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/g,  `$1${absImg}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/,   `$1${title}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/,`$1${desc}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/g,  `$1${absImg}$2`)
    .replace(/(<meta name="description" content=")[^"]*(")/,     `$1${desc}$2`)
    .replace(/(<title>)[^<]*(<\/title>)/,                        `$1${title}$2`);
}

app.use(express.json());
app.use(express.static(__dirname, { index: false }));

// Serve HTML with server-injected absolute OG tags
app.get("/", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const base = `${proto}://${req.headers.host}`;
  const capeId = parseInt(req.query.cape, 10);
  const cape = capeId ? CAPES.find((c) => c.id === capeId) : null;

  let html = getHtml();
  if (cape) {
    html = injectOg(
      html, base,
      `${cape.name} Cape — $${cape.price} | €UFMC`,
      `Get the ${cape.name} Minecraft cape for $${cape.price}. Delivered within 24 hours via a private Discord ticket.`,
      `/cape-${cape.id}.png`
    );
  } else {
    html = injectOg(
      html, base,
      "€UFMC | Minecraft Capes",
      "Premium Minecraft capes at unbeatable prices. Delivered within 24 hours — simple, secure, and seamless.",
      "/logo.png"
    );
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

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
    return res.json({ found: true, userId: "1234567890", note: "Simulated in preview mode" });
  }

  try {
    const member = await findMember(username);
    if (!member) return res.status(404).json({ found: false });
    res.json({ found: true, userId: member.user.id });
  } catch (err) {
    console.error("validate-user:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/order", async (req, res) => {
  const { discordUsername, capeName, price, capeAccent } = req.body;
  if (!discordUsername || !capeName || price == null)
    return res.status(400).json({ error: "discordUsername, capeName, price are required" });

  if (!hasDiscordConfig) {
    // Direct simulated order in preview mode
    console.log(`[SIMULATED ORDER] User: ${discordUsername}, Cape: ${capeName}, Price: $${price}`);
    return res.json({ 
      guildId: "1234567890", 
      channelId: "1234567890",
      simulated: true,
      message: "Order simulation successful" 
    });
  }

  try {
    const member = await findMember(discordUsername);
    if (!member) return res.status(403).json({ error: "User not found in Discord server" });

    const userId = member.user.id;
    const safeUser = discordUsername.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18) || "user";
    const safeCape = capeName.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18);

    const channelBody = {
      name: `ticket-${safeCape}-${safeUser}`,
      type: 0,
      topic: `Order: ${capeName} | $${price} USD | ${discordUsername}`,
      permission_overwrites: [
        { id: GUILD_ID, type: 0, deny: "1024" },
        { id: userId, type: 1, allow: "52224" },
      ],
    };
    if (CATEGORY_ID) channelBody.parent_id = CATEGORY_ID;

    const chanRes = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/channels`, {
      method: "POST", headers: botHeaders, body: JSON.stringify(channelBody),
    });
    if (!chanRes.ok) {
      console.error("Channel error:", await chanRes.json().catch(() => ({})));
      return res.status(500).json({ error: "Failed to create ticket channel" });
    }
    const channel = await chanRes.json();

    const color = capeAccent ? parseInt(capeAccent.replace("#", ""), 16) : 0x5865f2;
    await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST", headers: botHeaders,
      body: JSON.stringify({
        content: `<@${userId}> Your purchase request has been received! Our team will be with you shortly.`,
        embeds: [{
          title: `🛒 Order: ${capeName}`, color,
          fields: [
            { name: "Cape",     value: capeName,        inline: true },
            { name: "Price",    value: `$${price} USD`, inline: true },
            { name: "Customer", value: `<@${userId}>`,  inline: true },
          ],
          footer: { text: "€UFMC Cape Shop • Not affiliated with Mojang AB or Microsoft" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });

    res.json({ guildId: GUILD_ID, channelId: channel.id });
  } catch (err) {
    console.error("order:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`€UFMC shop → http://0.0.0.0:${PORT}`));
