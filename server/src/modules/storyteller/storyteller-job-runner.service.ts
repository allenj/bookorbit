import { ConflictException, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { createReadStream } from 'fs';
import { mkdir, rm } from 'fs/promises';
import { basename, join } from 'path';
import { UploadErrorCode, isActiveStorytellerJobStatus } from '@bookorbit/types';
import type { StorytellerJobStatus } from '@bookorbit/types';

import { SystemCron } from '../../common/decorators/system-cron.decorator';
import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { storageConfig } from '../../config/config';
import type { StorytellerJobRow, StorytellerServerRow } from '../../db/schema';
import { UploadService } from '../upload/upload.service';
import { readAlongFilename, selectReadAlongSources, storytellerAudioFilename } from './read-along-sources';
import { StorytellerApiError, type StorytellerBook, type StorytellerClient } from './storyteller.client';
import { StorytellerClientFactory } from './storyteller-client.factory';
import { StorytellerRepository } from './storyteller.repository';

const EVENT = 'storyteller.job.step';
/** Enough to keep a handful of books moving without one tick running for hours. */
const JOBS_PER_TICK = 10;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const MAX_ATTACH_NAME_ATTEMPTS = 3;

/** A failure no retry will fix: the job is failed with this message straight away. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));
}

function isPermanent(error: unknown): boolean {
  return error instanceof PermanentJobError || (error instanceof StorytellerApiError && !error.transient);
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (!(error instanceof ConflictException)) return false;
  const response = error.getResponse();
  return typeof response === 'object' && response !== null && (response as { errorCode?: unknown }).errorCode === code;
}

function hasBothFormats(book: StorytellerBook | null): boolean {
  return !!book?.ebook && !book.ebook.missing && !!book.audiobook && !book.audiobook.missing;
}

/**
 * Moves each read-along job one step per tick: send the files, start alignment, watch it, fetch the
 * result and attach it to the book. Every step is safe to repeat, because a restart can interrupt
 * any of them and the next tick simply runs it again.
 */
@Injectable()
export class StorytellerJobRunnerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StorytellerJobRunnerService.name);
  private readonly stagingDirectory: string;
  private running = false;

  constructor(
    @Inject(storageConfig.KEY) storage: ConfigType<typeof storageConfig>,
    private readonly repo: StorytellerRepository,
    private readonly clients: StorytellerClientFactory,
    private readonly uploadService: UploadService,
  ) {
    this.stagingDirectory = join(storage.appDataPath, 'storyteller');
  }

  async onApplicationBootstrap(): Promise<void> {
    await mkdir(this.stagingDirectory, { recursive: true });
  }

  @SystemCron(CronExpression.EVERY_30_SECONDS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const server = await this.repo.findServer();
      if (!server?.enabled) return;
      const jobs = await this.repo.findRunnableJobs(new Date(), JOBS_PER_TICK);
      for (const job of jobs) await this.advance(job, server);
    } catch (error) {
      this.logger.error(
        `[storyteller.job.tick] [fail] errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(error instanceof Error ? error.message : String(error))}" - read-along tick failed`,
      );
    } finally {
      this.running = false;
    }
  }

  async advance(job: StorytellerJobRow, server: StorytellerServerRow): Promise<void> {
    const startedAt = Date.now();
    try {
      const client = this.clients.forServer(server);
      if (job.status === 'pending' || job.status === 'uploading') await this.upload(job, client);
      else if (job.status === 'aligning') await this.poll(job, client);
      else if (job.status === 'downloading') await this.downloadAndAttach(job, client);
    } catch (error) {
      await this.recordFailure(job, error, startedAt);
    }
  }

  private async upload(job: StorytellerJobRow, client: StorytellerClient): Promise<void> {
    const startedAt = Date.now();
    if (!(await this.repo.updateJobIf(job.id, ['pending', 'uploading'], { status: 'uploading' }))) return;

    const selection = selectReadAlongSources(await this.repo.findContentFiles(job.bookId));
    if (!selection.sources) throw new PermanentJobError(`The book no longer qualifies for a read-along (${selection.reason})`);
    const { ebook, audio } = selection.sources;
    this.logger.log(`[${EVENT}] [start] jobId=${job.id} bookId=${job.bookId} step=upload audioFiles=${audio.length} - sending files to Storyteller`);

    let book = await client.getBook(job.storytellerBookUuid);
    if (!hasBothFormats(book)) {
      const chunkSize = await client.getMaxUploadChunkSize();
      if (!book?.ebook || book.ebook.missing) {
        await client.uploadFile(
          job.storytellerBookUuid,
          { absolutePath: ebook.absolutePath, filename: basename(ebook.absolutePath), filetype: 'application/epub+zip' },
          chunkSize,
        );
      }
      if (!book?.audiobook || book.audiobook.missing) {
        for (const [index, file] of audio.entries()) {
          await client.uploadFile(
            job.storytellerBookUuid,
            {
              absolutePath: file.absolutePath,
              filename: storytellerAudioFilename(file.absolutePath, index, audio.length),
              ...(audio.length > 1 && { totalAudioFiles: audio.length }),
            },
            chunkSize,
          );
        }
      }
      book = await client.getBook(job.storytellerBookUuid);
      if (book && !book.audiobook && audio.length > 1) {
        await client.finalizeAudioUpload(job.storytellerBookUuid);
        book = await client.getBook(job.storytellerBookUuid);
      }
      if (!hasBothFormats(book)) throw new StorytellerApiError('Storyteller has not imported both the EPUB and the audiobook yet', null, true);
    }

    // A cancel pressed while files were uploading must not still start hours of alignment.
    if ((await this.repo.findJob(job.id))?.status !== 'uploading') return;
    await client.startProcessing(job.storytellerBookUuid);
    await this.repo.updateJobIf(job.id, ['uploading'], { status: 'aligning', attempts: 0, nextAttemptAt: null, errorMessage: null });
    this.logger.log(
      `[${EVENT}] [end] jobId=${job.id} bookId=${job.bookId} step=upload durationMs=${Date.now() - startedAt} - alignment started in Storyteller`,
    );
  }

  private async poll(job: StorytellerJobRow, client: StorytellerClient): Promise<void> {
    const book = await client.getBook(job.storytellerBookUuid);
    if (!book) throw new PermanentJobError('Storyteller no longer has this book');
    const readaloud = book.readaloud;
    if (!readaloud) {
      await client.startProcessing(job.storytellerBookUuid);
      return;
    }

    switch (readaloud.status) {
      case 'QUEUED':
      case 'PROCESSING':
        await this.repo.updateJobIf(job.id, ['aligning'], {
          stage: readaloud.currentStage,
          stageProgress: clampProgress(readaloud.stageProgress),
          queuePosition: readaloud.queuePosition,
          attempts: 0,
          errorMessage: null,
        });
        return;
      case 'ALIGNED':
        if (readaloud.missing) throw new PermanentJobError('Storyteller finished, but its read-along file is missing');
        if (await this.repo.updateJobIf(job.id, ['aligning'], { status: 'downloading', stageProgress: 1, queuePosition: null, attempts: 0 })) {
          this.logger.log(`[${EVENT}] [end] jobId=${job.id} bookId=${job.bookId} step=align - alignment finished in Storyteller`);
        }
        return;
      case 'ERROR':
        throw new PermanentJobError(`Storyteller failed during ${readaloud.currentStage ?? 'alignment'}. Its logs have the details.`);
      case 'STOPPED':
        throw new PermanentJobError('Alignment was stopped in Storyteller');
    }
  }

  private async downloadAndAttach(job: StorytellerJobRow, client: StorytellerClient): Promise<void> {
    const startedAt = Date.now();
    const stagingPath = join(this.stagingDirectory, `job-${job.id}.epub`);
    if ((await this.repo.findJob(job.id))?.status !== 'downloading') return;
    this.logger.log(`[${EVENT}] [start] jobId=${job.id} bookId=${job.bookId} step=download - fetching read-along from Storyteller`);

    const actor = job.requestedByUserId ? await this.repo.findActor(job.requestedByUserId) : null;
    if (!actor?.active) throw new PermanentJobError('The person who asked for this read-along no longer has an active account');
    const selection = selectReadAlongSources(await this.repo.findContentFiles(job.bookId));
    if (!selection.sources) {
      await rm(stagingPath, { force: true });
      throw new PermanentJobError(`The book no longer qualifies for a read-along (${selection.reason})`);
    }

    await client.downloadReadAloud(job.storytellerBookUuid, stagingPath);
    const resultFileId = await this.attach(job, stagingPath, selection.sources.ebook.absolutePath, actor);
    await rm(stagingPath, { force: true });

    // Unconditional: the file is on the book now, even if somebody pressed cancel meanwhile.
    await this.repo.updateJobIf(job.id, ['downloading', 'cancelled'], {
      status: 'completed',
      resultFileId,
      attempts: 0,
      nextAttemptAt: null,
      errorMessage: null,
    });
    this.logger.log(
      `[${EVENT}] [end] jobId=${job.id} bookId=${job.bookId} step=attach durationMs=${Date.now() - startedAt} fileId=${resultFileId ?? 'existing'} - read-along attached to book`,
    );
  }

  /** Resolves null when the same file is already on the book, which counts as done. */
  private async attach(
    job: StorytellerJobRow,
    stagingPath: string,
    sourceEpubPath: string,
    actor: { id: number; isSuperuser: boolean },
  ): Promise<number | null> {
    for (let attempt = 0; attempt < MAX_ATTACH_NAME_ATTEMPTS; attempt++) {
      // Destroyed either way: a refusal before the upload reads the stream would otherwise leak it.
      const stream = createReadStream(stagingPath);
      try {
        const result = await this.uploadService.addFileToBook(job.bookId, readAlongFilename(sourceEpubPath, attempt), stream, actor);
        return result.id;
      } catch (error) {
        if (hasErrorCode(error, UploadErrorCode.Duplicate)) return null;
        if (hasErrorCode(error, UploadErrorCode.DestinationConflict)) continue;
        throw error;
      } finally {
        stream.destroy();
      }
    }
    throw new PermanentJobError('Every read-along filename is already taken in the book folder');
  }

  private async recordFailure(job: StorytellerJobRow, error: unknown, startedAt: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = job.attempts + 1;
    const permanent = isPermanent(error) || attempts >= MAX_ATTEMPTS;
    const current = await this.repo.findJob(job.id);
    if (!current || !isActiveStorytellerJobStatus(current.status as StorytellerJobStatus)) return;

    this.logger.warn(
      `[${EVENT}] [fail] jobId=${job.id} bookId=${job.bookId} status=${current.status} attempts=${attempts} permanent=${permanent} durationMs=${Date.now() - startedAt} errorClass=${error instanceof Error ? error.name : 'Error'} error="${sanitizeLogValue(message)}" - read-along step failed`,
    );
    await this.repo.updateJobIf(job.id, [current.status as StorytellerJobStatus], {
      ...(permanent ? { status: 'failed', nextAttemptAt: null } : { nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) }),
      attempts,
      errorMessage: message.slice(0, 1000),
    });
  }
}

function clampProgress(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}
