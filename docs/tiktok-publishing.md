# TikTok Publishing (Content Posting API)

Publish finished videos to **TikTok** from the command line, using the same
approval-first philosophy as the rest of the app: nothing is posted by the
scheduler or the queue — a person runs one command per video, after
reviewing it.

```bash
# Upload a local file (FILE_UPLOAD — the primary flow)
npm run tiktok:publish -- --file data/videos/final.mp4 --title "My caption #fyp"

# Or let TikTok fetch the video from a public URL (PULL_FROM_URL)
npm run tiktok:publish -- --pull-url https://your-verified-host.example/final.mp4 --title "My caption"

# Check the full request plan first, without any network call
npm run tiktok:publish -- --file data/videos/final.mp4 --title "My caption" --dry-run
```

> **Audit gate — read this first.** A TikTok app that has **not** passed
> TikTok's Content Posting API audit can only post with privacy level
> **`SELF_ONLY`**: the video is created but stays **private** (visible only
> to the creator, via the inbox/processing flow). It does **not** go public,
> no matter what the code asks for. Public posting (`PUBLIC_TO_EVERYONE`)
> requires audit approval (see the Audit section below). This module
> enforces that reality in code: `SELF_ONLY` is the default, and
> `PUBLIC_TO_EVERYONE` is refused unless the app is audited **and**
> `TIKTOK_ALLOW_PUBLIC=true` is set in `.env`.

## What you need

- A **TikTok account** (the creator the videos will belong to).
- A TikTok developer app (below) — creating one is **free**.
- Videos as MP4 (recommended), MOV, or WebM.

## Step 1 — Create the TikTok app

