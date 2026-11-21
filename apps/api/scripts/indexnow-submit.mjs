#!/usr/bin/env node
// IndexNow submit helper — manual/ops use.
//
//   node apps/api/scripts/indexnow-submit.mjs <url> [more urls...]
//   node apps/api/scripts/indexnow-submit.mjs --host topspeedserviceos.com https://topspeedserviceos.com/ https://topspeedserviceos.com/book
//
// The Marketing OS publish flow calls services/indexnow.js automatically when
// a landing page is published (routes/marketingOs.js); this script is the
// manual route for one-off submissions (new static pages, llms.txt, etc.).
// Exit code 0 when IndexNow accepted the submission (HTTP 200/202).
import { notifyIndexNow, INDEXNOW_KEY } from '../src/services/indexnow.js';

const args = process.argv.slice(2);
let host = 'topspeedserviceos.com';
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host') host = args[++i];
  else if (args[i] === '--key') process.env.INDEXNOW_KEY_OVERRIDE = args[++i];
  else urls.push(args[i]);
}
if (!urls.length) {
  console.error('Usage: indexnow-submit.mjs [--host <host>] <url> [more urls...]');
  process.exit(2);
}
const result = await notifyIndexNow(urls, { host, key: process.env.INDEXNOW_KEY_OVERRIDE || INDEXNOW_KEY });
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
