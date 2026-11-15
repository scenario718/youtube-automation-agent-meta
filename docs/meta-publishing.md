# Meta Publishing (Facebook Page + Instagram Reels)

Publish finished videos to a **Facebook Page** and to **Instagram Reels**
from the command line, using the same approval-first philosophy as the rest
of the app: nothing is posted by the scheduler or the queue — a person runs
one command per video, after reviewing it.

```bash
# Facebook Page video (resumable upload for files >= 10 MB)
npm run meta:publish -- --target fb --file data/videos/final.mp4 --caption "My caption"

# Instagram Reel
npm run meta:publish -- --target ig --file data/videos/final.mp4 --caption "My caption"

# Both, or check the plan first without any network call
npm run meta:publish -- --target both --file data/videos/final.mp4 --caption "My caption" --dry-run
```

> **Instagram requirement — read this first.** The Graph API does **not**
> accept direct file uploads for Instagram. Meta fetches the video itself
> from a **public URL**. A local file therefore has to be reachable at
> `META_PUBLIC_MEDIA_BASE_URL` (the publisher copies it into the media
> directory served by `scripts/meta/serve-media.js`). If you already host the
> MP4 somewhere public, pass that `http(s)` URL as `--file` for the `ig`
> target and no base URL is needed. Facebook Page uploads send the file
> directly and have no such requirement.

## What you need

- A **Facebook Page** you admin (videos/Reels cannot be published to
  personal profiles or Groups through the API).
- An **Instagram professional account** (Business or Creator) **linked to
  that Page** (Page Settings → Linked Accounts). API publishing does not work
  for personal IG accounts.
- A Meta developer app (below).

## Step 1 — Create the Meta app

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My
   Apps → Create App**. Choose a type that offers **Facebook Login** (the
   "Other" / consumer flow works); name it anything (e.g. "Channel
   Publisher").
2. In the app dashboard, **Add products**:
   - **Facebook Login** — set the **Valid OAuth Redirect URI** to exactly the
     value you will use as `META_REDIRECT_URI` (default
     `http://127.0.0.1:3456/meta/callback`).
   - **Instagram Graph API** — this is what enables the `instagram_*`
     permissions for the linked Page/IG account.
3. From **Settings → Basic**, copy the **App ID** and **App Secret** into
   `.env`:

```dotenv
META_APP_ID=...
META_APP_SECRET=...
```

Permissions the login flow requests (you do not configure these by hand —
the auth helper asks for them): `pages_manage_posts`,
`pages_read_engagement`, `instagram_basic`, `instagram_content_publish`,
`public_profile`.

## Step 2 — Get a long-lived user token

### Quick path (Graph API Explorer)

1. Open the [Graph API Explorer](https://developers.facebook.com/tools/explorer),
   select your app, and **Generate Access Token**, adding the five
   permissions above.
2. Click the token's **ⓘ → Open in Access Token Tool → Extend Access Token**
   to turn it into a long-lived (~60 day) token.
3. Put it in `.env` as `META_USER_ACCESS_TOKEN`, then skip to Step 3.

### Scripted path (same result, token never printed in full)

```bash
npm run meta:auth -- url
# Open the printed URL, approve, copy the ?code=... value from the address bar
npm run meta:auth -- exchange <code> --write-env
```

## Step 3 — Find your Page + Instagram IDs

```bash
npm run meta:auth -- pages --write-env
```

This lists every Page the token can manage with its linked Instagram
account, and stores `META_PAGE_ID` (and `META_IG_USER_ID`, when linked) in
`.env`. With several Pages, re-run with `--page-id <id>` to pick one. Page
access tokens are derived automatically from `/me/accounts` at publish time,
so `META_PAGE_ACCESS_TOKEN` only needs setting if you want to pin one.

## Step 4 — Instagram only: make videos publicly reachable

```bash
npm run meta:serve-media
# serves ./data/meta-media on http://127.0.0.1:3457
```

Put a tunnel or reverse proxy in front of it (for example a Cloudflare
Tunnel, or `ngrok http 3457`) and set the public base in `.env`:

```dotenv
META_PUBLIC_MEDIA_BASE_URL=https://your-public-host.example
```

Anyone with a file URL can download it while the tunnel is up — only keep
publish-ready videos in the media directory, and stop the tunnel when done.

## Step 5 — Dry-run, then publish

```bash
npm run meta:publish -- --target both --file data/videos/final.mp4 --caption "My caption" --dry-run
npm run meta:publish -- --target both --file data/videos/final.mp4 --caption "My caption"
```

Add `--unpublished` to upload a Facebook video as an unpublished post
(draft) instead of publishing it immediately. The command prints the
resulting Facebook video ID / Instagram media ID on success.

## How it works

| Target | Flow |
| --- | --- |
| Facebook Page | Files < 10 MB: one multipart `POST /{page-id}/videos`. Larger: resumable upload on `graph-video.facebook.com` — `upload_phase=start` → `transfer` chunks at Meta's offsets → `finish` with title/description. |
| Instagram Reels | `POST /{ig-user-id}/media` (`media_type=REELS`, `video_url`) → poll `GET /{container-id}?fields=status_code` until `FINISHED` → `POST /{ig-user-id}/media_publish`. |

Code: `utils/facebook-publisher.js`, `utils/instagram-publisher.js`,
shared config/HTTP in `utils/meta-config.js` and `utils/meta-graph.js`,
CLIs in `scripts/meta/`.

## Limits and caveats

- **App modes:** while the Meta app is in **Development mode**, the API
  works only for people with a role in the app (admin/developer/tester) —
  which is fine when you publish to your own Page/IG. Publishing on behalf
  of *other* people's Pages requires **Live mode + App Review** for
  `pages_manage_posts` and `instagram_content_publish` (Advanced Access).
- **Long-lived user tokens expire after ~60 days.** Page tokens derived
  from them last as long as the user token. Re-run Step 2 when publishing
  starts failing with token errors (Graph error code 190).
- **Instagram quotas:** max 100 API-published posts per rolling 24 hours;
  containers expire after 24 hours; Reels via the API are capped at
  90 seconds, MP4/MOV with H.264 video + AAC audio.
- **Facebook:** unpublished (draft) videos are supported via
  `--unpublished`; scheduled publishing is not wired up — publishing is
  immediate or draft, by design.
