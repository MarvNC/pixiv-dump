import { test, expect } from 'bun:test';
import { CloudflareError } from '../fetch/errors';
import { throwIfChallengeBody } from '../fetch/solveCloudflare';

test('persistent browser challenge bodies are CloudflareError instances', () => {
  expect(() =>
    throwIfChallengeBody(
      'https://dic.pixiv.net/_api/get_article/example',
      '<html><title>Just a moment...</title><script src="/challenge-platform"></script></html>',
    ),
  ).toThrow(CloudflareError);
});

test('normal browser responses are not classified as Cloudflare challenges', () => {
  expect(() =>
    throwIfChallengeBody(
      'https://dic.pixiv.net/_api/get_article/example',
      '<html><title>Pixiv百科事典</title><p>content</p></html>',
    ),
  ).not.toThrow();
});
