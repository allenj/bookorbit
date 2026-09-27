import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ACTIVE_STORYTELLER_JOB_STATUSES, isActiveStorytellerJobStatus } from '@bookorbit/types';
import type { StorytellerBookState, StorytellerIneligibleReason, StorytellerJob, StorytellerJobStatus, StorytellerStage } from '@bookorbit/types';

import type { RequestUser } from '../../common/types/request-user';
import { isUniqueViolation } from '../../common/utils/db-error.utils';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import type { StorytellerJobRow } from '../../db/schema';
import { LibraryService } from '../library/library.service';
import { selectReadAlongSources } from './read-along-sources';
import { StorytellerClientFactory } from './storyteller-client.factory';
import { StorytellerRepository } from './storyteller.repository';

export function toStorytellerJob(row: StorytellerJobRow): StorytellerJob {
  return {
    id: row.id,
    bookId: row.bookId,
    status: row.status as StorytellerJobStatus,
    stage: (row.stage as StorytellerStage | null) ?? null,
    stageProgress: row.stageProgress,
    queuePosition: row.queuePosition,
    errorMessage: row.errorMessage,
    resultFileId: row.resultFileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type AccessibleBook = NonNullable<Awaited<ReturnType<StorytellerRepository['findBook']>>>;

const RETRYABLE_STATUSES: readonly StorytellerJobStatus[] = ['failed', 'cancelled'];

@Injectable()
export class StorytellerJobService {
  private readonly logger = new Logger(StorytellerJobService.name);

  constructor(
    private readonly repo: StorytellerRepository,
    private readonly libraryService: LibraryService,
    private readonly clients: StorytellerClientFactory,
  ) {}

  async getState(bookId: number, user: RequestUser): Promise<StorytellerBookState> {
    const book = await this.findAccessibleBook(bookId, user);
    const [server, job] = await Promise.all([this.repo.findServer(), this.repo.findLatestJob(bookId)]);
    const available = server?.enabled === true;
    const reason = await this.ineligibleReason(book, available, job);
    return { available, eligible: reason === null, reason, job: job ? toStorytellerJob(job) : null };
  }

  async start(bookId: number, user: RequestUser): Promise<StorytellerJob> {
    const event = 'storyteller.job.start';
    const book = await this.findAccessibleBook(bookId, user);
    const server = await this.repo.findServer();
    const reason = await this.ineligibleReason(book, server?.enabled === true, await this.repo.findLatestJob(bookId));
    if (reason)
      throw new BadRequestException({ message: 'This book cannot be sent to Storyteller', errorCode: `STORYTELLER_${reason.toUpperCase()}` });

    try {
      const row = await this.repo.insertJob({ bookId, requestedByUserId: user.id, storytellerBookUuid: randomUUID(), status: 'pending' });
      this.logger.log(`[${event}] [end] jobId=${row.id} bookId=${bookId} userId=${user.id} - read-along job queued`);
      return toStorytellerJob(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('A read-along is already being made for this book');
      throw error;
    }
  }

  /**
   * Reuses the failed job's Storyteller book, so alignment resumes from whatever Storyteller already
   * finished instead of transcribing hours of audio again.
   */
  async retry(bookId: number, user: RequestUser): Promise<StorytellerJob> {
    const event = 'storyteller.job.retry';
    const book = await this.findAccessibleBook(bookId, user);
    const job = await this.repo.findLatestJob(bookId);
    if (!job || !RETRYABLE_STATUSES.includes(job.status as StorytellerJobStatus)) {
      throw new BadRequestException('There is no failed or cancelled read-along job to retry');
    }
    const server = await this.repo.findServer();
    const reason = await this.ineligibleReason(book, server?.enabled === true, job);
    if (reason)
      throw new BadRequestException({ message: 'This book cannot be sent to Storyteller', errorCode: `STORYTELLER_${reason.toUpperCase()}` });

    try {
      const row = await this.repo.updateJobIf(job.id, RETRYABLE_STATUSES, {
        status: 'pending',
        requestedByUserId: user.id,
        attempts: 0,
        nextAttemptAt: null,
        errorMessage: null,
      });
      if (!row) throw new ConflictException('The job changed while it was being retried');
      this.logger.log(`[${event}] [end] jobId=${row.id} bookId=${bookId} userId=${user.id} - read-along job requeued`);
      return toStorytellerJob(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('A read-along is already being made for this book');
      throw error;
    }
  }

  async cancel(bookId: number, user: RequestUser): Promise<StorytellerJob> {
    const event = 'storyteller.job.cancel';
    await this.findAccessibleBook(bookId, user);
    const job = await this.repo.findLatestJob(bookId);
    if (!job || !isActiveStorytellerJobStatus(job.status as StorytellerJobStatus)) {
      throw new BadRequestException('There is no read-along job in progress for this book');
    }
    const row = await this.repo.updateJobIf(job.id, ACTIVE_STORYTELLER_JOB_STATUSES, { status: 'cancelled', nextAttemptAt: null });
    if (!row) throw new ConflictException('The job finished before it could be cancelled');

    // Best effort: an alignment left running in Storyteller costs CPU but harms nothing here.
    if (job.status === 'aligning') await this.cancelInStoryteller(row);
    this.logger.log(`[${event}] [end] jobId=${row.id} bookId=${bookId} userId=${user.id} previousStatus=${job.status} - read-along job cancelled`);
    return toStorytellerJob(row);
  }

  private async cancelInStoryteller(job: StorytellerJobRow): Promise<void> {
    try {
      const server = await this.repo.findServer();
      if (server) await this.clients.forServer(server).cancelProcessing(job.storytellerBookUuid);
    } catch (error) {
      this.logger.warn(
        `[storyteller.job.cancel] [fail] jobId=${job.id} bookId=${job.bookId} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - could not cancel alignment in Storyteller`,
      );
    }
  }

  private async findAccessibleBook(bookId: number, user: RequestUser) {
    const book = await this.repo.findBook(bookId);
    if (!book) throw new NotFoundException(`Book ${bookId} not found`);
    await this.libraryService.verifyUserAccess(user.id, book.libraryId, user.isSuperuser);
    return book;
  }

  private async ineligibleReason(
    book: AccessibleBook,
    available: boolean,
    latestJob: StorytellerJobRow | null,
  ): Promise<StorytellerIneligibleReason | null> {
    if (!available) return 'not_configured';
    if (latestJob && isActiveStorytellerJobStatus(latestJob.status as StorytellerJobStatus)) return 'job_active';
    if (book.organizationMode === 'book_per_file') return 'single_file_library';
    return selectReadAlongSources(await this.repo.findContentFiles(book.id)).reason;
  }
}
