require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const { URLSearchParams } = require('url');
const axios = require('axios');
const { Logger } = require('../../utils/logger');
const { loadMetaConfig, maskToken } = require('../../utils/meta-config');
const { GRAPH_HOST, listPagesWithInstagram } = require('../../utils/meta-graph');

// Meta (Facebook + Instagram) OAuth helper.
//
//   node scripts/meta/meta-auth.js url
//       Print the Facebook Login dialog URL to open in a browser.
//
//   node scripts/meta/meta-auth.js exchange <code> [--write-env]
//       Exchange the code from the redirect URL for a short-lived token,
//       then for a long-lived (~60 day) user token. The token is only ever
//       printed masked; --write-env stores it in .env (mode 0600) instead.
//
//   node scripts/meta/meta-auth.js pages [--page-id <id>] [--write-env]
//       List the Pages META_USER_ACCESS_TOKEN can manage, with each Page's
//       linked Instagram professional account. Page tokens print masked.
//       --write-env stores META_PAGE_ID / META_IG_USER_ID for the chosen
//       Page (required when more than one Page exists).
//
// Full walkthrough: docs/meta-publishing.md

const logger = new Logger('MetaAuth');

const OAUTH_SCOPES = [
  'pages_manage_posts',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'public_profile'
];

function buildOAuthUrl(config) {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    scope: OAUTH_SCOPES.join(','),
    response_type: 'code'
  });
  return `https://www.facebook.com/${config.graphVersion}/dialog/oauth?${params.toString()}`;
}

async function oauthTokenRequest(config, params, context) {
  try {
    const response = await axios.get(`${GRAPH_HOST}/${config.graphVersion}/oauth/access_token`, {
      params,
      timeout: 60000
    });
    return response.data;
  } catch (error) {
    const graphError = error.response?.data?.error;
    throw new Error(`${context} failed: ${graphError?.message || error.message}`);
  }
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
  const flags = { writeEnv: false, pageId: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write-env') flags.writeEnv = true;
    else if (args[i] === '--page-id') flags.pageId = args[++i];
    else positional.push(args[i]);
  }
  return { flags, positional };
}

async function commandUrl(config) {
  if (!config.appId) {
    throw new Error('META_APP_ID is not set. Create the app first (docs/meta-publishing.md, step 1), then fill .env.');
  }
  console.log('\nOpen this URL in a browser where you are logged in as the Page admin:\n');
  console.log(buildOAuthUrl(config));
  console.log(`\nRedirect URI (must be registered in the app's Facebook Login settings): ${config.redirectUri}`);
  console.log('After approving, the browser lands on the redirect URI with ?code=... in the address bar.');
  console.log('Copy that code and run:  node scripts/meta/meta-auth.js exchange <code> --write-env\n');
}

async function commandExchange(config, code, writeEnv) {
  if (!code) throw new Error('Usage: node scripts/meta/meta-auth.js exchange <code> [--write-env]');
  if (!config.appId || !config.appSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be set in .env before exchanging a code.');
  }
  const shortLived = await oauthTokenRequest(config, {
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
    code
  }, 'Code exchange');
  const longLived = await oauthTokenRequest(config, {
    grant_type: 'fb_exchange_token',
    client_id: config.appId,
    client_secret: config.appSecret,
    fb_exchange_token: shortLived.access_token
  }, 'Long-lived token exchange');

  console.log(`\nLong-lived user access token: ${maskToken(longLived.access_token)} (expires in ~${Math.round((longLived.expires_in || 0) / 86400)} days)`);
  if (writeEnv) {
    const envPath = await writeEnvValues({ META_USER_ACCESS_TOKEN: longLived.access_token });
    console.log(`Stored as META_USER_ACCESS_TOKEN in ${envPath}`);
  } else {
    console.log('Put it in .env as META_USER_ACCESS_TOKEN (re-run with --write-env to store it automatically).');
  }
  console.log('Next: node scripts/meta/meta-auth.js pages --write-env\n');
}

async function commandPages(config, { writeEnv, pageId }) {
  if (!config.userAccessToken) {
    throw new Error('META_USER_ACCESS_TOKEN is not set. Run the url + exchange steps first.');
  }
  const pages = await listPagesWithInstagram(config);
  if (!pages.length) {
    throw new Error('No Pages were returned for this user token. The token user must admin at least one Facebook Page.');
  }
  console.log('\nPages this token can manage:');
  for (const page of pages) {
    const ig = page.instagram_business_account;
    console.log(`\n  Page: ${page.name} (id ${page.id})`);
    console.log(`    Page access token: ${maskToken(page.access_token)}`);
    console.log(ig?.id
      ? `    Instagram: @${ig.username || '?'} (META_IG_USER_ID=${ig.id})`
      : '    Instagram: none linked — link the IG professional account to this Page first.');
    console.log(`    .env: META_PAGE_ID=${page.id}${ig?.id ? `  META_IG_USER_ID=${ig.id}` : ''}`);
  }

  if (writeEnv) {
    const chosen = pageId ? pages.find(page => String(page.id) === String(pageId)) : (pages.length === 1 ? pages[0] : null);
    if (!chosen) {
      console.log('\nMore than one Page found — re-run with --page-id <id> to choose which one to store.');
      return;
    }
    const values = { META_PAGE_ID: chosen.id };
    if (chosen.instagram_business_account?.id) values.META_IG_USER_ID = chosen.instagram_business_account.id;
    const envPath = await writeEnvValues(values);
    console.log(`\nStored META_PAGE_ID${values.META_IG_USER_ID ? ' and META_IG_USER_ID' : ''} in ${envPath}`);
  }
  console.log('');
}

async function main() {
  const config = loadMetaConfig();
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const [command = 'url', arg] = positional;
  if (command === 'url') await commandUrl(config);
  else if (command === 'exchange') await commandExchange(config, arg, flags.writeEnv);
  else if (command === 'pages') await commandPages(config, flags);
  else throw new Error(`Unknown command "${command}". Use: url | exchange <code> | pages`);
}

if (require.main === module) {
  main().catch(error => {
    logger.error(error.message);
    process.exit(1);
  });
}

module.exports = { buildOAuthUrl, OAUTH_SCOPES };
