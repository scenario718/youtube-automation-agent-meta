const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { Logger } = require('./logger');
const { assertTikTokConfig, PRIVACY_LEVELS } = require('./tiktok-config');
const { queryCreatorInfo, initVideoPublish, fetchPublishStatus } = require('./tiktok-api');

// Publishes videos to TikTok with the Content Posting API (direct post).
//
// Two source modes:
//   1. FILE_UPLOAD (primary) — works with local files. The publish is
//      initialized with POST /post/publish/video/init/, the file bytes are
//      PUT to the returned upload_url in chunks (Content-Range headers),
//      and POST /post/publish/status/fetch/ is polled until PUBLISH_COMPLETE
//      or FAILED.
//   2. PULL_FROM_URL (secondary) — TikTok fetches the video itself from a
//      public URL. NOTE: the URL's domain must be verified in the TikTok
//      developer app first, or TikTok refuses to download it.
//
// PRIVACY GUARDRAIL — READ THIS: an unaudited TikTok app can ONLY post
// with privacy_level SELF_ONLY (the video lands as private / in the
// creator's inbox flow). Public posting (PUBLIC_TO_EVERYONE) is unlocked
// only after the app passes TikTok's Content Posting API audit. This module
// therefore defaults to SELF_ONLY, and PUBLIC_TO_EVERYONE is refused unless
// the owner has deliberately set TIKTOK_ALLOW_PUBLIC=true in .env. See the
// audit section of docs/tiktok-publishing.md.
//
// Publishing is explicit-invocation only: nothing here is wired into the
// scheduler or the publishing queue. See scripts/tiktok/publish.js.

const MIN_CHUNK_BYTES = 5 * 1024 * 1024; // 5 MB — smallest allowed chunk
const MAX_CHUNK_BYTES = 64 * 1024 * 1024; // 64 MB — largest allowed chunk
const MAX_FINAL_CHUNK_BYTES = 128 * 1024 * 1024; // 128 MB — final chunk ceiling
const SUPPORTED_EXTENSIONS = ['.mp4', '.mov', '.webm'];

