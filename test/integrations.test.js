import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { sendMail } from '../src/lib/mailer.js';
import { bunnyEmbedUrl, parseBunny, videoSource } from '../src/lib/video.js';
import { imageInfo } from '../src/lib/site-images.js';

after(() => pool.end());

const VIDEO = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

test('Bunny Stream links are parsed strictly and signed with an expiring token', () => {
  assert.deepEqual(parseBunny(`https://iframe.mediadelivery.net/embed/12345/${VIDEO}`), { host: 'iframe.mediadelivery.net', libraryId: '12345', videoId: VIDEO });
  assert.equal(parseBunny(`https://iframe.mediadelivery.net/play/12345/${VIDEO.toUpperCase()}`).videoId, VIDEO);
  for (const bad of [`http://iframe.mediadelivery.net/embed/1/${VIDEO}`, `https://evil.example/embed/1/${VIDEO}`, 'https://iframe.mediadelivery.net/embed/abc/x', 'not a url']) {
    assert.equal(parseBunny(bad), null, bad);
  }
  const now = Date.UTC(2026, 9, 28, 12);
  const signed = new URL(bunnyEmbedUrl(parseBunny(`https://iframe.mediadelivery.net/embed/12345/${VIDEO}`), { key: 'secret-key', now }));
  const expires = Number(signed.searchParams.get('expires'));
  assert.equal(expires, now / 1000 + 6 * 3600);
  assert.equal(signed.searchParams.get('token'), crypto.createHash('sha256').update(`secret-key${VIDEO}${expires}`).digest('hex'));
  const unsigned = new URL(bunnyEmbedUrl(parseBunny(`https://iframe.mediadelivery.net/embed/12345/${VIDEO}`), { key: '' }));
  assert.equal(unsigned.searchParams.get('token'), null);
  assert.equal(videoSource(`https://iframe.mediadelivery.net/embed/12345/${VIDEO}`).kind, 'bunny');
  assert.equal(videoSource('https://cdn.example.com/a.mp4').kind, 'file');
  assert.equal(videoSource('https://youtu.be/abc').kind, 'embed');
});

test('Resend: sends through the API with an idempotency key, retries rate limits, never throws', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let responses = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const [status, body] = responses.shift() ?? [200, { id: 'x' }];
    return new Response(JSON.stringify(body), { status, headers: { 'retry-after': '0' } });
  };
  config.RESEND_API_KEY = 're_test_key';
  try {
    responses = [[429, { name: 'rate_limit_exceeded' }], [200, { id: 'email_1' }]];
    const ok = await sendMail({
      to: 'learner@thehighvaultsecurity.ca', subject: 'Hello', heading: 'Hi', body: ['Body <b>text</b>'],
      details: [['Exam reference', 'HV-E-ABCD-EFGH']], idempotencyKey: 'exam-result/1', category: 'exam-result',
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 2, 'retried after a 429');
    const { url, init } = calls[1];
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.headers.Authorization, 'Bearer re_test_key');
    assert.equal(init.headers['Idempotency-Key'], 'exam-result/1');
    const payload = JSON.parse(init.body);
    assert.deepEqual(payload.to, ['learner@thehighvaultsecurity.ca']);
    assert.deepEqual(payload.tags, [{ name: 'category', value: 'exam-result' }]);
    assert.ok(payload.html.includes('Body &#60;b&#62;text&#60;/b&#62;'), 'content is escaped');
    assert.ok(payload.text.includes('Exam reference: HV-E-ABCD-EFGH'));

    calls.length = 0;
    responses = [[422, { message: 'invalid from' }]];
    assert.equal(await sendMail({ to: 'x@thehighvaultsecurity.ca', subject: 'S', heading: 'H', body: [] }), false, 'errors are reported, not thrown');
    assert.equal(calls.length, 1, 'validation errors are not retried');

    // Reserved example addresses (the sample learners) are never handed to Resend.
    calls.length = 0;
    assert.equal(await sendMail({ to: 'alex.morgan@example.com', subject: 'S', heading: 'H', body: [] }), true);
    assert.equal(calls.length, 0);
  } finally {
    config.RESEND_API_KEY = undefined;
    globalThis.fetch = realFetch;
  }
});

test('image slots read the real type and size from PNG and WebP files', () => {
  const png = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1600, 16);
  png.writeUInt32BE(1067, 20);
  assert.deepEqual(imageInfo(png), { mime: 'image/png', width: 1600, height: 1067 });
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(1199, 24, 3);
  webp.writeUIntLE(1499, 27, 3);
  assert.deepEqual(imageInfo(webp), { mime: 'image/webp', width: 1200, height: 1500 });
  assert.equal(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg> padding padding')), null, 'SVG and other types are refused');
});
