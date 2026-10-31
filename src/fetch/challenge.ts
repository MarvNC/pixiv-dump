export type ChallengeEvidence = 'header' | 'title' | 'body';

export type ChallengeResponse = {
  status: number;
  text: string;
  contentType: string;
  cfMitigated?: string | null;
};

// Cloudflare documents cf-mitigated: challenge as the authoritative signal:
// https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/
// JavaScript Detections also injects challenge-platform scripts into ordinary
// HTML, so a script reference alone must not reject a successful response:
// https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/
export function challengeEvidence({
  status,
  text,
  contentType,
  cfMitigated,
}: ChallengeResponse): ChallengeEvidence | null {
  if (cfMitigated?.trim().toLowerCase() === 'challenge') return 'header';

  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const document = text.trimStart();
  // Do not inspect article JSON, plain text, or escaped examples as HTML. An
  // absent content type may be recovered only from an HTML document prefix.
  const htmlPrefix = /^(?:<!doctype\s+html\b|<html\b|<head\b|<title\b)/i;
  if (
    (mime !== 'text/html' && mime !== 'application/xhtml+xml' && mime !== '') ||
    !htmlPrefix.test(document)
  )
    return null;

  // Only the document head's title is evidence, not a quoted article example
  // in its body, a comment, or a JavaScript string.
  const head = document
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .split(/<body\b/i, 1)[0];
  const title = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(head)?.[1].trim();
  if (
    title &&
    /^(?:just a moment\s*(?:\.{1,3}|…)?|しばらくお待ちください\s*(?:\.{1,3}|…)?|attention required\s*!?(?:\s*\|\s*cloudflare)?|access denied|you have been blocked)$/i.test(
      title,
    )
  )
    return 'title';
  if (status >= 400 && /challenge-platform/i.test(document)) return 'body';
  return null;
}
