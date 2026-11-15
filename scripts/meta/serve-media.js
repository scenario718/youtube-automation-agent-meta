require('dotenv').config();

const fs = require('fs');
const express = require('express');
const { Logger } = require('../../utils/logger');
const { loadMetaConfig } = require('../../utils/meta-config');

// Serves the Meta media directory over HTTP so Instagram can fetch videos
// from a public URL (the Graph API never accepts direct file uploads for
// Instagram — Meta downloads the file itself).
//
//   node scripts/meta/serve-media.js
//
// This binds to 127.0.0.1 by default: nothing is exposed publicly until YOU
// put a tunnel or reverse proxy in front of it (e.g. a Cloudflare Tunnel or
// `ngrok http 3457`) and set META_PUBLIC_MEDIA_BASE_URL to that public base.
// Files placed in the media directory are world-readable to anyone who has
// the URL while the tunnel is up — only copy in videos you intend to publish,
// and stop the tunnel when you are done.

const logger = new Logger('MetaMediaServer');

function main() {
  const config = loadMetaConfig();
  const port = Number(process.env.META_MEDIA_SERVER_PORT || 3457);
  const host = process.env.META_MEDIA_SERVER_HOST || '127.0.0.1';

  fs.mkdirSync(config.mediaDir, { recursive: true });
  const app = express();
  app.use(express.static(config.mediaDir, { fallthrough: true }));
  app.use((_req, res) => res.status(404).send('not found'));

  app.listen(port, host, () => {
    logger.success(`Serving ${config.mediaDir} at http://${host}:${port}/`);
    console.log('Expose it publicly (tunnel/reverse proxy), then set in .env:');
    console.log(`  META_PUBLIC_MEDIA_BASE_URL=https://<your-public-host>`);
    console.log(`A video copied to the media directory as "clip.mp4" is then fetchable at:`);
    console.log('  https://<your-public-host>/clip.mp4');
  });
}

if (require.main === module) {
  main();
}
