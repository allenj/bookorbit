import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ACTIVE_STORYTELLER_JOB_STATUSES } from '@bookorbit/types';
import type { StorytellerJobStatus } from '@bookorbit/types';

import { DB } from '../../db';
import * as schema from '../../db/schema';
import { bookFiles, books, libraries, storytellerJobs, storytellerServers, users } from '../../db/schema';

type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class StorytellerRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- Server ----

  async findServer() {
    const [row] = await this.db.select().from(storytellerServers).orderBy(asc(storytellerServers.id)).limit(1);
    return row ?? null;
  }

  async insertServer(data: schema.NewStorytellerServerRow) {
    const [row] = await this.db.insert(storytellerServers).values(data).returning();
    return row!;
  }

  async updateServer(id: number, data: Partial<schema.NewStorytellerServerRow>) {
    const [row] = await this.db.update(storytellerServers).set(data).where(eq(storytellerServers.id, id)).returning();
    return row ?? null;
  }

  async deleteServer(id: number) {
    await this.db.delete(storytellerServers).where(eq(storytellerServers.id, id));
  }

  // ---- Books ----

  async findBook(bookId: number) {
    const [row] = await this.db
      .select({ id: books.id, libraryId: books.libraryId, organizationMode: libraries.organizationMode })
      .from(books)
      .innerJoin(libraries, eq(books.libraryId, libraries.id))
      .where(eq(books.id, bookId))
      .limit(1);
    return row ?? null;
  }

  findContentFiles(bookId: number) {
    return this.db
      .select({
        id: bookFiles.id,
        absolutePath: bookFiles.absolutePath,
        format: bookFiles.format,
        sizeBytes: bookFiles.sizeBytes,
        mediaOverlayAvailable: bookFiles.mediaOverlayAvailable,
      })
      .from(bookFiles)
      .where(and(eq(bookFiles.bookId, bookId), eq(bookFiles.role, 'content')))
      .orderBy(asc(bookFiles.sortOrder), asc(bookFiles.absolutePath), asc(bookFiles.id));
  }

  async findActor(userId: number) {
    const [row] = await this.db
      .select({ id: users.id, isSuperuser: users.isSuperuser, active: users.active })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row ?? null;
  }

  // ---- Jobs ----

  async findLatestJob(bookId: number) {
    const [row] = await this.db
      .select()
      .from(storytellerJobs)
      .where(eq(storytellerJobs.bookId, bookId))
      .orderBy(desc(storytellerJobs.createdAt), desc(storytellerJobs.id))
      .limit(1);
    return row ?? null;
  }

  async findJob(id: number) {
    const [row] = await this.db.select().from(storytellerJobs).where(eq(storytellerJobs.id, id)).limit(1);
    return row ?? null;
  }

  async insertJob(data: schema.NewStorytellerJobRow) {
    const [row] = await this.db.insert(storytellerJobs).values(data).returning();
    return row!;
  }

  /**
   * Moves a job only if it is still in one of `from`. A cancel from the UI and the runner can reach
   * the same row at once, and whichever lands second must see that it lost rather than overwrite.
   */
  async updateJobIf(id: number, from: readonly StorytellerJobStatus[], patch: Partial<schema.NewStorytellerJobRow>) {
    const [row] = await this.db
      .update(storytellerJobs)
      .set(patch)
      .where(and(eq(storytellerJobs.id, id), inArray(storytellerJobs.status, [...from])))
      .returning();
    return row ?? null;
  }

  /** Active jobs due for a step, least recently touched first, so a slow one cannot starve the rest. */
  findRunnableJobs(now: Date, limit: number) {
    return this.db
      .select()
      .from(storytellerJobs)
      .where(
        and(
          inArray(storytellerJobs.status, [...ACTIVE_STORYTELLER_JOB_STATUSES]),
          or(isNull(storytellerJobs.nextAttemptAt), lte(storytellerJobs.nextAttemptAt, now)),
        ),
      )
      .orderBy(asc(storytellerJobs.updatedAt), asc(storytellerJobs.id))
      .limit(limit);
  }
}
