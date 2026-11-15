const axios = require('axios');
const { URLSearchParams } = require('url');
const { Logger } = require('./logger');

// Thin wrapper over the TikTok API for Business / Content Posting API
// (open.tiktokapis.com). All publish calls are JSON POSTs with a Bearer
// access token; the OAuth token endpoint is the one form-urlencoded call.
//
// TikTok errors are normalized into Error objects carrying the API error
// code/message/log_id so callers can log one useful line. Note that TikTok
// often answers HTTP 200 with a non-"ok" error.code in the body, so every
// response is checked, not just HTTP failures. Access tokens are passed via
// the config object and are never stored or logged here.

const logger = new Logger('TikTokApi');

function tiktokError(error, context) {
  if (error.tiktokNormalized) return error;
  const apiError = error.response?.data?.error;
  if (apiError && typeof apiError === 'object') {
    const wrapped = new Error(
      `${context} failed: ${apiError.message || 'TikTok API error'} ` +
      `(code ${apiError.code || 'unknown'}${apiError.log_id ? `, log_id ${apiError.log_id}` : ''})`
    );
    wrapped.code = apiError.code;
    wrapped.logId = apiError.log_id;
    wrapped.tiktokNormalized = true;
    return wrapped;
  }
  if (error.response?.data?.error) {
    // OAuth-style error: a plain string code plus error_description.
    const wrapped = new Error(
      `${context} failed: ${error.response.data.error_description || error.response.data.error}`
    );
    wrapped.code = error.response.data.error;
    wrapped.tiktokNormalized = true;
    return wrapped;
  }
  const wrapped = new Error(`${context} failed: ${error.message}`);
  wrapped.cause = error;
  wrapped.tiktokNormalized = true;
  return wrapped;
}

// Throws when a 200-response body still carries a TikTok error, and returns
// the `data` payload otherwise.
function unwrapData(data, context) {
  const apiError = data?.error;
  if (apiError && typeof apiError === 'object' && apiError.code && apiError.code !== 'ok') {
    const wrapped = new Error(
      `${context} failed: ${apiError.message || 'TikTok API error'} ` +
      `(code ${apiError.code}${apiError.log_id ? `, log_id ${apiError.log_id}` : ''})`
    );
    wrapped.code = apiError.code;
    wrapped.logId = apiError.log_id;
    wrapped.tiktokNormalized = true;
    throw wrapped;
  }
  if (typeof apiError === 'string' && apiError) {
    const wrapped = new Error(`${context} failed: ${data.error_description || apiError}`);
    wrapped.code = apiError;
    wrapped.tiktokNormalized = true;
    throw wrapped;
  }
  return data?.data ?? data;
}

function apiUrl(config, edge) {
  const cleanEdge = String(edge).replace(/^\/+/, '');
  return `${config.apiBase}/${cleanEdge}`;
}

// Authenticated JSON POST against the Content Posting API.
async function apiPost(config, edge, body = {}) {
  const context = `POST /${String(edge).replace(/^\/+/, '')}`;
  try {
    const response = await axios.post(apiUrl(config, edge), body, {
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      timeout: 60000
    });
    return unwrapData(response.data, context);
  } catch (error) {
    throw tiktokError(error, context);
  }
}

// POST /post/publish/creator_info/query/ — the creator's nickname, the
// privacy levels this app may use for them, and which interactions
// (comment/duet/stitch) are disabled on their account. TikTok expects this
// to be checked before every publish.
async function queryCreatorInfo(config) {
  const data = await apiPost(config, 'post/publish/creator_info/query/', {});
  logger.info(`TikTok creator: ${data.creator_nickname || data.creator_username || '(unknown)'} — privacy options: ${(data.privacy_level_options || []).join(', ') || 'not reported'}`);
  return data;
}

// POST /post/publish/video/init/ — opens an upload/publish session and
// returns { publish_id, upload_url } (upload_url only for FILE_UPLOAD).
async function initVideoPublish(config, body) {
  return apiPost(config, 'post/publish/video/init/', body);
}

// POST /post/publish/status/fetch/ — { status, fail_reason, ... } for a
// publish_id. Statuses: PROCESSING_UPLOAD / PROCESSING_DOWNLOAD /
// SEND_TO_USER_INBOX / PUBLISH_COMPLETE / FAILED.
async function fetchPublishStatus(config, publishId) {
  return apiPost(config, 'post/publish/status/fetch/', { publish_id: publishId });
}

// POST /oauth/token/ — the one form-urlencoded endpoint. Used by
// scripts/tiktok/tiktok-auth.js for grant_type=authorization_code and
// grant_type=refresh_token. Returns the raw token payload (access_token,
// refresh_token, open_id, expires_in, refresh_expires_in, scope).
async function oauthTokenRequest(config, fields) {
  const context = 'POST /oauth/token/';
  try {
    const response = await axios.post(apiUrl(config, 'oauth/token/'), new URLSearchParams(fields), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 60000
    });
    return unwrapData(response.data, context);
  } catch (error) {
    throw tiktokError(error, context);
  }
}

module.exports = {
  apiPost,
  queryCreatorInfo,
  initVideoPublish,
  fetchPublishStatus,
  oauthTokenRequest
};
