# Message Studio

Message Studio is a private website for composing Discord messages. It sends and edits messages through the Discord bot account associated with your token. Editors sign in with Discord, and Railway controls which user IDs can access the site.

## Set up on Railway

1. Upload the ZIP contents to your Railway service. At the top level of the upload you should see `package.json`, `server.mjs`, `railway.toml`, and `public/`. If your uploader takes extracted files, select the contents of the extracted folder. Railway detects Node.js and runs `npm start` from `railway.toml`.
2. Open your service and go to **Settings → Networking → Public Networking → Generate Domain**. Keep the generated HTTPS address. For a custom domain, set `APP_URL` to the full HTTPS origin.
3. Open your existing bot application in the Discord Developer Portal. Under **OAuth2 → Redirects**, add the Railway HTTPS address followed by `/auth/discord/callback`, such as `https://your-service.up.railway.app/auth/discord/callback`. Click **Save Changes**. [Discord Developer Portal](https://discord.com/developers/applications)
4. Under **OAuth2**, copy the **Client ID** and obtain the **Client Secret**. Under **Bot**, use the bot token for the same application. To copy user and server IDs in Discord, enable **User Settings → Advanced → Developer Mode**.
5. Open **Variables** in Railway. Add each name and value separately.

| Name | Value |
| --- | --- |
| `DISCORD_TOKEN` | Token from your application's **Bot** page |
| `DISCORD_CLIENT_ID` | **Client ID** from the **OAuth2** page |
| `DISCORD_CLIENT_SECRET` | **Client Secret** from the **OAuth2** page |
| `GUILD_ID` | The ID of the Discord server the channel picker should show |
| `OWNER_IDS` | Approved Discord user IDs separated by commas, such as `111111111111111111,222222222222222222` |
| `APP_URL` | Optional custom HTTPS origin. A Railway-generated domain is detected automatically. |

6. Deploy the changes. Open the Railway HTTPS address and select **Continue with Discord**. Use a Discord account listed in `OWNER_IDS`.

The bot needs **View Channel** and **Send Messages** in the channels you want to post in. Grant **Embed Links** for embeds, **Attach Files** for image uploads, and **Read Message History** for editing. If the bot is absent from the server, install it from the Discord application's **Installation** page with the `bot` scope. The website sends through the Discord REST API. A Discord gateway process is unnecessary for posting.

## Post a message

1. Choose a destination. The picker includes text and announcement channels in the configured server where the bot can send.
2. Write your message, attach images, or add an embed. The preview updates as you type. User and role notifications are off until enabled for the draft.
3. Select **Review & send**, check the destination, and select **Send message**. After sending, open the published message in Discord or use **Send again** to pick another channel. **Edit message** loads the most recent post from this browser session for editing in place.

## Run locally

Install Node.js 22 or later, copy `.env.example` to `.env`, and fill in the same values. Set `APP_URL=http://localhost:3000` and add `http://localhost:3000/auth/discord/callback` as a second Discord OAuth2 redirect. Run `npm start` and open `http://localhost:3000`.
