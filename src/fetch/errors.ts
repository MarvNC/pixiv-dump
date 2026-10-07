export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class CloudflareError extends Error {
  constructor(
    message = 'Blocked by Cloudflare challenge',
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}
