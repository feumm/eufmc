# €UFMC Cape Shop — Setup

## Requirements
- Node.js 18 or newer  (https://nodejs.org)

## Steps
1. Open a terminal in this folder
2. Run:  npm install
3. Rename `.env.example` to `.env` and paste your bot token + server ID
4. Run:  node server.js
5. Open  http://localhost:3000

## Sharing links with per-cape previews (Discord/Twitter/WhatsApp)
Each cape has a shareable link that shows the cape image when posted:
  https://your-domain.com/?cape=1   ← Minecraft Experience
  https://your-domain.com/?cape=2   ← Moonlight Trial
  https://your-domain.com/?cape=3   ← Crafter
  https://your-domain.com/?cape=4   ← Follower's
  https://your-domain.com/?cape=5   ← Purple Heart
  https://your-domain.com/?cape=6   ← Menace

## Deploying to Railway
1. Push code to GitHub (without the .env file!)
2. Go to railway.app → New Project → Deploy from GitHub
3. Add environment variables in Railway's Variables tab (same as .env)
4. Settings → Networking → Generate Domain → done

## Security
- NEVER commit .env to GitHub. Add it to .gitignore.
- The bot token is only ever read at runtime — never in any HTML or JS file.
