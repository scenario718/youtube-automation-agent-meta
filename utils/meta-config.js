const path = require('path');

// Meta (Facebook Page + Instagram) publishing configuration.
//
// Everything is read from the environment (see the "Meta Publishing" section
// of .env.example). Access tokens are owner secrets: they are only ever read
// here, never hardcoded, and must never be printed in full — use maskToken()
// for any diagnostic output.

const DEFAULT_GRAPH_VERSION = 'v24.0';

// Variables that must be present before any Meta publishing can work.
// META_PAGE_ACCESS_TOKEN and META_IG_USER_ID are intentionally optional:
// the page token is fetched from /me/accounts with the user token, and the
// IG user id is discovered from the Page, unless the owner pins them here.
const REQUIRED_META_ENV = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_USER_ACCESS_TOKEN',
  'META_PAGE_ID'
];

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function loadMetaConfig() {
  return {
    appId: envValue('META_APP_ID'),
    appSecret: envValue('META_APP_SECRET'),
    userAccessToken: envValue('META_USER_ACCESS_TOKEN'),
    pageId: envValue('META_PAGE_ID'),
    pageAccessToken: envValue('META_PAGE_ACCESS_TOKEN'),
    igUserId: envValue('META_IG_USER_ID'),
    publicMediaBaseUrl: envValue('META_PUBLIC_MEDIA_BASE_URL'),
    graphVersion: envValue('META_GRAPH_VERSION') || DEFAULT_GRAPH_VERSION,
    redirectUri: envValue('META_REDIRECT_URI') || 'http://127.0.0.1:3456/meta/callback',
    // Local directory copied files are served from for Instagram's
    // public-URL flow (see scripts/meta/serve-media.js).
    mediaDir: envValue('META_MEDIA_DIR') || path.join(__dirname, '..', 'data', 'meta-media'),
    pollIntervalMs: Number(process.env.META_IG_POLL_INTERVAL_MS || 15000),
    pollTimeoutMs: Number(process.env.META_IG_POLL_TIMEOUT_MS || 5 * 60 * 1000)
  };
}

// Returns the names of required variables that are missing/empty, so callers
// can fail with one clear list instead of a chain of API errors.
function missingMetaConfig(config = loadMetaConfig()) {
  const byEnvName = {
    META_APP_ID: config.appId,
    META_APP_SECRET: config.appSecret,
    META_USER_ACCESS_TOKEN: config.userAccessToken,
    META_PAGE_ID: config.pageId
  };
  return REQUIRED_META_ENV.filter(name => !byEnvName[name]);
}

function assertMetaConfig(config = loadMetaConfig()) {
  const missing = missingMetaConfig(config);
  if (missing.length) {
    throw new Error(
      `Meta publishing is not configured. Missing ${missing.join(', ')}. ` +
      'Copy .env.example to .env, then follow docs/meta-publishing.md.'
    );
  }
  return config;
}

// Masks a secret for display: only the last 4 characters survive.
function maskToken(token) {
  if (!token) return '(not set)';
  const text = String(token);
  if (text.length <= 4) return '••••';
  return `••••${text.slice(-4)}`;
}

module.exports = {
  DEFAULT_GRAPH_VERSION,
  REQUIRED_META_ENV,
  loadMetaConfig,
  missingMetaConfig,
  assertMetaConfig,
  maskToken
};