1. Go to [developers.tiktok.com](https://developers.tiktok.com) → **Manage
   apps → Connect an app** (create a developer account first if asked).
2. In the app, **add products**:
   - **Login Kit** — enables the OAuth flow below.
   - **Content Posting API** — enables direct posting. Request the scopes
     **`video.publish`** (direct post) and **`video.upload`** (inbox/draft
     upload) alongside the basic `user.info.basic`.
3. In **Login Kit** settings, register the **Redirect URI** exactly as you
   will use it in `.env` as `TIKTOK_REDIRECT_URI` (default
   `http://127.0.0.1:3456/tiktok/callback`).
4. From the app's credentials page, copy the **Client key** and **Client
   secret** into `.env`:

```dotenv
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
```

## Step 2 — Authorize the creator account (OAuth)

```bash
npm run tiktok:auth -- url
# Open the printed URL, log in as the creator, approve the scopes,
# then copy the ?code=... value from the address bar of the redirect.
npm run tiktok:auth -- exchange <code> --write-env
```

Tokens are only ever printed **masked** (last 4 characters); `--write-env`
stores `TIKTOK_ACCESS_TOKEN`, `TIKTOK_REFRESH_TOKEN`, and `TIKTOK_OPEN_ID`
in `.env` (written mode 0600).

**Token lifetimes:** the access token lasts **~24 hours**; the refresh
token lasts **~365 days**. Before the access token expires, rotate it:

```bash
npm run tiktok:auth -- refresh --write-env
```

TikTok rotates refresh tokens too — always store the new grant (the
`--write-env` flag does this). If the refresh token itself expires, repeat
Step 2 from the top.

## Step 3 — Choose a source mode

| Mode | How | When |
| --- | --- | --- |
| `FILE_UPLOAD` (`--file`) | The video bytes are uploaded from this machine in chunks to a TikTok upload URL. | Default. Works with any local file, no hosting needed. |
| `PULL_FROM_URL` (`--pull-url`) | TikTok downloads the video from a public HTTPS URL itself. | Only when the video is already hosted. **The URL's domain must be verified in the TikTok app** (app settings → URL properties); TikTok refuses downloads from unverified domains. |

**Chunk rules (FILE_UPLOAD, per TikTok's documentation):**

- Files **≤ 64 MB** upload as a **single chunk** (`chunk_size` = file size,
  `total_chunk_count` = 1).
- Larger files are split into chunks of **5–64 MB** (this module uses
  64 MB). A final remainder smaller than 5 MB is merged into the previous
  chunk; the **final chunk may be up to 128 MB**.
- Each chunk is sent with a `Content-Range: bytes <start>-<end>/<total>`
  header to the `upload_url` returned by the init call. The dry-run prints
  the exact chunk plan for your file before anything is sent.

## Step 4 — Dry-run, then publish

```bash
npm run tiktok:publish -- --file data/videos/final.mp4 --title "My caption" --dry-run
npm run tiktok:publish -- --file data/videos/final.mp4 --title "My caption"
```

The publish flow is:

1. `POST /post/publish/creator_info/query/` — confirm the creator and that
   the requested privacy level is among their `privacy_level_options`
   (for an unaudited app, only `SELF_ONLY` is).
2. `POST /post/publish/video/init/` — opens the publish session, returns
   `publish_id` (+ `upload_url` for FILE_UPLOAD).
3. FILE_UPLOAD only: `PUT` each chunk to the `upload_url`.
4. `POST /post/publish/status/fetch/` — polled until `PUBLISH_COMPLETE` or
   `FAILED`. With `SELF_ONLY`, completion means the video exists but is
   **private**; some flows end at `SEND_TO_USER_INBOX`, leaving the video
   in the creator's TikTok inbox for a final manual tap.

## The audit (going public)

Until TikTok approves the app, everything above produces **private** posts.
To publish publicly:

1. In the TikTok developer portal, apply for the **Content Posting API
   audit** for the app (TikTok reviews the app, its use case, and a demo of
   the posting flow; this is TikTok's process and timeline, not something
   this module can shortcut).
2. After approval, public privacy levels become available in
   `creator_info`'s `privacy_level_options`.
3. Set the deliberate opt-in in `.env` and choose the level per publish:

```dotenv
TIKTOK_ALLOW_PUBLIC=true
```

```bash
npm run tiktok:publish -- --file data/videos/final.mp4 --title "My caption" --privacy PUBLIC_TO_EVERYONE
```

## How it works

| Piece | Role |
| --- | --- |
| `utils/tiktok-config.js` | All `TIKTOK_*` env config, missing-var listing, token masking. |
| `utils/tiktok-api.js` | HTTP wrapper for `open.tiktokapis.com`: Bearer JSON POSTs, TikTok error normalization (`error.code` / `message` / `log_id`), `creator_info` query, `video/init`, `status/fetch`, and the OAuth token endpoint. |
| `utils/tiktok-publisher.js` | `TikTokPublisher` — privacy guardrail, chunk planning, FILE_UPLOAD chunk PUTs, PULL_FROM_URL init, status polling. |
| `scripts/tiktok/tiktok-auth.js` | OAuth CLI: `url`, `exchange <code>`, `refresh`. |
| `scripts/tiktok/publish.js` | Publish CLI with `--dry-run` plan printing (zero network calls). |

## Limits and caveats

- **Unaudited = private only.** See the audit gate at the top. There is no
  setting in this module that bypasses TikTok's audit.
- **Token lifetimes:** access ~24 h, refresh ~365 days (rotating). Plan on
  running the refresh command regularly; publishing fails with auth errors
  once the access token lapses.
- **Chunk rules** are TikTok's, summarized in Step 3 — very large files are
  fine, but each chunk PUT must succeed in order.
- **Titles** double as captions and are limited to 2200 characters;
  hashtags and mentions in the title text are carried as plain text.
- **PULL_FROM_URL** requires a verified domain in the app; an unverified
  domain fails at TikTok's download step, not at init.
- **No scheduling** is wired up — publishing is immediate and explicit,
  by design, matching the app's approval-first philosophy.
