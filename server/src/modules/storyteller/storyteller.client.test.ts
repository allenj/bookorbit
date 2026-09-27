import { createHash } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { StorytellerApiError, StorytellerClient, encodeTusMetadata, endpointUrl } from './storyteller.client';

type Handler = (request: { method: string; url: URL; headers: Record<string, string>; body: unknown }) => Response | Promise<Response>;

/** A fake Storyteller: routes by method and path, and records every request it saw. */
function fakeServer(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, path: url.pathname, headers, body: init.body });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return new Response(null, { status: 404 });
    return handler({ method, url, headers, body: init.body });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const tokenRoute: Handler = () => Response.json({ access_token: 'tok-1', expires_in: 1, token_type: 'bearer' });

describe('StorytellerClient', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'storyteller-client-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function client(fetchImpl: typeof fetch, baseUrl = 'http://story.local:8001') {
    return new StorytellerClient({ baseUrl, username: 'jeff', password: 'pw' }, fetchImpl);
  }

  it('signs in once and sends the token on later calls', async () => {
    const { fetchImpl, calls } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'GET /api/v2/books/abc': () => Response.json({ uuid: 'abc', ebook: null, audiobook: null, readaloud: null }),
    });
    const c = client(fetchImpl);

    await c.getBook('abc');
    await c.getBook('abc');

    expect(calls.filter((call) => call.path === '/api/v2/token')).toHaveLength(1);
    const bookCalls = calls.filter((call) => call.path === '/api/v2/books/abc');
    expect(bookCalls.every((call) => call.headers['Authorization'] === 'Bearer tok-1')).toBe(true);
  });

  it('signs in again once when the session has expired', async () => {
    let bookCalls = 0;
    const { fetchImpl, calls } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'GET /api/v2/books/abc': () => (++bookCalls === 1 ? new Response(null, { status: 401 }) : Response.json({ uuid: 'abc' })),
    });

    await expect(client(fetchImpl).getBook('abc')).resolves.toEqual({ uuid: 'abc' });
    expect(calls.filter((call) => call.path === '/api/v2/token')).toHaveLength(2);
  });

  it('reports rejected credentials as permanent', async () => {
    const { fetchImpl } = fakeServer({ 'POST /api/v2/token': () => new Response(null, { status: 401 }) });

    const error = await client(fetchImpl)
      .login()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorytellerApiError);
    expect((error as StorytellerApiError).transient).toBe(false);
  });

  it('treats a missing book as absent and a server error as worth retrying', async () => {
    const { fetchImpl } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'GET /api/v2/books/gone': () => new Response(null, { status: 404 }),
      'GET /api/v2/books/broken': () => new Response(null, { status: 502 }),
    });
    const c = client(fetchImpl);

    await expect(c.getBook('gone')).resolves.toBeNull();
    const error = (await c.getBook('broken').catch((e: unknown) => e)) as StorytellerApiError;
    expect(error.transient).toBe(true);
  });

  it('uploads with tus in chunks no larger than the server allows, in order', async () => {
    const path = join(dir, 'Book.epub');
    const content = Buffer.from('0123456789abcdefghij');
    await writeFile(path, content);
    const received: Buffer[] = [];
    let created: Record<string, string> = {};

    const { fetchImpl, calls } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'POST /api/v2/books/upload': ({ headers }) => {
        created = headers;
        return new Response(null, { status: 201, headers: { Location: '/api/v2/books/upload/u1' } });
      },
      'PATCH /api/v2/books/upload/u1': ({ headers, body }) => {
        const chunk = Buffer.from(body as Uint8Array);
        received.push(chunk);
        return new Response(null, { status: 204, headers: { 'Upload-Offset': String(Number(headers['Upload-Offset']) + chunk.length) } });
      },
    });

    await client(fetchImpl).uploadFile('book-uuid', { absolutePath: path, filename: 'Book.epub', filetype: 'application/epub+zip' }, 8);

    expect(created['Upload-Length']).toBe('20');
    expect(created['Upload-Metadata']).toBe(encodeTusMetadata({ bookUuid: 'book-uuid', filename: 'Book.epub', filetype: 'application/epub+zip' }));
    expect(received.map((chunk) => chunk.length)).toEqual([8, 8, 4]);
    expect(Buffer.concat(received)).toEqual(content);
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.headers['Upload-Offset'])).toEqual(['0', '8', '16']);
  });

  it('resumes a chunk from the offset the server reports after a failed PATCH', async () => {
    const path = join(dir, 'Book.m4b');
    await writeFile(path, Buffer.from('abcdefgh'));
    let patches = 0;
    const received: string[] = [];

    const { fetchImpl } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'POST /api/v2/books/upload': () => new Response(null, { status: 201, headers: { Location: '/api/v2/books/upload/u2' } }),
      'PATCH /api/v2/books/upload/u2': ({ headers, body }) => {
        patches++;
        if (patches === 1) return new Response(null, { status: 503 });
        received.push(`${headers['Upload-Offset']}:${Buffer.from(body as Uint8Array).toString()}`);
        return new Response(null, { status: 204, headers: { 'Upload-Offset': '8' } });
      },
      // The failed PATCH got half the chunk through before it died.
      'HEAD /api/v2/books/upload/u2': () => new Response(null, { status: 200, headers: { 'Upload-Offset': '4' } }),
    });

    await client(fetchImpl).uploadFile('book-uuid', { absolutePath: path, filename: 'Book.m4b' }, null);

    expect(received).toEqual(['4:efgh']);
  });

  it('downloads the read-along and checks it against the reported sha256', async () => {
    const payload = Buffer.from('read-along epub bytes');
    const sha = createHash('sha256').update(payload).digest('hex');
    const { fetchImpl } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'GET /api/v2/books/abc/files': () => new Response(payload, { status: 200, headers: { 'X-Storyteller-Hash': sha } }),
    });
    const destination = join(dir, 'out.epub');

    await client(fetchImpl).downloadReadAloud('abc', destination);

    expect(await readFile(destination)).toEqual(payload);
  });

  it('resumes a partial download with a Range request', async () => {
    const payload = Buffer.from('0123456789');
    const sha = createHash('sha256').update(payload).digest('hex');
    const destination = join(dir, 'out.epub');
    await writeFile(destination, payload.subarray(0, 4));
    let range: string | undefined;

    const { fetchImpl } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'GET /api/v2/books/abc/files': ({ headers }) => {
        range = headers['Range'];
        return new Response(payload.subarray(4), { status: 206, headers: { 'X-Storyteller-Hash': sha } });
      },
    });

    await client(fetchImpl).downloadReadAloud('abc', destination);

    expect(range).toBe('bytes=4-');
    expect(await readFile(destination)).toEqual(payload);
  });

  it('discards a download that does not match the checksum', async () => {
    const { fetchImpl } = fakeServer({
      'POST /api/v2/token': tokenRoute,
      'GET /api/v2/books/abc/files': () => new Response('corrupt', { status: 200, headers: { 'X-Storyteller-Hash': 'f'.repeat(64) } }),
    });
    const destination = join(dir, 'out.epub');

    const error = (await client(fetchImpl)
      .downloadReadAloud('abc', destination)
      .catch((e: unknown) => e)) as StorytellerApiError;

    expect(error.transient).toBe(true);
    await expect(stat(destination)).rejects.toThrow();
  });
});

describe('endpointUrl', () => {
  it('keeps a reverse-proxy subpath and the query string', () => {
    expect(endpointUrl(new URL('https://example.com/storyteller/'), '/api/v2/books/x/files?format=readaloud').href).toBe(
      'https://example.com/storyteller/api/v2/books/x/files?format=readaloud',
    );
  });
});
