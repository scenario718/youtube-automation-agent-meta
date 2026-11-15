const axios = require('axios');
const FormData = require('form-data');
const { Logger } = require('./logger');

// Thin wrapper over the Meta Graph API used by the Meta publishers and the
// auth helper. Two hosts matter:
//   - graph.facebook.com        — most calls, including IG container flow
//   - graph-video.facebook.com  — Facebook Page chunked (resumable) uploads
//
// Meta errors are normalized into Error objects carrying the Graph error
// message/code/subcode so callers can log one useful line. Access tokens are
// passed per call and are never stored or logged here.

const GRAPH_HOST = 'https://graph.facebook.com';
const GRAPH_VIDEO_HOST = 'https://graph-video.facebook.com';

const logger = new Logger('MetaGraph');

function metaError(error, context) {
  const graphError = error.response?.data?.error;
  if (graphError) {
    const wrapped = new Error(
      `${context} failed: ${graphError.message} ` +
      `(code ${graphError.code}${graphError.error_subcode ? `, subcode ${graphError.error_subcode}` : ''})`
    );
    wrapped.code = graphError.code;
    wrapped.subcode = graphError.error_subcode;
    wrapped.fbtraceId = graphError.fbtrace_id;
    return wrapped;
  }
  const wrapped = new Error(`${context} failed: ${error.message}`);
  wrapped.cause = error;
  return wrapped;
}

function versionedUrl(host, version, edge) {
  const cleanEdge = String(edge).replace(/^\/+/, '');
  return `${host}/${version}/${cleanEdge}`;
}

async function graphGet(config, edge, accessToken, params = {}) {
  try {
    const response = await axios.get(versionedUrl(GRAPH_HOST, config.graphVersion, edge), {
      params: { ...params, access_token: accessToken },
      timeout: 60000
    });
    return response.data;
  } catch (error) {
    throw metaError(error, `GET /${edge}`);
  }
}

async function graphPostForm(config, edge, accessToken, fields = {}, host = GRAPH_HOST) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'boolean' ? String(value) : value);
  }
  form.append('access_token', accessToken);
  try {
    const response = await axios.post(versionedUrl(host, config.graphVersion, edge), form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000
    });
    return response.data;
  } catch (error) {
    throw metaError(error, `POST /${edge}`);
  }
}

// Fetches the access token for the configured Page. An explicit
// META_PAGE_ACCESS_TOKEN wins; otherwise the token is derived from
// /me/accounts with the long-lived user token (Page tokens obtained this way
// stay valid while the user token does).
async function resolvePageAccessToken(config) {
  if (config.pageAccessToken) return config.pageAccessToken;
  const data = await graphGet(config, 'me/accounts', config.userAccessToken, {
    fields: 'id,name,access_token'
  });
  const page = (data.data || []).find(entry => String(entry.id) === String(config.pageId));
  if (!page?.access_token) {
    throw new Error(
      `Page ${config.pageId} was not returned by /me/accounts for this user token. ` +
      'Check META_PAGE_ID, and that the user token has pages_manage_posts and admin access to the Page.'
    );
  }
  return page.access_token;
}

// Lists the Pages the user token can manage, with the Instagram professional
// account linked to each Page (if any). Page tokens in the result are real
// secrets — callers must mask them before printing.
async function listPagesWithInstagram(config) {
  const data = await graphGet(config, 'me/accounts', config.userAccessToken, {
    fields: 'id,name,access_token,instagram_business_account{id,username}'
  });
  return data.data || [];
}

// Discovers the Instagram professional (Business/Creator) user id linked to
// the configured Page. Falls back to META_IG_USER_ID when the owner pinned it.
async function resolveIgUserId(config, pageAccessToken) {
  if (config.igUserId) return config.igUserId;
  const data = await graphGet(config, String(config.pageId), pageAccessToken, {
    fields: 'instagram_business_account{id,username}'
  });
  const igAccount = data.instagram_business_account;
  if (!igAccount?.id) {
    throw new Error(
      `Page ${config.pageId} has no linked Instagram professional account. ` +
      'Link the IG Business/Creator account to the Page (Page Settings → Linked Accounts), ' +
      'or set META_IG_USER_ID explicitly.'
    );
  }
  logger.info(`Discovered Instagram account @${igAccount.username || '?'} (${igAccount.id}) for Page ${config.pageId}`);
  return igAccount.id;
}

module.exports = {
  GRAPH_HOST,
  GRAPH_VIDEO_HOST,
  graphGet,
  graphPostForm,
  resolvePageAccessToken,
  listPagesWithInstagram,
  resolveIgUserId
};
