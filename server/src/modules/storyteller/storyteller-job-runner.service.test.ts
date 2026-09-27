import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConflictException, Logger } from '@nestjs/common';
import type { Mock } from 'vitest';
import { UploadErrorCode } from '@bookorbit/types';

import type { StorytellerJobRow, StorytellerServerRow } from '../../db/schema';
import { StorytellerApiError, type StorytellerBook } from './storyteller.client';
import { StorytellerJobRunnerService, backoffMs } from './storyteller-job-runner.service';

const server = { id: 1, enabled: true, updatedAt: new Date() } as StorytellerServerRow;

const files = [
  { id: 1, absolutePath: '/lib/Book/Book.epub', format: 'epub', sizeBytes: 10, mediaOverlayAvailable: false },
  { id: 2, absolutePath: '/lib/Book/Part 2.mp3', format: 'mp3', sizeBytes: 10, mediaOverlayAvailable: false },
  { id: 3, absolutePath: '/lib/Book/Part 1.mp3', format: 'mp3', sizeBytes: 10, mediaOverlayAvailable: false },
];

function makeJob(overrides: Partial<StorytellerJobRow> = {}): StorytellerJobRow {
  return {
    id: 7,
    bookId: 42,
    requestedByUserId: 5,
    storytellerBookUuid: '11111111-1111-1111-1111-111111111111',
    status: 'pending',
    stage: null,
    stageProgress: null,
    queuePosition: null,
    errorMessage: null,
    attempts: 0,
    nextAttemptAt: null,
    resultFileId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const bothFormats: StorytellerBook = { uuid: 'x', ebook: { missing: false }, audiobook: { missing: false }, readaloud: null };

describe('StorytellerJobRunnerService', () => {
  let job: StorytellerJobRow;
  let repo: Record<string, Mock<(...args: never[]) => unknown>>;
  let client: Record<string, Mock<(...args: never[]) => unknown>>;
  let uploadService: { addFileToBook: ReturnType<typeof vi.fn> };
  let runner: StorytellerJobRunnerService;
  let appDataPath: string;

  beforeEach(async () => {
    appDataPath = await mkdtemp(join(tmpdir(), 'storyteller-runner-'));
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    job = makeJob();
    repo = {
      findJob: vi.fn(() => Promise.resolve({ ...job })),
      // Mirrors the real compare-and-set: the patch lands only while the status still matches.
      updateJobIf: vi.fn((_id: number, from: string[], patch: Partial<StorytellerJobRow>) => {
        if (!from.includes(job.status)) return Promise.resolve(null);
        job = { ...job, ...patch };
        return Promise.resolve({ ...job });
      }),
      findContentFiles: vi.fn(() => Promise.resolve(files)),
      findActor: vi.fn(() => Promise.resolve({ id: 5, isSuperuser: false, active: true })),
    };
    client = {
      getBook: vi.fn(),
      getMaxUploadChunkSize: vi.fn(() => Promise.resolve(null)),
      uploadFile: vi.fn(() => Promise.resolve(undefined)),
      finalizeAudioUpload: vi.fn(() => Promise.resolve(undefined)),
      startProcessing: vi.fn(() => Promise.resolve(undefined)),
      downloadReadAloud: vi.fn((_uuid: string, destination: string) => Promise.resolve(writeFile(destination, 'read-along'))),
    };
    uploadService = { addFileToBook: vi.fn(() => Promise.resolve({ id: 99 })) };
    const factory = { forServer: vi.fn(() => client) };
    runner = new StorytellerJobRunnerService({ appDataPath } as never, repo as never, factory as never, uploadService as never);
    await runner.onApplicationBootstrap();
  });

  afterEach(async () => {
    await rm(appDataPath, { recursive: true, force: true });
  });

  describe('upload', () => {
    it('sends the EPUB, then the tracks in playback order, then starts alignment', async () => {
      client.getBook!.mockResolvedValueOnce(null).mockResolvedValueOnce(bothFormats);

      await runner.advance(job, server);

      const uploads = client.uploadFile!.mock.calls.map((call) => (call as unknown as [string, { filename: string; totalAudioFiles?: number }])[1]);
      expect(uploads.map((f) => f.filename)).toEqual(['Book.epub', '1 - Part 1.mp3', '2 - Part 2.mp3']);
      expect(uploads[1].totalAudioFiles).toBe(2);
      expect(client.startProcessing).toHaveBeenCalledWith(job.storytellerBookUuid);
      expect(job.status).toBe('aligning');
    });

    it('skips the upload when Storyteller already has both files, so a retry resumes', async () => {
      client.getBook!.mockResolvedValue(bothFormats);

      await runner.advance(job, server);

      expect(client.uploadFile).not.toHaveBeenCalled();
      expect(client.startProcessing).toHaveBeenCalled();
      expect(job.status).toBe('aligning');
    });

    it('does not start alignment for a job cancelled while its files were uploading', async () => {
      client.getBook!.mockResolvedValueOnce(null).mockResolvedValueOnce(bothFormats);
      client.uploadFile!.mockImplementation(() => {
        job = { ...job, status: 'cancelled' };
        return Promise.resolve();
      });

      await runner.advance(job, server);

      expect(client.startProcessing).not.toHaveBeenCalled();
      expect(job.status).toBe('cancelled');
    });
  });

  describe('alignment', () => {
    beforeEach(() => {
      job = makeJob({ status: 'aligning' });
    });

    it('mirrors Storyteller progress while it works', async () => {
      client.getBook!.mockResolvedValue({
        ...bothFormats,
        readaloud: { status: 'PROCESSING', currentStage: 'TRANSCRIBE_CHAPTERS', stageProgress: 0.4, queuePosition: 0 },
      });

      await runner.advance(job, server);

      expect(job).toMatchObject({ status: 'aligning', stage: 'TRANSCRIBE_CHAPTERS', stageProgress: 0.4 });
    });

    it('moves on to downloading once aligned', async () => {
      client.getBook!.mockResolvedValue({
        ...bothFormats,
        readaloud: { status: 'ALIGNED', currentStage: 'SYNC_CHAPTERS', stageProgress: 1, queuePosition: null },
      });

      await runner.advance(job, server);

      expect(job.status).toBe('downloading');
    });

    it('fails straight away when Storyteller reports an error', async () => {
      client.getBook!.mockResolvedValue({
        ...bothFormats,
        readaloud: { status: 'ERROR', currentStage: 'TRANSCRIBE_CHAPTERS', stageProgress: 0.1, queuePosition: null },
      });

      await runner.advance(job, server);

      expect(job.status).toBe('failed');
      expect(job.errorMessage).toContain('TRANSCRIBE_CHAPTERS');
    });
  });

  describe('download and attach', () => {
    beforeEach(() => {
      job = makeJob({ status: 'downloading' });
    });

    it('attaches the read-along beside its EPUB as the requester', async () => {
      await runner.advance(job, server);

      expect(uploadService.addFileToBook).toHaveBeenCalledWith(42, 'Book (read-along).epub', expect.anything(), {
        id: 5,
        isSuperuser: false,
        active: true,
      });
      expect(job).toMatchObject({ status: 'completed', resultFileId: 99 });
    });

    it('picks the next name when the first is taken', async () => {
      uploadService.addFileToBook
        .mockRejectedValueOnce(new ConflictException({ errorCode: UploadErrorCode.DestinationConflict, message: 'taken' }))
        .mockResolvedValueOnce({ id: 100 });

      await runner.advance(job, server);

      expect(uploadService.addFileToBook.mock.calls[1]![1]).toBe('Book (read-along 2).epub');
      expect(job.resultFileId).toBe(100);
    });

    it('counts a file that is already on the book as done', async () => {
      uploadService.addFileToBook.mockRejectedValueOnce(new ConflictException({ errorCode: UploadErrorCode.Duplicate, message: 'dupe' }));

      await runner.advance(job, server);

      expect(job).toMatchObject({ status: 'completed', resultFileId: null });
    });

    it('fails rather than attach for someone whose account is gone', async () => {
      repo.findActor!.mockResolvedValue(null);

      await runner.advance(job, server);

      expect(client.downloadReadAloud).not.toHaveBeenCalled();
      expect(job.status).toBe('failed');
    });
  });

  describe('failures', () => {
    it('backs off and keeps the job on a transient error', async () => {
      client.getBook!.mockRejectedValue(new StorytellerApiError('Could not reach Storyteller', null, true));
      const before = Date.now();

      await runner.advance(job, server);

      expect(job.status).toBe('uploading');
      expect(job.attempts).toBe(1);
      expect(job.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + backoffMs(1));
    });

    it('gives up after too many transient failures', async () => {
      job = makeJob({ status: 'aligning', attempts: 7 });
      client.getBook!.mockRejectedValue(new StorytellerApiError('Storyteller did not answer in time', null, true));

      await runner.advance(job, server);

      expect(job.status).toBe('failed');
    });

    it('fails at once when Storyteller refuses the credentials', async () => {
      client.getBook!.mockRejectedValue(new StorytellerApiError('rejected', 401, false));

      await runner.advance(job, server);

      expect(job.status).toBe('failed');
    });
  });

  it('caps the backoff', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
});
