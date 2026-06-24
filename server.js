const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CATEGORY_ID = process.env.DISCORD_CATEGORY_ID;

if (!BOT_TOKEN || !GUILD_ID) {
  console.error("ERROR: DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set in .env");
  process.exit(1);
}

const DISCORD_API = "https://discord.com/api/v10";
const botHeaders = { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" };

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
    .replace(/(<meta property="og:title" content=")[^"]*(")/,    `$1${title}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/,`$1${desc}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/g,   `$1${absImg}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/,    `$1${title}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/,`$1${desc}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/g,  `$1${absImg}$2`)
    .replace(/(<meta name="description" content=")[^"]*(")/,      `$1${desc}$2`)
    .replace(/(<title>)[^<]*(<\/title>)/,                         `$1${title}$2`);
}

app.use(express.json({ limit: "50kb" }));
app.use(express.static(__dirname, { index: false }));

app.get("/", (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const base = `${proto}://${req.headers.host}`;
  const capeId = parseInt(req.query.cape, 10);
  const cape = capeId ? CAPES.find((c) => c.id === capeId) : null;

  let html = getHtml();
  if (cape) {
    html = injectOg(html, base,
      `${cape.name} Cape — $${cape.price} | €UFMC`,
      `Get the ${cape.name} Minecraft cape for $${cape.price}. Delivered within 24 hours via a private Discord ticket.`,
      `/cape-${cape.id}.png`
    );
  } else {
    html = injectOg(html, base,
      "eufmc | Minecraft Capes",
      "Premium Minecraft capes at unbeatable prices, delivered within 24 hours — simple, secure and seamless.",
      "/opengraph.png"
    );
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

async function findMember(rawUsername) {
  const clean = rawUsername.split("#")[0].trim().toLowerCase();
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/search?query=${encodeURIComponent(clean)}&limit=10`,
    { headers: botHeaders }
  );
  if (!res.ok) return null;
  const members = await res.json();
  return (
    members.find((m) => {
      const uLow = m.user.username.toLowerCase();
      const tag = m.user.discriminator && m.user.discriminator !== "0"
        ? `${m.user.username}#${m.user.discriminator}`.toLowerCase() : null;
      return uLow === clean || (tag && tag === rawUsername.trim().toLowerCase());
    }) ?? (members.length > 0 ? members[0] : null)
  );
}

app.get("/api/validate-user", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.status(400).json({ error: "username required" });
  try {
    const member = await findMember(username);
    if (!member) return res.status(404).json({ valid: false });
    res.json({ valid: true, userId: member.user.id });
  } catch (err) {
    console.error("validate-user:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/order", async (req, res) => {
  const { discordUsername, capeId, capeName, price, capeAccent } = req.body;
  if (!discordUsername || !capeName || price == null)
    return res.status(400).json({ error: "discordUsername, capeName, price are required" });

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

    // Build public base URL to link the cape image
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const base = `${proto}://${req.headers.host}`;
    const resolvedId = capeId || (CAPES.find(c => c.name === capeName) || {}).id;
    const capeImageUrl = resolvedId ? `${base}/cape-${resolvedId}.png` : null;

    const color = capeAccent ? parseInt(capeAccent.replace("#", ""), 16) : 0x5865f2;

    const LTC_ADDRESS = "ltc1qw7t79qc646uxzxq8xnrw46g4mj7d2hfu87cxxj";

    const embed = {
      author: {
        name: "€UFMC — Minecraft Cape Shop",
        icon_url: `${base}/logo.png`,
      },
      title: `🧥 New Order — ${capeName}`,
      description: `<@${userId}> opened a purchase request. Follow the steps below to complete your order.`,
      color,
      fields: [
        { name: "Cape",  value: capeName,                              inline: true },
        { name: "Price", value: `$${Number(price).toLocaleString()}`, inline: true },
        { name: "Buyer", value: `<@${userId}>`,                       inline: true },
        { name: "Pay with Litecoin", value: `\`${LTC_ADDRESS}\``,    inline: false },
        { name: "🎭  Cape",   value: `**${capeName}**`,                        inline: true },
        { name: "💰  Price",  value: `**$${Number(price).toLocaleString()} USD**`, inline: true },
        { name: "🪪  Buyer",  value: `<@${userId}>`,                           inline: true },
        { name: "📋  Order ID", value: `\`${orderId}\``,                       inline: true },
        { name: "⏱  Delivery", value: "Within **24 hours**",                  inline: true },
        { name: "\u200b",     value: "\u200b",                                 inline: true },
        {
          name: "⛓  Pay with Litecoin (LTC)",
          value: `\`\`\`\n${LTC_ADDRESS}\n\`\`\``,
          inline: false,
        },
      };

    if (!embed.thumbnail) delete embed.thumbnail;

    await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST", headers: botHeaders,
      body: JSON.stringify({
        content: `<@${userId}> New order — send payment to the address below and we'll deliver within 24 h.`,
        embeds: [embed],
      }),
    });

    res.json({ guildId: GUILD_ID, channelId: channel.id });
  } catch (err) {
    console.error("order:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, () => console.log(`€UFMC shop → http://localhost:${PORT}`));
