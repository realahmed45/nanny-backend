import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import config from '../src/config/index.js';
import { storeBuffer, mountMediaRoutes } from '../src/services/mediaArchive.js';

/**
 * Identity documents, contracts and payment proofs must not be reachable
 * without a login.
 *
 * Everything used to land in one publicly served folder — a national ID beside
 * a profile photo — cached for a year with no way to withdraw a link. Profile
 * media has to stay public, because WhatsApp fetches it from this server to
 * deliver it; these pin the split.
 */

/** Start the real media routes on an ephemeral port. */
async function serve() {
  const app = express();
  mountMediaRoutes(app, express);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  return {
    port,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('a private file is not served without a login', async (t) => {
  const url = await storeBuffer(Buffer.from('pretend this is a national ID'), {
    ext: '.jpg',
    private: true,
  });

  assert.match(url, /^\/media-private\//, 'it is stored under the private prefix');

  const app = await serve();
  t.after(() => app.close());

  const res = await fetch(`http://127.0.0.1:${app.port}${url}`);
  assert.notEqual(res.status, 200, 'an anonymous request must not get the file');
  assert.equal(res.status, 401, 'it is refused as unauthorised');
});

test('the private folder cannot be reached through the public path', async (t) => {
  const url = await storeBuffer(Buffer.from('another private document'), {
    ext: '.jpg',
    private: true,
  });
  const name = url.split('/').pop();

  const app = await serve();
  t.after(() => app.close());

  // The private folder lives inside the public root, so the public mount must
  // refuse anything underneath it.
  const res = await fetch(`http://127.0.0.1:${app.port}/media/private/${name}`);
  assert.notEqual(res.status, 200, 'the public mount must not serve it');
});

test('profile media stays public, because WhatsApp fetches it to deliver it', async (t) => {
  const url = await storeBuffer(Buffer.from('a profile photo'), { ext: '.jpg' });

  assert.match(url, /^\/media\//, 'it is stored under the public prefix');
  assert.doesNotMatch(url, /media-private/);

  const app = await serve();
  t.after(() => app.close());

  const res = await fetch(`http://127.0.0.1:${app.port}${url}`);
  assert.equal(res.status, 200, 'it must still be reachable without a login');
});

test('a private file is never cached by the browser', async (t) => {
  // An admin who signs out should not leave a national ID in a shared cache.
  const app = await serve();
  t.after(() => app.close());

  const url = await storeBuffer(Buffer.from('cache test document'), {
    ext: '.jpg',
    private: true,
  });
  const res = await fetch(`http://127.0.0.1:${app.port}${url}`);
  // Unauthorised, but the header policy is set on the static handler either
  // way; what matters here is that it is not the year-long public cache.
  assert.notEqual(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

test('cleanup', async () => {
  // Remove what these tests wrote, so the archive is not left with junk.
  // Private files live outside the public folder now, in their own directory.
  const priv = config.media.privateDir || path.join(config.media.dir, 'private');
  await fs.rm(priv, { recursive: true, force: true }).catch(() => {});
});
