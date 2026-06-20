# €UFMC Cape Shop

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Create a `.env` file (copy from `.env.example`) and fill in your values:
   ```
   DISCORD_BOT_TOKEN=your_bot_token_here
   DISCORD_GUILD_ID=your_server_id_here
   DISCORD_CATEGORY_ID=your_category_id_here
   PORT=3000
   ```

3. Start the server:
   ```
   node -r dotenv/config server.js
   ```
   Or if you set env vars manually (e.g. on a VPS):
   ```
   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... node server.js
   ```

4. Open http://localhost:3000 in your browser.

## Notes
- Node.js 18+ required (uses built-in fetch).
- The bot must have the **Manage Channels** and **Read Messages** permissions in your Discord server.
- Never commit your `.env` file to GitHub — add it to `.gitignore`.
