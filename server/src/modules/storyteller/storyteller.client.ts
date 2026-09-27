import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { open, rm, stat } from 'fs/promises';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { ReadableStream as WebReadableStream } from 'stream/web';

import type { StorytellerStage } from '@bookorbit/types';
import { readBoundedText } from '../../common/utils/bounded-response';

const REQUEST_TIMEOUT_MS = 20_000;
/** The last PATCH of an upload returns only after Storyteller has imported the file. */
const UPLOAD_CHUNK_TIMEOUT_MS = 5 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
/**
 * Storyteller runs behind Next.js middleware whose request-body limit is 10 MB
 * (`middlewareClientMaxBodySize`), so a larger PATCH would not arrive whole.
 */
const MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_RETRIES = 3;
const TUS_VERSION = '1.0.0';

export type StorytellerReadaloudStatus = 'QUEUED' | 'PROCESSING' | 'ALIGNED' | 'ERROR' | 'STOPPED';

/** The fields of Storyteller's `GET /api/v2/books/{id}` this integration reads. */
export interface StorytellerBook {
  uuid: string;
  ebook: { missing?: boolean } | null;
  audiobook: { missing?: boolean } | null;
  readaloud: {
    status: StorytellerReadaloudStatus;
    currentStage: StorytellerStage | null;
    stageProgress: number | null;
    queuePosition: number | null;
    missing?: boolean;
  } | null;
}

export interface StorytellerUploadFile {
  absolutePath: string;
  /** The name Storyteller stores it under. */
  filename: string;
  filetype?: string;
  totalAudioFiles?: number;
}

export interface StorytellerClientConfig {
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * `transient` is what decides retry: an unreachable server or a 5xx is retried with backoff, a
 * refusal that will not change on its own fails the job straight away.
 */
export class StorytellerApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'StorytellerApiError';
  }
}

type FetchImpl = typeof fetch;

export class StorytellerClient {
  private token: string | null = null;
  private readonly base: URL;

  constructor(
    private readonly config: StorytellerClientConfig,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {
    this.base = new URL(config.baseUrl);
  }

  async checkHealth(): Promise<void> {
    const response = await this.send('GET', '/api/health', { auth: false });
    if (!response.ok) throw errorForStatus(response.status, 'Storyteller health check failed');
  }

  async login(): Promise<void> {
    const body = new FormData();
    body.set('usernameOrEmail', this.config.username);
    body.set('password', this.config.password);
    const response = await this.send('POST', '/api/v2/token', { auth: false, body });
    if (response.status === 401) throw new StorytellerApiError('Storyteller rejected the username or password', 401, false);
    if (!response.ok) throw errorForStatus(response.status, 'Storyteller sign-in failed');
    const parsed = (await readJson(response)) as { access_token?: unknown };
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new StorytellerApiError('Storyteller sign-in returned no token', response.status, false);
    }
    this.token = parsed.access_token;
  }

  /** Proves the account can read settings, which every other call here needs as well. */
  async getMaxUploadChunkSize(): Promise<number | null> {
    const response = await this.authed('GET', '/api/v2/settings');
    if (!response.ok) throw errorForStatus(response.status, 'Could not read Storyteller settings');
    const settings = (await readJson(response)) as { maxUploadChunkSize?: unknown };
    return typeof settings.maxUploadChunkSize === 'number' && settings.maxUploadChunkSize > 0 ? settings.maxUploadChunkSize : null;
  }

