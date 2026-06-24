import { Router } from "express";

const router = Router();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CATEGORY_ID = process.env.DISCORD_CATEGORY_ID;

const DISCORD_API = "https://discord.com/api/v10";
const botHeaders = () => ({
  Authorization: `Bot ${BOT_TOKEN}`,
  "Content-Type": "application/json",
});

const CAPES = [
  { id: 1, name: "Minecraft Experience", accent: "#4c1d95", price: 60 },
  { id: 2, name: "Moonlight Trial",      accent: "#3b82f6", price: 259 },
  { id: 3, name: "Crafter",              accent: "#d97706", price: 600 },
  { id: 4, name: "Follower's",           accent: "#16a34a", price: 450 },
  { id: 5, name: "Purple Heart",         accent: "#a855f7", price: 20 },
  { id: 6, name: "Menace",               accent: "#ef4444", price: 10 },
];

const LTC_ADDRESS = "ltc1qw7t79qc646uxzxq8xnrw46g4mj7d2hfu87cxxj";

async function findMember(rawUsername) {
  if (!BOT_TOKEN || !GUILD_ID) return null;
  const clean = rawUsername.split("#")[0].trim().toLowerCase();
  const res = await fetch(
    `${DISCORD_API}/guilds/${GUILD_ID}/members/search?query=${encodeURIComponent(clean)}&limit=10`,
    { headers: botHeaders() },
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
      return (
        uLow === clean ||
        (tag && tag === rawUsername.trim().toLowerCase())
      );
    }) ?? (members.length > 0 ? members[0] : null)
  );
}

router.get("/validate-user", async (req, res) => {
  if (!BOT_TOKEN || !GUILD_ID) {
    res.status(503).json({ error: "Discord bot not configured" });
    return;
  }
  const username = (req.query["username"] || "").trim();
  if (!username) {
    res.status(400).json({ error: "username required" });
    return;
  }
  try {
    const member = await findMember(username);
    if (!member) {
      res.status(404).json({ valid: false });
      return;
    }
    res.json({ valid: true, userId: member.user.id });
  } catch (err) {
    req.log.error({ err }, "validate-user error");
    res.status(500).json({ error: "Internal error" });
  }
});

router.post("/order", async (req, res) => {
  if (!BOT_TOKEN || !GUILD_ID) {
    res.status(503).json({ error: "Discord bot not configured" });
    return;
  }
  const { discordUsername, capeId, capeName, price, capeAccent } = req.body as {
    discordUsername: string;
    capeId?: number;
    capeName: string;
    price: number;
    capeAccent?: string;
  };

  if (!discordUsername || !capeName || price == null) {
    res.status(400).json({ error: "discordUsername, capeName, price are required" });
    return;
  }

  try {
    const member = await findMember(discordUsername);
    if (!member) {
      res.status(403).json({ error: "User not found in Discord server" });
      return;
    }

    const userId = member.user.id;
    const safeUser = discordUsername.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18) || "user";
    const safeCape = capeName.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 18);

    const channelBody: Record<string, unknown> = {
      name: `ticket-${safeCape}-${safeUser}`,
      type: 0,
      topic: `Order: ${capeName} | $${price} USD | ${discordUsername}`,
      permission_overwrites: [
        { id: GUILD_ID, type: 0, deny: "1024" },
        { id: userId, type: 1, allow: "52224" },
      ],
    };
    if (CATEGORY_ID) channelBody["parent_id"] = CATEGORY_ID;

    const chanRes = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/channels`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify(channelBody),
    });

    if (!chanRes.ok) {
      req.log.error({ body: await chanRes.json().catch(() => ({})) }, "Channel create failed");
      res.status(500).json({ error: "Failed to create ticket channel" });
      return;
    }
    const channel = (await chanRes.json()) as { id: string };

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const base = `${proto}://${req.headers.host}`;
    const resolvedId = capeId || (CAPES.find((c) => c.name === capeName) || {}).id;
    const capeImageUrl = resolvedId ? `${base}/cape-${resolvedId}.png` : null;
    const color = capeAccent ? parseInt(capeAccent.replace("#", ""), 16) : 0x5865f2;

    const orderId = `#${Date.now().toString(36).toUpperCase()}`;

    const embed: Record<string, unknown> = {
      author: {
        name: "€UFMC — Minecraft Cape Shop",
        icon_url: `${base}/logo.png`,
      },
      title: `🧥 New Order — ${capeName}`,
      description: `<@${userId}> opened a purchase request. Follow the steps below to complete your order.`,
      color,
      fields: [
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
      ],
      image: capeImageUrl ? { url: capeImageUrl } : undefined,
      footer: {
        text: `€UFMC · All sales are final · Order ${orderId}`,
        icon_url: `${base}/logo.png`,
      },
      timestamp: new Date().toISOString(),
    };
    if (!embed["image"]) delete embed["image"];

    const buyerInstructions = [
      `👋 Hey <@${userId}>, welcome to your order ticket!`,
      ``,
      `**Here's what to do next:**`,
      `> **1.** Copy the Litecoin address above`,
      `> **2.** Send exactly **$${Number(price).toLocaleString()} USD** worth of LTC to that address`,
      `> **3.** Drop a screenshot of your transaction in this channel`,
      `> **4.** We'll confirm and deliver your **${capeName}** cape within 24 h ✅`,
      ``,
      `> ⚠️ Make sure to send from a wallet you control, **not** an exchange. All sales are final.`,
    ].join("\n");

    await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ embeds: [embed] }),
    });

    await fetch(`${DISCORD_API}/channels/${channel.id}/messages`, {
      method: "POST",
      headers: botHeaders(),
      body: JSON.stringify({ content: buyerInstructions }),
    });

    res.json({ guildId: GUILD_ID, channelId: channel.id });
  } catch (err) {
    req.log.error({ err }, "order error");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
