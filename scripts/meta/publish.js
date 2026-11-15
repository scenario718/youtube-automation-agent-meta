require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Logger } = require('../../utils/logger');
const { loadMetaConfig, missingMetaConfig, maskToken } = require('../../utils/meta-config');
const { FacebookPublisher, SINGLE_SHOT_MAX_BYTES } = require('../../utils/facebook-publisher');
const { InstagramPublisher } = require('../../utils/instagram-publisher');

// Explicit-invocation Meta publisher — NOT part of the scheduler or the
// approval queue. A human (or an approved pipeline step) runs this per video,
// mirroring the app's approval-first philosophy.
//
//   node scripts/meta/publish.js --target fb|ig|both --file video.mp4 \
//     [--caption "text"] [--title "FB title"] [--unpublished] [--dry-run]
//
// --dry-run validates configuration and prints the exact request plan
// without any network call. Setup: docs/meta-publishing.md

const logger = new Logger('MetaPublish');

function parseArgs(argv) {
  const args = { target: null, file: null, caption: '', title: null, published: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--target': args.target = argv[++i]; break;
      case '--file': args.file = argv[++i]; break;
      case '--caption': args.caption = argv[++i] || ''; break;
      case '--title': args.title = argv[++i]; break;
      case '--unpublished': args.published = false; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!['fb', 'ig', 'both'].includes(args.target || '')) {
    throw new Error('--target must be one of: fb, ig, both');
  }
  if (!args.file) throw new Error('--file <video.mp4> is required');
  return args;
}

function dryRunIgUrl(config, file) {
  if (/^https?:\/\//i.test(file)) return file;
  if (!config.publicMediaBaseUrl) return null;
  return `${config.publicMediaBaseUrl.replace(/\/+$/, '')}/${encodeURIComponent(path.basename(file))}`;
}

function printDryRunPlan(config, args, missing) {
  const isUrl = /^https?:\/\//i.test(args.file);
  const stats = isUrl ? null : fs.statSync(args.file, { throwIfNoEntry: false });
  if (!isUrl && !stats?.isFile()) {
    throw new Error(`Video file not found: ${args.file}`);
  }
  const size = stats?.size ?? null;
  const v = config.graphVersion;

  console.log('\n=== Meta publish plan (dry run — no network calls) ===');
  console.log(`Graph API version : ${v}`);
  console.log(`File              : ${args.file}${size !== null ? ` (${size} bytes)` : ' (remote URL)'}`);
  console.log(`Caption           : ${args.caption ? `"${args.caption.slice(0, 80)}"` : '(none)'}`);
  console.log(`User token        : ${maskToken(config.userAccessToken)}`);
  console.log(`Page token        : ${config.pageAccessToken ? maskToken(config.pageAccessToken) : '(derived from /me/accounts at publish time)'}`);

  if (args.target === 'fb' || args.target === 'both') {
    console.log('\nFacebook Page (target: fb)');
    console.log(`  Page ID           : ${config.pageId || '(missing META_PAGE_ID)'}`);
    if (size !== null && size < SINGLE_SHOT_MAX_BYTES) {
      console.log(`  Route             : single-shot upload (< ${SINGLE_SHOT_MAX_BYTES} bytes)`);
      console.log(`  POST https://graph.facebook.com/${v}/${config.pageId || '<page-id>'}/videos  (multipart: source, title, description, published=${args.published})`);
    } else {
      console.log('  Route             : resumable chunked upload');
      console.log(`  POST https://graph-video.facebook.com/${v}/${config.pageId || '<page-id>'}/videos  upload_phase=start, file_size=${size ?? '<unknown>'}`);
      console.log('  POST  (same edge)  upload_phase=transfer, per-chunk offsets returned by Meta');
      console.log(`  POST  (same edge)  upload_phase=finish, title, description, published=${args.published}`);
    }
  }

  if (args.target === 'ig' || args.target === 'both') {
    const igId = config.igUserId || '(auto-discovered from the Page at publish time)';
    const videoUrl = dryRunIgUrl(config, args.file);
    console.log('\nInstagram Reels (target: ig)');
    console.log(`  IG user ID        : ${igId}`);
    console.log(`  Public video URL  : ${videoUrl || '(cannot be built — META_PUBLIC_MEDIA_BASE_URL is not set and the file is local)'}`);
    if (!isUrl) console.log(`  Media directory   : ${config.mediaDir} (file is copied here; serve it with scripts/meta/serve-media.js)`);
    console.log(`  POST https://graph.facebook.com/${v}/${config.igUserId || '<ig-user-id>'}/media  media_type=REELS, video_url, caption`);
    console.log('  GET  https://graph.facebook.com/' + v + '/<container-id>?fields=status_code  (poll until FINISHED)');
    console.log(`  POST https://graph.facebook.com/${v}/${config.igUserId || '<ig-user-id>'}/media_publish  creation_id=<container-id>`);
  }

  if (missing.length) {
    console.log(`\nCONFIG INCOMPLETE — missing: ${missing.join(', ')}`);
    console.log('Fill .env per docs/meta-publishing.md before a real publish.');
    return false;
  }
  console.log('\nConfiguration looks complete. Re-run without --dry-run to publish.');
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadMetaConfig();
  const missing = missingMetaConfig(config);

  if (args.dryRun) {
    const complete = printDryRunPlan(config, args, missing);
    if (!complete) process.exit(1);
    return;
  }
  if (missing.length) {
    throw new Error(`Meta publishing is not configured. Missing ${missing.join(', ')}. See docs/meta-publishing.md.`);
  }

  const results = {};
  if (args.target === 'fb' || args.target === 'both') {
    const publisher = new FacebookPublisher(config);
    results.facebook = await publisher.publishVideo({
      videoPath: args.file,
      title: args.title || args.caption.split('\n')[0] || '',
      description: args.caption,
      published: args.published
    });
    console.log(`Facebook: video id ${results.facebook.videoId} (${results.facebook.upload} upload)`);
  }
  if (args.target === 'ig' || args.target === 'both') {
    const publisher = new InstagramPublisher(config);
    results.instagram = await publisher.publishReel({ video: args.file, caption: args.caption });
    console.log(`Instagram: media id ${results.instagram.mediaId} (container ${results.instagram.containerId})`);
  }
  logger.success('Meta publish complete');
}

if (require.main === module) {
  main().catch(error => {
    logger.error(error.message);
    process.exit(1);
  });
}
