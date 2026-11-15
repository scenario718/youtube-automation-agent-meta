const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');
const { assertMetaConfig } = require('./meta-config');
const { graphGet, graphPostForm, resolvePageAccessToken, resolveIgUserId } = require('./meta-graph');

// Publishes Reels to the Instagram professional account linked to the
// configured Facebook Page, using Meta's container flow:
//   1. POST /{ig-user-id}/media          (media_type=REELS) -> container id
//   2. GET  /{container-id}?fields=status_code             -> poll FINISHED
//   3. POST /{ig-user-id}/media_publish  (creation_id)     -> media id
//
// IMPORTANT: the Graph API does NOT accept direct file uploads for
// Instagram. Meta fetches the video itself from a public URL, so a local
// file must first be reachable at META_PUBLIC_MEDIA_BASE_URL — see
// resolvePublicVideoUrl() and scripts/meta/serve-media.js.
//
// Publishing is explicit-invocation only: nothing here is wired into the
// scheduler or the publishing queue. See scripts/meta/publish.js.

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

// Turns a local file (or an already-public URL) into the public video_url
// Meta will fetch. An http(s) input is used as-is. A local file is copied
// into the media directory (config.mediaDir) that serve-media.js exposes,
// and the URL is built from META_PUBLIC_MEDIA_BASE_URL.
async function resolvePublicVideoUrl(config, input) {
  if (isHttpUrl(input)) {
    return { videoUrl: input, copiedPath: null };
  }
  const stats = await fs.stat(input).catch(() => null);
  if (!stats?.isFile()) {
    throw new Error(`Video file not found: ${input}`);
  }
  if (!config.publicMediaBaseUrl) {
    throw new Error(
      'Instagram cannot fetch a local file. Set META_PUBLIC_MEDIA_BASE_URL to a public base URL ' +
      'that serves the media directory (see docs/meta-publishing.md and scripts/meta/serve-media.js), ' +
      'or pass an http(s) video URL instead of a local path.'
    );
  }
  await fs.mkdir(config.mediaDir, { recursive: true });
  const fileName = path.basename(input);
  const copiedPath = path.join(config.mediaDir, fileName);
  if (path.resolve(input) !== path.resolve(copiedPath)) {
    await fs.copyFile(input, copiedPath);
  }
  const base = config.publicMediaBaseUrl.replace(/\/+$/, '');
  return { videoUrl: `${base}/${encodeURIComponent(fileName)}`, copiedPath };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class InstagramPublisher {
  constructor(config) {
    this.config = assertMetaConfig(config);
    this.logger = new Logger('InstagramPublisher');
    this._pageAccessToken = null;
    this._igUserId = null;
  }

  async pageAccessToken() {
    if (!this._pageAccessToken) {
      this._pageAccessToken = await resolvePageAccessToken(this.config);
    }
    return this._pageAccessToken;
  }

  async igUserId() {
    if (!this._igUserId) {
      this._igUserId = await resolveIgUserId(this.config, await this.pageAccessToken());
    }
    return this._igUserId;
  }

  async waitForContainer(containerId, accessToken) {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    for (;;) {
      const status = await graphGet(this.config, String(containerId), accessToken, {
        fields: 'status_code,status'
      });
      if (status.status_code === 'FINISHED') return status;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new Error(
          `Instagram container ${containerId} ended with ${status.status_code}: ${status.status || 'no detail from Meta'}`
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Instagram container ${containerId} did not reach FINISHED within ${Math.round(this.config.pollTimeoutMs / 1000)}s ` +
          `(last status: ${status.status_code || 'unknown'}). The container stays valid for 24h; do not create duplicates blindly.`
        );
      }
      this.logger.info(`Instagram container ${containerId}: ${status.status_code || 'IN_PROGRESS'} — waiting ${Math.round(this.config.pollIntervalMs / 1000)}s`);
      await delay(this.config.pollIntervalMs);
    }
  }

  // video: local .mp4 path or public http(s) URL. Returns { mediaId, containerId, videoUrl }.
  async publishReel({ video, caption = '', shareToFeed = true } = {}) {
    if (!video) throw new Error('publishReel requires a video path or URL');
    const { videoUrl } = await resolvePublicVideoUrl(this.config, video);
    const accessToken = await this.pageAccessToken();
    const igUserId = await this.igUserId();

    this.logger.info(`Creating Instagram Reel container for ${igUserId} from ${videoUrl}`);
    const container = await graphPostForm(this.config, `${igUserId}/media`, accessToken, {
      media_type: 'REELS',
      video_url: videoUrl,
      caption,
      share_to_feed: shareToFeed
    });
    if (!container.id) {
      throw new Error(`Instagram did not return a container id: ${JSON.stringify(container)}`);
    }

    await this.waitForContainer(container.id, accessToken);

    const published = await graphPostForm(this.config, `${igUserId}/media_publish`, accessToken, {
      creation_id: container.id
    });
    if (!published.id) {
      throw new Error(`Instagram media_publish did not return a media id: ${JSON.stringify(published)}`);
    }
    this.logger.success(`Instagram Reel published: ${published.id}`);
    return { mediaId: published.id, containerId: container.id, videoUrl };
  }
}

module.exports = { InstagramPublisher, resolvePublicVideoUrl };