  async getBook(bookUuid: string): Promise<StorytellerBook | null> {
    const response = await this.authed('GET', `/api/v2/books/${encodeURIComponent(bookUuid)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw errorForStatus(response.status, 'Could not read the book from Storyteller');
    return (await readJson(response)) as StorytellerBook;
  }

  async uploadFile(bookUuid: string, file: StorytellerUploadFile, serverChunkSize: number | null): Promise<void> {
    const { size } = await stat(file.absolutePath);
    const chunkSize = Math.min(MAX_UPLOAD_CHUNK_BYTES, serverChunkSize ?? MAX_UPLOAD_CHUNK_BYTES);
    const metadata: Record<string, string> = { bookUuid, filename: file.filename };
    if (file.filetype) metadata['filetype'] = file.filetype;
    if (file.totalAudioFiles !== undefined) metadata['totalAudioFiles'] = String(file.totalAudioFiles);

    const created = await this.authed('POST', '/api/v2/books/upload', {
      headers: { 'Tus-Resumable': TUS_VERSION, 'Upload-Length': String(size), 'Upload-Metadata': encodeTusMetadata(metadata) },
    });
    const location = created.headers.get('location');
    if (created.status !== 201 || !location) throw errorForStatus(created.status, `Storyteller did not accept the upload of ${file.filename}`);
    const uploadUrl = new URL(location, this.base);

    const handle = await open(file.absolutePath, 'r');
    try {
      let offset = 0;
      const buffer = Buffer.allocUnsafe(chunkSize);
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkSize, size - offset), offset);
        offset = await this.patchChunk(uploadUrl, offset, buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
  }

  /** The fallback Storyteller's own uploader uses when a multi-file audiobook was not scanned. */
  async finalizeAudioUpload(bookUuid: string): Promise<void> {
    const response = await this.authed('POST', '/api/v2/books/upload/finalize', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookUuid }),
    });
    if (!response.ok) throw errorForStatus(response.status, 'Storyteller could not finish importing the audiobook');
  }

  /** Idempotent on Storyteller's side: a book already being processed is left as it is. */
  async startProcessing(bookUuid: string): Promise<void> {
    const response = await this.authed('POST', `/api/v2/books/${encodeURIComponent(bookUuid)}/process`);
    if (response.status === 409) throw new StorytellerApiError('Storyteller has not finished importing the EPUB and audiobook', 409, true);
    if (!response.ok) throw errorForStatus(response.status, 'Storyteller refused to start alignment');
  }

  async cancelProcessing(bookUuid: string): Promise<void> {
    const response = await this.authed('DELETE', `/api/v2/books/${encodeURIComponent(bookUuid)}/process`);
    if (!response.ok && response.status !== 404) throw errorForStatus(response.status, 'Storyteller refused to cancel alignment');
  }

  /**
   * Downloads the read-along EPUB to `destination`, resuming a partial file from an earlier attempt,
   * and checks it against the sha256 Storyteller reports.
   */
  async downloadReadAloud(bookUuid: string, destination: string): Promise<void> {
    const existingBytes = await stat(destination).then(
      (s) => s.size,
      () => 0,
    );
    const headers: Record<string, string> = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
    const response = await this.authed('GET', `/api/v2/books/${encodeURIComponent(bookUuid)}/files?format=readaloud`, {
      headers,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    if (response.status === 416) {
      await rm(destination, { force: true });
      throw new StorytellerApiError('The partial download no longer matched the file in Storyteller', 416, true);
    }
    if (!response.ok || !response.body) throw errorForStatus(response.status, 'Could not download the read-along from Storyteller');

    const append = response.status === 206;
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(destination, { flags: append ? 'a' : 'w' }));

    const expected = response.headers.get('x-storyteller-hash')?.toLowerCase();
    if (expected) {
      const actual = await sha256File(destination);
      if (actual !== expected) {
        await rm(destination, { force: true });
        throw new StorytellerApiError('The downloaded read-along did not match the checksum Storyteller reported', null, true);
      }
    }
  }

  private async patchChunk(uploadUrl: URL, offset: number, chunk: Buffer): Promise<number> {
    let currentOffset = offset;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.authedUrl('PATCH', uploadUrl, {
          headers: {
            'Tus-Resumable': TUS_VERSION,
            'Upload-Offset': String(currentOffset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: chunk.subarray(currentOffset - offset),
          timeoutMs: UPLOAD_CHUNK_TIMEOUT_MS,
        });
        if (response.status !== 204) throw errorForStatus(response.status, 'Storyteller rejected part of the upload');
        return Number(response.headers.get('upload-offset') ?? offset + chunk.length);
      } catch (error) {
        if (!(error instanceof StorytellerApiError) || !error.transient || attempt >= CHUNK_RETRIES) throw error;
        // A PATCH that failed partway may still have been partly written; ask where to resume.
        const head = await this.authedUrl('HEAD', uploadUrl, { headers: { 'Tus-Resumable': TUS_VERSION } });
        const serverOffset = Number(head.headers.get('upload-offset'));
        if (!head.ok || !Number.isFinite(serverOffset) || serverOffset < offset || serverOffset > offset + chunk.length) throw error;
        currentOffset = serverOffset;
        if (currentOffset === offset + chunk.length) return currentOffset;
      }
    }
  }

  private async authed(method: string, path: string, init: SendInit = {}): Promise<Response> {
    return this.authedUrl(method, endpointUrl(this.base, path), init);
  }

  /** Signs in lazily and once more on a 401, since a Storyteller session can expire or be revoked. */
  private async authedUrl(method: string, url: URL, init: SendInit = {}): Promise<Response> {
    if (!this.token) await this.login();
    let response = await this.sendUrl(method, url, init);
    if (response.status === 401) {
      this.token = null;
      await this.login();
      response = await this.sendUrl(method, url, init);
    }
    return response;
  }

  private send(method: string, path: string, init: SendInit & { auth?: boolean } = {}): Promise<Response> {
    return this.sendUrl(method, endpointUrl(this.base, path), init);
  }

  private async sendUrl(method: string, url: URL, init: SendInit & { auth?: boolean } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.auth !== false && this.token) headers['Authorization'] = `Bearer ${this.token}`;
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: init.body as BodyInit | undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new StorytellerApiError('Storyteller did not answer in time', null, true);
      }
      throw new StorytellerApiError(`Could not reach Storyteller: ${error instanceof Error ? error.message : String(error)}`, null, true);
    }
  }
}

interface SendInit {
  headers?: Record<string, string>;
  body?: BodyInit | Buffer;
  timeoutMs?: number;
}

/** Joins under the base's own path, so a Storyteller served at a reverse-proxy subpath still works. */
export function endpointUrl(base: URL, path: string): URL {
  const prefix = base.pathname.replace(/\/+$/, '');
  const [pathname, search] = path.split('?');
  const target = new URL(base.href);
  target.pathname = `${prefix}${pathname}`;
  target.search = search ?? '';
  target.hash = '';
  return target;
}

export function encodeTusMetadata(metadata: Record<string, string>): string {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(',');
}

function errorForStatus(status: number, message: string): StorytellerApiError {
  if (status === 401 || status === 403)
    return new StorytellerApiError(`${message}: the Storyteller account is not allowed to do this`, status, false);
  return new StorytellerApiError(`${message} (HTTP ${status})`, status, status >= 500 || status === 429);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await readBoundedText(response, MAX_JSON_BYTES));
  } catch {
    throw new StorytellerApiError('Storyteller returned a response that was not valid JSON', response.status, true);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