// Plans the FILE_UPLOAD chunks for a file size, following TikTok's rules:
//   - video_size <= 64 MB: a single chunk (chunk_size = video_size,
//     total_chunk_count = 1).
//   - larger files: chunks of 5–64 MB. A final remainder smaller than 5 MB
//     is merged into the previous chunk instead of standing alone; the
//     final chunk may be up to 128 MB.
// Returns { chunkSize, totalChunkCount, chunks: [{ index, offset, size,
// contentRange }] } where contentRange is the exact Content-Range header
// value for that chunk's PUT.
function planChunks(videoSize) {
  if (!Number.isFinite(videoSize) || videoSize <= 0) {
    throw new Error(`Cannot plan upload chunks for invalid video size: ${videoSize}`);
  }
  let chunkSize;
  const sizes = [];
  if (videoSize <= MAX_CHUNK_BYTES) {
    chunkSize = videoSize;
    sizes.push(videoSize);
  } else {
    chunkSize = MAX_CHUNK_BYTES;
    const fullChunks = Math.floor(videoSize / chunkSize);
    const remainder = videoSize - fullChunks * chunkSize;
    for (let i = 0; i < fullChunks; i++) sizes.push(chunkSize);
    if (remainder >= MIN_CHUNK_BYTES) {
      sizes.push(remainder);
    } else if (remainder > 0) {
      // Too small to stand alone — merge it into the final chunk, which
      // stays far below the 128 MB final-chunk ceiling.
      sizes[sizes.length - 1] += remainder;
    }
  }
  let offset = 0;
  const chunks = sizes.map((size, index) => {
    const chunk = {
      index,
      offset,
      size,
      contentRange: `bytes ${offset}-${offset + size - 1}/${videoSize}`
    };
    offset += size;
    return chunk;
  });
  return { chunkSize, totalChunkCount: chunks.length, chunks };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class TikTokPublisher {
  constructor(config) {
    this.config = assertTikTokConfig(config);
    this.logger = new Logger('TikTokPublisher');
  }

  // Applies the privacy guardrail described in the header comment. Returns
  // the privacy level that will actually be sent to TikTok.
  resolvePrivacyLevel(requested) {
    const level = requested || this.config.privacyLevel || 'SELF_ONLY';
    if (!PRIVACY_LEVELS.includes(level)) {
      throw new Error(`Unknown TikTok privacy level "${level}". Use one of: ${PRIVACY_LEVELS.join(', ')}`);
    }
    if (level === 'PUBLIC_TO_EVERYONE' && !this.config.allowPublic) {
      throw new Error(
        'PUBLIC_TO_EVERYONE is blocked: public posting requires an app that has passed ' +
        'TikTok\'s Content Posting API audit, plus the deliberate opt-in TIKTOK_ALLOW_PUBLIC=true in .env. ' +
        'Unaudited apps can only post SELF_ONLY. See docs/tiktok-publishing.md (audit section).'
      );
    }
    return level;
  }

  buildPostInfo({ title, privacyLevel, disableComment = false, disableDuet = false, disableStitch = false, videoCoverTimestampMs = 0 }) {
    if (!title || !String(title).trim()) throw new Error('A video title/caption is required');
    if (String(title).length > 2200) throw new Error('TikTok titles are limited to 2200 characters');
    return {
      title: String(title),
      privacy_level: this.resolvePrivacyLevel(privacyLevel),
      disable_comment: Boolean(disableComment),
      disable_duet: Boolean(disableDuet),
      disable_stitch: Boolean(disableStitch),
      video_cover_timestamp_ms: Number(videoCoverTimestampMs) || 0
    };
  }

  // Queries creator_info and refuses early when the requested privacy level
  // is not among the options TikTok reports for this creator/app (the usual
  // symptom of an unaudited app asking for anything but SELF_ONLY).
  async checkCreator(postInfo) {
    const creator = await queryCreatorInfo(this.config);
    const options = creator.privacy_level_options || [];
    if (options.length && !options.includes(postInfo.privacy_level)) {
      throw new Error(
        `Privacy level ${postInfo.privacy_level} is not available for this creator — TikTok reports: ${options.join(', ')}. ` +
        'For an unaudited app only SELF_ONLY is available; public posting needs the Content Posting API audit.'
      );
    }
    if (postInfo.disable_comment === false && creator.comment_disabled) {
      this.logger.warn('Creator has comments disabled account-wide; the video will publish without comments');
    }
    return creator;
  }

  async uploadChunk(uploadUrl, chunkBuffer, chunk, videoSize) {
    try {
      await axios.put(uploadUrl, chunkBuffer, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': chunkBuffer.length,
          'Content-Range': chunk.contentRange
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 300000
      });
    } catch (error) {
      throw new Error(
        `TikTok chunk upload failed for bytes ${chunk.offset}-${chunk.offset + chunk.size - 1}/${videoSize}: ` +
        (error.response?.data?.error?.message || error.message)
      );
    }
  }

  // Polls status/fetch until the post completes or fails. SELF_ONLY posts
  // from unaudited apps surface honestly here: PUBLISH_COMPLETE means the
  // video exists but is private (visible only to the creator), and some
  // flows report SEND_TO_USER_INBOX instead — the video then waits in the
  // creator's TikTok inbox for a manual final tap.
  async waitForPublish(publishId, privacyLevel) {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    for (;;) {
      const status = await fetchPublishStatus(this.config, publishId);
      const state = status.status || 'UNKNOWN';
      if (state === 'PUBLISH_COMPLETE') {
        const postIds = status.publicaly_available_post_id || [];
        if (privacyLevel === 'SELF_ONLY') {
          this.logger.success(`TikTok post ${publishId} complete — privacy SELF_ONLY: the video is private, visible only to the creator`);
        } else {
          this.logger.success(`TikTok post published: ${postIds.join(', ') || publishId}`);
        }
        return { publishId, status: state, postIds };
      }
      if (state === 'FAILED') {
        throw new Error(`TikTok publish ${publishId} FAILED: ${status.fail_reason || 'no reason reported by TikTok'}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `TikTok publish ${publishId} did not complete within ${Math.round(this.config.pollTimeoutMs / 1000)}s ` +
          `(last status: ${state}). Check the creator's TikTok inbox before retrying — do not publish duplicates blindly.`
        );
      }
      this.logger.info(`TikTok publish ${publishId}: ${state} — waiting ${Math.round(this.config.pollIntervalMs / 1000)}s`);
      await delay(this.config.pollIntervalMs);
    }
  }

  // Primary flow: upload a local video file, then poll until complete.
  // Returns { publishId, status, postIds, privacyLevel, upload: 'file' }.
  async publishVideoFile({ videoPath, title, privacyLevel, disableComment, disableDuet, disableStitch, videoCoverTimestampMs } = {}) {
    const stats = await fs.stat(videoPath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Video file not found: ${videoPath}`);
    }
    const ext = path.extname(videoPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new Error(`TikTok publishing expects one of ${SUPPORTED_EXTENSIONS.join(', ')}, got: ${videoPath}`);
    }
    const postInfo = this.buildPostInfo({ title, privacyLevel, disableComment, disableDuet, disableStitch, videoCoverTimestampMs });
    await this.checkCreator(postInfo);

    const plan = planChunks(stats.size);
    const init = await initVideoPublish(this.config, {
      post_info: postInfo,
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: stats.size,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount
      }
    });
    if (!init.publish_id || !init.upload_url) {
      throw new Error(`TikTok did not return a publish id / upload url: ${JSON.stringify(init)}`);
    }
    this.logger.info(
      `Uploading ${path.basename(videoPath)} (${stats.size} bytes) to TikTok as ${postInfo.privacy_level}: ` +
      `${plan.totalChunkCount} chunk(s), publish_id ${init.publish_id}`
    );

    const handle = await fs.open(videoPath, 'r');
    try {
      for (const chunk of plan.chunks) {
        const buffer = Buffer.alloc(chunk.size);
        const { bytesRead } = await handle.read(buffer, 0, chunk.size, chunk.offset);
        if (bytesRead !== chunk.size) {
          throw new Error(`Short read on ${videoPath}: expected ${chunk.size} bytes at offset ${chunk.offset}, got ${bytesRead}`);
        }
        await this.uploadChunk(init.upload_url, buffer, chunk, stats.size);
        this.logger.info(`TikTok upload progress: ${chunk.offset + chunk.size}/${stats.size} bytes`);
      }
    } finally {
      await handle.close();
    }

    const result = await this.waitForPublish(init.publish_id, postInfo.privacy_level);
    return { ...result, privacyLevel: postInfo.privacy_level, upload: 'file' };
  }

  // Secondary flow: TikTok pulls the video from a public URL. The URL's
  // domain must be verified in the TikTok developer app (URL properties),
  // otherwise TikTok refuses the download.
  // Returns { publishId, status, postIds, privacyLevel, upload: 'pull' }.
  async publishVideoFromUrl({ videoUrl, title, privacyLevel, disableComment, disableDuet, disableStitch, videoCoverTimestampMs } = {}) {
    if (!/^https:\/\//i.test(String(videoUrl || ''))) {
      throw new Error(`PULL_FROM_URL needs an https video URL, got: ${videoUrl}`);
    }
    const postInfo = this.buildPostInfo({ title, privacyLevel, disableComment, disableDuet, disableStitch, videoCoverTimestampMs });
    await this.checkCreator(postInfo);

    const init = await initVideoPublish(this.config, {
      post_info: postInfo,
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: videoUrl
      }
    });
    if (!init.publish_id) {
      throw new Error(`TikTok did not return a publish id: ${JSON.stringify(init)}`);
    }
    this.logger.info(`TikTok is pulling ${videoUrl} (publish_id ${init.publish_id}, privacy ${postInfo.privacy_level})`);

    const result = await this.waitForPublish(init.publish_id, postInfo.privacy_level);
    return { ...result, privacyLevel: postInfo.privacy_level, upload: 'pull' };
  }
}

module.exports = {
  TikTokPublisher,
  planChunks,
  MIN_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  MAX_FINAL_CHUNK_BYTES
};
