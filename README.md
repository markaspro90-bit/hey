# Message Studio

Message Studio is a password-protected website for composing and scheduling messages. It uses your Discord bot account to publish and edit posts. Anyone who knows the website password can use the editor and manage the shared schedule.

## Set up on Railway

1. Upload the ZIP to your existing Railway website service. The archive has `package.json` and `railway.toml` at the top level. Keep **Root Directory** empty or set to `/`. Railway starts the site with `npm start`.
2. In **Variables**, keep `DISCORD_TOKEN` and `GUILD_ID` and add `STUDIO_PASSWORD`. This is the password you will type into the website. The updated site needs these three variables.

| Name | Value |
| --- | --- |
| `DISCORD_TOKEN` | Token from your application's **Bot** page |
| `GUILD_ID` | The ID of the Discord server the channel picker should show |
| `STUDIO_PASSWORD` | A private password of at least 8 characters |
| `APP_URL` | Optional custom HTTPS origin. A Railway-generated domain is detected automatically. |

3. On the Railway project canvas, open the right-click menu and choose **Volume**. Attach it to the website service with **Mount Path** set to `/data`. Keep a single replica for that service. The volume stores the schedule across redeploys. [Railway volumes](https://docs.railway.com/volumes)
4. Deploy the changes. Open the HTTPS link under **Settings → Networking** and sign in with your password. Keep the service running for scheduled posts to send on time. If the service has a **Serverless** setting that lets it sleep when idle, turn it off.

The bot needs **View Channel** and **Send Messages** in the channels you want to post in. Grant **Embed Links** for embeds, **Attach Files** for image uploads, and **Read Message History** for editing. If the bot is absent from the server, install it from the Discord application's **Installation** page with the `bot` scope. The website sends through the Discord REST API. A Discord gateway process is unnecessary for posting.

## Post a message

1. Choose a destination. The picker includes text and announcement channels in the configured server where the bot can send.
2. Write your message, attach images, or add an embed. The preview updates as you type. User and role notifications are off until enabled for the draft.
3. Select **Review & send**, check the destination, and select **Send message**. After sending, open the published message in Discord or use **Send again** to pick another channel. **Edit message** loads the most recent post from this browser session for editing in place.

## Schedule messages

1. Compose a message and choose its channel.
2. Select **Schedule for later**, choose a date and time in your browser's time zone, and confirm. Repeat for each message you want to queue.
3. Use **Scheduled messages** to see upcoming posts, cancel a queued post, or open the Discord link after delivery. The server sends automatically with the browser closed. If the service was briefly offline, due messages send when it comes back. If Discord could not confirm delivery, the queue asks you to check the channel before scheduling again.

## Run locally

Install Node.js 22.13 or later, copy `.env.example` to `.env`, and fill in the same values. Run `npm start` and open `http://localhost:3000`. Local scheduled messages are stored under `.data/`. Set `DATA_DIR` to use another folder locally.
