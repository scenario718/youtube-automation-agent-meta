require('dotenv').config();

const fs = require('fs');
const { Logger } = require('../../utils/logger');
const { loadTikTokConfig, missingTikTokConfig, maskToken, PRIVACY_LEVELS } = require('../../utils/tiktok-config');
const { TikTokPublisher, planChunks } = require('../../utils/tiktok-publisher');

// Explicit-invocation TikTok publisher — NOT part of the scheduler or the
// approval queue. A human (or an approved pipeline step) runs this per
// video, mirroring the app's approval-first philosophy.
//
//   node scripts/tiktok/publish.js --file video.mp4 --title "caption" \
//     [--privacy SELF_ONLY|PUBLIC_TO_EVERYONE] [--dry-run]
//   node scripts/tiktok/publish.js --pull-url https://host/video.mp4 \
//     --title "caption" [--privacy …] [--dry-run]
//
// --file uses FILE_UPLOAD (local file, chunked). --pull-url uses
// PULL_FROM_URL (TikTok fetches it; the domain must be verified in the app).
//
// --dry-run validates configuration and prints the exact request plan
// (init body, chunk plan, status polling) without any network call.
// Setup: docs/tiktok-publishing.md

const logger = new Logger('TikTokPublish');

function parseArgs(argv) {
  const args = { file: null, pullUrl: null, title: '', privacy: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--file': args.file = argv[++i]; break;
      case '--pull-url': args.pullUrl = argv[++i]; break;
      case '--title': args.title = argv[++i] || ''; break;
      case '--privacy': args.privacy = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (Boolean(args.file) === Boolean(args.pullUrl)) {
    throw new Error('Pass exactly one of --file <video.mp4> (FILE_UPLOAD) or --pull-url <https-url> (PULL_FROM_URL)');
  }
  if (!args.title) throw new Error('--title "caption text" is required');
  if (args.privacy && !PRIVACY_LEVELS.includes(args.privacy)) {
    throw new Error(`--privacy must be one of: ${PRIVACY_LEVELS.join(', ')}`);
  }
  return args;
}

// Mirrors the guardrail in TikTokPublisher.resolvePrivacyLevel so the dry
// run can report it without constructing a publisher (which asserts config).
function privacyProblem(config, args) {
  const level = args.privacy || config.privacyLevel || 'SELF_ONLY';
  if (level === 'PUBLIC_TO_EVERYONE' && !config.allowPublic) {
    return 'PUBLIC_TO_EVERYONE requested but TIKTOK_ALLOW_PUBLIC is not "true" — public posting needs an audited TikTok app (see docs/tiktok-publishing.md)';
  }
  return null;
}

function printDryRunPlan(config, args, missing) {
  const problems = [...missing.map(name => `missing ${name}`)];
  const privacyIssue = privacyProblem(config, args);
  if (privacyIssue) problems.push(privacyIssue);
  const privacyLevel = args.privacy || config.privacyLevel || 'SELF_ONLY';
  const postInfo = {
    title: args.title,
    privacy_level: privacyLevel,
    disable_comment: false,
    disable_duet: false,
    disable_stitch: false,
    video_cover_timestamp_ms: 0
  };

  console.log('\n=== TikTok publish plan (dry run — no network calls) ===');
  console.log(`API base          : ${config.apiBase}`);
  console.log(`Title             : "${args.title.slice(0, 80)}"`);
  console.log(`Privacy level     : ${privacyLevel}${privacyLevel === 'SELF_ONLY' ? ' (private — the only level an unaudited app can use)' : ''}`);
  console.log(`Access token      : ${maskToken(config.accessToken)}`);
  console.log(`Open ID           : ${config.openId || '(not set — informational only)'}`);
  console.log(`POST ${config.apiBase}/post/publish/creator_info/query/  (checked first at publish time; requested privacy must be in privacy_level_options)`);

  if (args.pullUrl) {
    const body = { post_info: postInfo, source_info: { source: 'PULL_FROM_URL', video_url: args.pullUrl } };
    console.log('\nSource: PULL_FROM_URL');
    console.log(`  Video URL         : ${args.pullUrl}`);
    console.log('  NOTE              : the URL domain must be verified in the TikTok app (URL properties), or TikTok refuses the download.');
    console.log(`  POST ${config.apiBase}/post/publish/video/init/  body:`);
    console.log(JSON.stringify(body, null, 2).split('\n').map(line => `    ${line}`).join('\n'));
  } else {
    const stats = fs.statSync(args.file, { throwIfNoEntry: false });
    if (!stats?.isFile()) {
      throw new Error(`Video file not found: ${args.file}`);
    }
    const plan = planChunks(stats.size);
    const body = {
      post_info: postInfo,
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: stats.size,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount
      }
    };
    console.log('\nSource: FILE_UPLOAD');
    console.log(`  File              : ${args.file} (${stats.size} bytes)`);
    console.log(`  POST ${config.apiBase}/post/publish/video/init/  body:`);
    console.log(JSON.stringify(body, null, 2).split('\n').map(line => `    ${line}`).join('\n'));
    console.log('  Then PUT each chunk to the returned upload_url:');
    for (const chunk of plan.chunks) {
      console.log(`    chunk ${chunk.index + 1}/${plan.totalChunkCount}: ${chunk.size} bytes, Content-Range: ${chunk.contentRange}`);
    }
  }

  console.log(`  POST ${config.apiBase}/post/publish/status/fetch/  { publish_id } — poll every ${Math.round(config.pollIntervalMs / 1000)}s until PUBLISH_COMPLETE or FAILED`);

  if (problems.length) {
    console.log(`\nCONFIG INCOMPLETE — ${problems.join('; ')}`);
    console.log('Fill .env per docs/tiktok-publishing.md before a real publish.');
    return false;
  }
  console.log('\nConfiguration looks complete. Re-run without --dry-run to publish.');
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadTikTokConfig();
  const missing = missingTikTokConfig(config);

  if (args.dryRun) {
    const complete = printDryRunPlan(config, args, missing);
    if (!complete) process.exit(1);
    return;
  }
  if (missing.length) {
    throw new Error(`TikTok publishing is not configured. Missing ${missing.join(', ')}. See docs/tiktok-publishing.md.`);
  }

  const publisher = new TikTokPublisher(config);
  const result = args.pullUrl
    ? await publisher.publishVideoFromUrl({ videoUrl: args.pullUrl, title: args.title, privacyLevel: args.privacy })
    : await publisher.publishVideoFile({ videoPath: args.file, title: args.title, privacyLevel: args.privacy });
  console.log(`TikTok: publish id ${result.publishId} — ${result.status} (privacy ${result.privacyLevel}, ${result.upload} upload)`);
  if (result.postIds?.length) console.log(`TikTok: post id(s) ${result.postIds.join(', ')}`);
  logger.success('TikTok publish complete');
}

if (require.main === module) {
  main().catch(error => {
    logger.error(error.message);
    process.exit(1);
  });
}
