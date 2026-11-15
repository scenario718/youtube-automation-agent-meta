const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const { Logger } = require('./logger');
const { assertMetaConfig } = require('./meta-config');
const { GRAPH_HOST, GRAPH_VIDEO_HOST, graphPostForm, resolvePageAccessToken } = require('./meta-graph');

// Publishes videos to the configured Facebook Page.
//
// Large files use Meta's resumable (chunked) upload against
// graph-video.facebook.com in three phases — start, transfer, finish — so an
// interrupted upload reports exactly how far it got. Files under
// SINGLE_SHOT_MAX_BYTES use a one-request multipart upload instead.
//
// Publishing is explicit-invocation only: nothing here is wired into the
// scheduler or the publishing queue. See scripts/meta/publish.js.

const SINGLE_SHOT_MAX_BYTES = 10 * 1024 * 1024;

class FacebookPublisher {
  constructor(config) {
    this.config = assertMetaConfig(config);
    this.logger = new Logger('FacebookPublisher');
    this._pageAccessToken = null;
  }

  async pageAccessToken() {
    if (!this._pageAccessToken) {
      this._pageAccessToken = await resolvePageAccessToken(this.config);
    }
    return this._pageAccessToken;
  }

  // videoPath: local .mp4 file. Returns { videoId, upload: 'resumable'|'single' }.
  async publishVideo({ videoPath, title = '', description = '', published = true } = {}) {
    const stats = await fs.stat(videoPath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Video file not found: ${videoPath}`);
    }
    if (path.extname(videoPath).toLowerCase() !== '.mp4') {
      throw new Error(`Facebook Page publishing expects an .mp4 file, got: ${videoPath}`);
    }
    const pageToken = await this.pageAccessToken();
    if (stats.size < SINGLE_SHOT_MAX_BYTES) {
      return this.publishSingleShot({ videoPath, title, description, published, pageToken });
    }
    return this.publishResumable({ videoPath, fileSize: stats.size, title, description, published, pageToken });
  }

  async publishSingleShot({ videoPath, title, description, published, pageToken }) {
    this.logger.info(`Uploading ${path.basename(videoPath)} to Facebook Page ${this.config.pageId} (single request)`);
    const form = new FormData();
    form.append('source', fsSync.createReadStream(videoPath));
    if (title) form.append('title', title);
    if (description) form.append('description', description);
    form.append('published', String(published));
    form.append('access_token', pageToken);
    try {
      const response = await axios.post(
        `${GRAPH_HOST}/${this.config.graphVersion}/${this.config.pageId}/videos`,
        form,
        { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 300000 }
      );
      this.logger.success(`Facebook video published: ${response.data.id}`);
      return { videoId: response.data.id, upload: 'single' };
    } catch (error) {
      const graphError = error.response?.data?.error;
      throw new Error(`Facebook single-shot upload failed: ${graphError?.message || error.message}`);
    }
  }

  async publishResumable({ videoPath, fileSize, title, description, published, pageToken }) {
    const edge = `${this.config.pageId}/videos`;
    this.logger.info(`Starting resumable upload of ${path.basename(videoPath)} (${fileSize} bytes) to Facebook Page ${this.config.pageId}`);

    const start = await graphPostForm(this.config, edge, pageToken, {
      upload_phase: 'start',
      file_size: fileSize
    }, GRAPH_VIDEO_HOST);
    const sessionId = start.upload_session_id;
    const videoId = start.video_id;
    if (!sessionId || !videoId) {
      throw new Error(`Facebook did not return an upload session: ${JSON.stringify(start)}`);
    }

    let startOffset = Number(start.start_offset);
    let endOffset = Number(start.end_offset);
    const handle = await fs.open(videoPath, 'r');
    try {
      while (startOffset < fileSize) {
        if (!(endOffset > startOffset)) {
          throw new Error(`Facebook upload session stalled at offset ${startOffset} of ${fileSize}`);
        }
        const chunk = Buffer.alloc(endOffset - startOffset);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, startOffset);
        const form = new FormData();
        form.append('upload_phase', 'transfer');
        form.append('upload_session_id', sessionId);
        form.append('start_offset', String(startOffset));
        form.append('video_file_chunk', chunk.subarray(0, bytesRead), { filename: path.basename(videoPath) });
        form.append('access_token', pageToken);
        let data;
        try {
          const response = await axios.post(
            `${GRAPH_VIDEO_HOST}/${this.config.graphVersion}/${edge}`,
            form,
            { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 300000 }
          );
          data = response.data;
        } catch (error) {
          const graphError = error.response?.data?.error;
          throw new Error(
            `Facebook chunk transfer failed at offset ${startOffset}: ${graphError?.message || error.message}`
          );
        }
        startOffset = Number(data.start_offset);
        endOffset = Number(data.end_offset);
        this.logger.info(`Facebook upload progress: ${startOffset}/${fileSize} bytes`);
      }
    } finally {
      await handle.close();
    }

    const finish = await graphPostForm(this.config, edge, pageToken, {
      upload_phase: 'finish',
      upload_session_id: sessionId,
      title,
      description,
      published
    }, GRAPH_VIDEO_HOST);
    if (finish.success !== true) {
      throw new Error(`Facebook finish phase did not confirm success: ${JSON.stringify(finish)}`);
    }
    this.logger.success(`Facebook video published: ${videoId}`);
    return { videoId, upload: 'resumable' };
  }
}

module.exports = { FacebookPublisher, SINGLE_SHOT_MAX_BYTES };
