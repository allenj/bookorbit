import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';

import type { RequestUser } from '../../common/types/request-user';
import type { StorytellerJobRow } from '../../db/schema';
import { StorytellerJobService } from './storyteller-job.service';

const user = { id: 5, isSuperuser: false } as RequestUser;

const eligibleFiles = [
  { id: 1, absolutePath: '/lib/Book/Book.epub', format: 'epub', sizeBytes: 10, mediaOverlayAvailable: false },
  { id: 2, absolutePath: '/lib/Book/Book.m4b', format: 'm4b', sizeBytes: 10, mediaOverlayAvailable: false },
];

function jobRow(overrides: Partial<StorytellerJobRow> = {}): StorytellerJobRow {
  return {
    id: 7,
    bookId: 42,
    requestedByUserId: 5,
    storytellerBookUuid: '11111111-1111-1111-1111-111111111111',
    status: 'failed',
    stage: null,
    stageProgress: null,
    queuePosition: null,
    errorMessage: 'boom',
    attempts: 3,
    nextAttemptAt: null,
    resultFileId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('StorytellerJobService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let libraryService: { verifyUserAccess: ReturnType<typeof vi.fn> };
  let client: { cancelProcessing: ReturnType<typeof vi.fn> };
  let service: StorytellerJobService;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    repo = {
      findBook: vi.fn(() => Promise.resolve({ id: 42, libraryId: 3, organizationMode: 'book_per_folder' })),
      findServer: vi.fn(() => Promise.resolve({ id: 1, enabled: true })),
      findLatestJob: vi.fn(() => Promise.resolve(null)),
      findContentFiles: vi.fn(() => Promise.resolve(eligibleFiles)),
      insertJob: vi.fn((data: Partial<StorytellerJobRow>) =>
        Promise.resolve(jobRow({ ...data, status: 'pending', errorMessage: null, attempts: 0 })),
      ),
      updateJobIf: vi.fn((_id: number, _from: string[], patch: Partial<StorytellerJobRow>) => Promise.resolve(jobRow(patch))),
    };
    libraryService = { verifyUserAccess: vi.fn(() => Promise.resolve(undefined)) };
    client = { cancelProcessing: vi.fn(() => Promise.resolve(undefined)) };
    service = new StorytellerJobService(repo as never, libraryService as never, { forServer: () => client } as never);
  });

  describe('getState', () => {
    it('checks library access before saying anything about the book', async () => {
      libraryService.verifyUserAccess.mockRejectedValue(new ForbiddenException());

      await expect(service.getState(42, user)).rejects.toThrow(ForbiddenException);
      expect(libraryService.verifyUserAccess).toHaveBeenCalledWith(5, 3, false);
    });

    it('404s an unknown book', async () => {
      repo.findBook!.mockResolvedValue(null);
      await expect(service.getState(42, user)).rejects.toThrow(NotFoundException);
    });

    it('is eligible with a server, an EPUB and audio', async () => {
      await expect(service.getState(42, user)).resolves.toMatchObject({ available: true, eligible: true, reason: null, job: null });
    });

    it.each([
      ['not_configured', () => repo.findServer!.mockResolvedValue(null)],
      ['not_configured', () => repo.findServer!.mockResolvedValue({ id: 1, enabled: false })],
      ['single_file_library', () => repo.findBook!.mockResolvedValue({ id: 42, libraryId: 3, organizationMode: 'book_per_file' })],
      ['job_active', () => repo.findLatestJob!.mockResolvedValue(jobRow({ status: 'aligning' }))],
      ['no_audio', () => repo.findContentFiles!.mockResolvedValue([eligibleFiles[0]])],
    ])('reports %s', async (reason, arrange) => {
      arrange();
      await expect(service.getState(42, user)).resolves.toMatchObject({ eligible: false, reason });
    });
  });

  describe('start', () => {
    it('queues a job owned by the requester with a fresh Storyteller book id', async () => {
      const job = await service.start(42, user);

      expect(repo.insertJob).toHaveBeenCalledWith(
        expect.objectContaining({
          bookId: 42,
          requestedByUserId: 5,
          status: 'pending',
          storytellerBookUuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      );
      expect(job.status).toBe('pending');
    });

    it('refuses an ineligible book with a code the UI can translate', async () => {
      repo.findContentFiles!.mockResolvedValue([eligibleFiles[1]]);

      const error = (await service.start(42, user).catch((e: unknown) => e)) as BadRequestException;
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ errorCode: 'STORYTELLER_NO_EPUB' });
      expect(repo.insertJob).not.toHaveBeenCalled();
    });

    it('turns a lost race for the one live job into a conflict', async () => {
      repo.insertJob!.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
      await expect(service.start(42, user)).rejects.toThrow(ConflictException);
    });
  });

  describe('retry', () => {
    it('requeues the failed job, keeping its Storyteller book so alignment resumes', async () => {
      repo.findLatestJob!.mockResolvedValue(jobRow({ status: 'failed' }));

      await service.retry(42, user);

      expect(repo.updateJobIf).toHaveBeenCalledWith(
        7,
        ['failed', 'cancelled'],
        expect.objectContaining({ status: 'pending', attempts: 0, errorMessage: null }),
      );
      expect(repo.updateJobIf!.mock.calls[0]![2]).not.toHaveProperty('storytellerBookUuid');
    });

    it('has nothing to retry when the last job succeeded', async () => {
      repo.findLatestJob!.mockResolvedValue(jobRow({ status: 'completed' }));
      await expect(service.retry(42, user)).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancel', () => {
    it('stops the alignment in Storyteller when it is running there', async () => {
      repo.findLatestJob!.mockResolvedValue(jobRow({ status: 'aligning' }));

      await service.cancel(42, user);

      expect(client.cancelProcessing).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
    });

    it('still cancels here when Storyteller cannot be reached', async () => {
      repo.findLatestJob!.mockResolvedValue(jobRow({ status: 'aligning' }));
      client.cancelProcessing.mockRejectedValue(new Error('unreachable'));

      await expect(service.cancel(42, user)).resolves.toMatchObject({ status: 'cancelled' });
    });

    it('does not call Storyteller for a job that never got there', async () => {
      repo.findLatestJob!.mockResolvedValue(jobRow({ status: 'pending' }));

      await service.cancel(42, user);

      expect(client.cancelProcessing).not.toHaveBeenCalled();
    });
  });
});
