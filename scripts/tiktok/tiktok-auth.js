require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { URLSearchParams } = require('url');
const { Logger } = require('../../utils/logger');
const { loadTikTokConfig, maskToken } = require('../../utils/tiktok-config');
const { oauthTokenRequest } = require('../../utils/tiktok-api');

// TikTok OAuth helper (Login Kit + Content Posting API scopes).
//
//   node scripts/tiktok/tiktok-auth.js url
//       Print the TikTok authorization URL to open in a browser.
//
//   node scripts/tiktok/tiktok-auth.js exchange <code> [--write-env]
//       Exchange the code from the redirect URL for an access token
//       (~24 h) plus a refresh token (~365 days) and the creator open_id.
//       Tokens are only ever printed masked; --write-env stores them in
//       .env (mode 0600) instead.
//
//   node scripts/tiktok/tiktok-auth.js refresh [--write-env]
//       Trade TIKTOK_REFRESH_TOKEN for a fresh access token before the old
//       one expires. --write-env stores the rotated tokens in .env.
//
// Full walkthrough: docs/tiktok-publishing.md

const logger = new Logger('TikTokAuth');

const OAUTH_SCOPES = [
  'user.info.basic',
  'video.publish',
  'video.upload'
];

function buildAuthorizeUrl(config) {
  const params = new URLSearchParams({
    client_key: config.clientKey,
    scope: OAUTH_SCOPES.join(','),
    response_type: 'code',
    redirect_uri: config.redirectUri,
    state: crypto.randomBytes(8).toString('hex')
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
}

// Sets KEY=value lines in .env (created from .env.example when missing),
// preserving everything else. Written owner-only (0600), like the
// credential manager's private files.
async function writeEnvValues(values) {
  const envPath = path.join(__dirname, '..', '..', '.env');
  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch (_error) {
    contents = await fs.readFile(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  }
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    contents = pattern.test(contents) ? contents.replace(pattern, line) : `${contents.replace(/\s*$/, '')}\n${line}\n`;
  }
  await fs.writeFile(envPath, contents, { mode: 0o600 });
  await fs.chmod(envPath, 0o600).catch(() => {});
  return envPath;
}

function parseFlags(args) {
  const flags = { writeEnv: false };
  const positional = [];
  for (const arg of args) {
    if (arg === '--write-env') flags.writeEnv = true;
    else positional.push(arg);
  }
  return { flags, positional };
}

function describeTokenGrant(grant, label) {
  const accessDays = grant.expires_in ? Math.round((grant.expires_in / 3600) * 10) / 10 : null;
  const refreshDays = grant.refresh_expires_in ? Math.round(grant.refresh_expires_in / 86400) : null;
  console.log(`\n${label}:`);
  console.log(`  Access token : ${maskToken(grant.access_token)}${accessDays ? ` (expires in ~${accessDays} h)` : ''}`);
  console.log(`  Refresh token: ${maskToken(grant.refresh_token)}${refreshDays ? ` (expires in ~${refreshDays} days)` : ''}`);
  console.log(`  Open ID      : ${grant.open_id || '(not returned)'}`);
  console.log(`  Scopes       : ${grant.scope || OAUTH_SCOPES.join(',')}`);
}

async function storeGrant(grant) {
  const values = {};
  if (grant.access_token) values.TIKTOK_ACCESS_TOKEN = grant.access_token;
  if (grant.refresh_token) values.TIKTOK_REFRESH_TOKEN = grant.refresh_token;
  if (grant.open_id) values.TIKTOK_OPEN_ID = grant.open_id;
  const envPath = await writeEnvValues(values);
  console.log(`Stored ${Object.keys(values).join(', ')} in ${envPath}`);
}

async function commandUrl(config) {
  if (!config.clientKey) {
    throw new Error('TIKTOK_CLIENT_KEY is not set. Create the app first (docs/tiktok-publishing.md, step 1), then fill .env.');
  }
  console.log('\nOpen this URL in a browser where you are logged in to the TikTok creator account:\n');
  console.log(buildAuthorizeUrl(config));
  console.log(`\nRedirect URI (must be registered exactly in the TikTok app's Login Kit settings): ${config.redirectUri}`);
  console.log('After approving, the browser lands on the redirect URI with ?code=... in the address bar.');
  console.log('Copy that code and run:  node scripts/tiktok/tiktok-auth.js exchange <code> --write-env\n');
}

async function commandExchange(config, code, writeEnv) {
  if (!code) throw new Error('Usage: node scripts/tiktok/tiktok-auth.js exchange <code> [--write-env]');
  if (!config.clientKey || !config.clientSecret) {
    throw new Error('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set in .env before exchanging a code.');
  }
  const grant = await oauthTokenRequest(config, {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri
  });
  if (!grant.access_token) {
    throw new Error(`TikTok did not return an access token: ${JSON.stringify(grant)}`);
  }
  describeTokenGrant(grant, 'Token grant received');
  if (writeEnv) {
    await storeGrant(grant);
  } else {
    console.log('Put the tokens in .env as TIKTOK_ACCESS_TOKEN / TIKTOK_REFRESH_TOKEN / TIKTOK_OPEN_ID (re-run with --write-env to store them automatically).');
  }
  console.log('Access tokens live ~24 h — refresh with: node scripts/tiktok/tiktok-auth.js refresh --write-env\n');
}

async function commandRefresh(config, writeEnv) {
  if (!config.clientKey || !config.clientSecret) {
    throw new Error('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set in .env before refreshing.');
  }
  if (!config.refreshToken) {
    throw new Error('TIKTOK_REFRESH_TOKEN is not set. Run the url + exchange steps first.');
  }
  const grant = await oauthTokenRequest(config, {
    client_key: config.clientKey,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken
  });
  if (!grant.access_token) {
    throw new Error(`TikTok did not return an access token: ${JSON.stringify(grant)}`);
  }
  describeTokenGrant(grant, 'Refreshed token grant');
  if (writeEnv) {
    await storeGrant(grant);
  } else {
    console.log('Put the new tokens in .env (re-run with --write-env to store them automatically). TikTok rotates refresh tokens — always store the new one.');
  }
  console.log('');
}

async function main() {
  const config = loadTikTokConfig();
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const [command = 'url', arg] = positional;
  if (command === 'url') await commandUrl(config);
  else if (command === 'exchange') await commandExchange(config, arg, flags.writeEnv);
  else if (command === 'refresh') await commandRefresh(config, flags.writeEnv);
  else throw new Error(`Unknown command "${command}". Use: url | exchange <code> | refresh`);
}

if (require.main === module) {
  main().catch(error => {
    logger.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildAuthorizeUrl, OAUTH_SCOPES };
