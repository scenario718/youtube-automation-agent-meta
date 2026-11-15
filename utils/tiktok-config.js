// TikTok publishing configuration (Content Posting API).
//
// Everything is read from the environment (see the "TikTok Publishing"
// section of .env.example). Client secrets and access/refresh tokens are
// owner secrets: they are only ever read here, never hardcoded, and must
// never be printed in full — use maskToken() for any diagnostic output.

const DEFAULT_API_BASE = 'https://open.tiktokapis.com/v2';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:3456/tiktok/callback';

// Variables that must be present before any TikTok publishing can work.
// TIKTOK_REFRESH_TOKEN and TIKTOK_OPEN_ID are intentionally optional here:
// the refresh token is only needed by `tiktok-auth.js refresh`, and the
// open id is an informational identifier returned by OAuth (the access
// token itself identifies the creator on publish calls).
const REQUIRED_TIKTOK_ENV = [
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'TIKTOK_ACCESS_TOKEN'
];

// Privacy levels accepted by the Content Posting API.
const PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY'
];

function envValue(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function loadTikTokConfig() {
  return {
    clientKey: envValue('TIKTOK_CLIENT_KEY'),
    clientSecret: envValue('TIKTOK_CLIENT_SECRET'),
    accessToken: envValue('TIKTOK_ACCESS_TOKEN'),
    refreshToken: envValue('TIKTOK_REFRESH_TOKEN'),
    openId: envValue('TIKTOK_OPEN_ID'),
    redirectUri: envValue('TIKTOK_REDIRECT_URI') || DEFAULT_REDIRECT_URI,
    apiBase: (envValue('TIKTOK_API_BASE') || DEFAULT_API_BASE).replace(/\/+$/, ''),
    // Default privacy is SELF_ONLY on purpose: an unaudited TikTok app can
    // only post privately (see resolvePrivacyLevel in tiktok-publisher.js
    // and the audit section of docs/tiktok-publishing.md).
    privacyLevel: envValue('TIKTOK_PRIVACY_LEVEL') || 'SELF_ONLY',
    // Public posting requires BOTH this flag and an audited app. It exists
    // so going public is always a deliberate, visible configuration choice.
    allowPublic: envValue('TIKTOK_ALLOW_PUBLIC') === 'true',
    pollIntervalMs: Number(process.env.TIKTOK_STATUS_POLL_INTERVAL_MS || 5000),
    pollTimeoutMs: Number(process.env.TIKTOK_STATUS_POLL_TIMEOUT_MS || 3 * 60 * 1000)
  };
}

// Returns the names of required variables that are missing/empty, so callers
// can fail with one clear list instead of a chain of API errors.
function missingTikTokConfig(config = loadTikTokConfig()) {
  const byEnvName = {
    TIKTOK_CLIENT_KEY: config.clientKey,
    TIKTOK_CLIENT_SECRET: config.clientSecret,
    TIKTOK_ACCESS_TOKEN: config.accessToken
  };
  return REQUIRED_TIKTOK_ENV.filter(name => !byEnvName[name]);
}

function assertTikTokConfig(config = loadTikTokConfig()) {
  const missing = missingTikTokConfig(config);
  if (missing.length) {
    throw new Error(
      `TikTok publishing is not configured. Missing ${missing.join(', ')}. ` +
      'Copy .env.example to .env, then follow docs/tiktok-publishing.md.'
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
  DEFAULT_API_BASE,
  DEFAULT_REDIRECT_URI,
  REQUIRED_TIKTOK_ENV,
  PRIVACY_LEVELS,
  loadTikTokConfig,
  missingTikTokConfig,
  missingRequired: missingTikTokConfig,
  assertTikTokConfig,
  maskToken
};
