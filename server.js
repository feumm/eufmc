const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CATEGORY_ID = process.env.DISCORD_CATEGORY_ID;

if (!BOT_TOKEN || !GUILD_ID) {
  console.error("ERROR: DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set in your .env file.");
  process.exit(1);
}

const DISCORD_API = "https://discord.com/api/v10";
const botHeaders = {
  Authorization: `Bot ${BOT_TOKEN}`,
  "Content-Type": "application/json",
};

app.use(express.json());
app.use(express.static(path.join(__dirname)));

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
      const tag =
        m.user.discriminator && m.user.discriminator !== "0"
          ? `${m.user.username}#${m.user.discriminator}`.toLowerCase()
          : null;
      return uLow === clean || (tag && tag === rawUsername.trim().toLowerCase());
    }) ?? (members.length > 0 ? members[0] : null)
  );
}

app.get("/api/validate-user", async (req, res) => {
  const username = (req.query.username || "").trim();
  if (!username) return res.status(400).json({ error: "username required" });
  try {
    const member = await findMember(username);
    if (!member) return res.status(404).json({ found: false });
    res.json({ found: true, userId: member.user.id });
  } catch (err) {
    console.error("validate-user error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.post("/api/order", async (req, res) => {
  const { discordUsername, capeName, price, capeAccent } = req.body;
  if (!discordUsername || !capeName || price == null)
    return res.status(400).json({ error: "discordUsername, capeName, price are required" });

  try {
    const member = await findMember(discordUsername);
    if (!member) return res.status(403).json({ error: "User not found in Discord server" });

    const userId = member.user.id;
    const safeUser = discordUsername.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18) || "user";
    const safeCape = capeName.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18);
    const channelName = `ticket-${safeCape}-${safeUser}`;

    const channelBody = {
      name: channelName,
      type: 0,
      topic: `Order: ${capeName} | $${price} USD | ${discordUsername}`,
      permission_overwrites: [
        { id: GUILD_ID, type: 0, deny: "1024" },
        { id: userId, type: 1, allow: "52224" },
      ],
    };
    if (CATEGORY_ID) channelBody.parent_id = CATEGORY_ID;

    const chanRes = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/channels`, {
      method: "POST",
      headers: botHeaders,
      body: JSON.stringify(channelBody),
    });

    if (!chanRes.ok) {
      const errBody = await chanRes.json().catch(() => ({}));
      console.error("Discord channel creation failed:", errBody);
      return res.status(500).json({ error: "Failed to create ticket channel" });
    }

    const channel = await chanRes.json();

    const accentColor = capeAccent ? parseInt(capeAccent.replace("#", ""), 16) : 0x5865f2;

    await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: botHeaders,
      body: JSON.stringify({
        content: `<@${userId}> Your purchase request has been received! Our team will be with you shortly.`,
        embeds: [
          {
            title: `🛒 Order: ${capeName}`,
            color: accentColor,
            fields: [
              { name: "Cape", value: capeName, inline: true },
              { name: "Price", value: `$${price} USD`, inline: true },
              { name: "Customer", value: `<@${userId}>`, inline: true },
            ],
            footer: { text: "€UFMC Cape Shop • Not affiliated with Mojang AB or Microsoft" },
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    res.json({ guildId: GUILD_ID, channelId: channel.id });
  } catch (err) {
    console.error("order error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, () => {
  console.log(`€UFMC shop running at http://localhost:${PORT}`);
});
