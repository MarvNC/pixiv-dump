import { expect, test } from 'bun:test';
import { challengeEvidence } from '../fetch/challenge';

const challenge = '<html><head><title>Just a moment...</title></head></html>';

test('the explicit mitigation header is authoritative for every response type', () => {
  for (const contentType of [
    'application/json',
    'text/plain',
    'text/html',
    '',
  ]) {
    expect(
      challengeEvidence({
        status: 200,
        text: '{}',
        contentType,
        cfMitigated: ' challenge ',
      }),
    ).toBe('header');
  }
});

test('detects actual HTML interstitial titles even with status 200', () => {
  for (const title of [
    'Just a moment...',
    'しばらくお待ちください...',
    'Attention Required! | Cloudflare',
    'Access Denied',
    'You have been blocked',
  ]) {
    expect(
      challengeEvidence({
        status: 200,
        text: challenge.replace('Just a moment...', title),
        contentType: 'Text/HTML; charset=utf-8',
      }),
    ).toBe('title');
  }
});

test('recovers a missing content type only for an HTML document', () => {
  expect(
    challengeEvidence({ status: 403, text: challenge, contentType: '' }),
  ).toBe('title');
});

test('detects error HTML with a challenge script but no standard title', () => {
  expect(
    challengeEvidence({
      status: 403,
      text: '<!doctype html><html><script src="/cdn-cgi/challenge-platform/x"></script></html>',
      contentType: 'text/html',
    }),
  ).toBe('body');
});

test('ordinary successful HTML with JavaScript Detections is not a challenge', () => {
  expect(
    challengeEvidence({
      status: 200,
      text: '<html><title>Pixiv</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js"></script></html>',
      contentType: 'text/html',
    }),
  ).toBeNull();
});

test('article JSON and plain text containing challenge markers are not HTML', () => {
  for (const contentType of [
    'application/json',
    'application/problem+json',
    'text/plain',
    '',
  ]) {
    expect(
      challengeEvidence({
        status: 403,
        text: JSON.stringify({ article: `${challenge} challenge-platform` }),
        contentType,
      }),
    ).toBeNull();
  }
  expect(
    challengeEvidence({
      status: 200,
      text: challenge,
      contentType: 'text/plain',
    }),
  ).toBeNull();
});

test('quoted titles in comments, scripts, and body content are not head titles', () => {
  for (const example of [
    '<!-- <title>Just a moment...</title> -->',
    '<script>const example = "<title>Just a moment...</title>";</script>',
    '<body><pre><title>Just a moment...</title></pre></body>',
  ]) {
    expect(
      challengeEvidence({
        status: 200,
        text: `<html>${example}</html>`,
        contentType: 'text/html',
      }),
    ).toBeNull();
  }
});

test('ordinary error pages and unknown mitigation values are not challenges', () => {
  expect(
    challengeEvidence({
      status: 404,
      text: '<html><title>Not found</title></html>',
      contentType: 'text/html',
      cfMitigated: 'other',
    }),
  ).toBeNull();
});
