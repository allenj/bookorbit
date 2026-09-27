import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, real, serial, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';

import { users } from './auth';
import { bookFiles, books } from './books';

/**
 * A Storyteller server BookOrbit hands alignment work to. One row in practice; the service uses
 * the first. The password is encrypted, never returned over HTTP.
 */
export const storytellerServers = pgTable('storyteller_servers', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  baseUrl: varchar('base_url', { length: 500 }).notNull(),
  username: varchar('username', { length: 200 }).notNull(),
  passwordEnc: text('password_enc'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => new Date()),
});

export type StorytellerServerRow = typeof storytellerServers.$inferSelect;
export type NewStorytellerServerRow = typeof storytellerServers.$inferInsert;

/**
 * One read-along being made for one book. Status lists are spelled out as literal SQL for the same
 * reason as in `book-requests.ts`; `storyteller.schema.test.ts` keeps them matched to the shared
 * constants.
 */
export const storytellerJobs = pgTable(
  'storyteller_jobs',
  {
    id: serial('id').primaryKey(),
    bookId: integer('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    /**
     * Whose library access the finished file is attached under. Set null on delete: the job then
     * fails at attach time rather than attaching as nobody.
     */
    requestedByUserId: integer('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * Chosen by BookOrbit and handed to Storyteller as the upload's book id, so a retried upload
     * lands on the same Storyteller book instead of creating a second one.
     */
    storytellerBookUuid: uuid('storyteller_book_uuid').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    stage: varchar('stage', { length: 40 }),
    stageProgress: real('stage_progress'),
    queuePosition: integer('queue_position'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    resultFileId: integer('result_file_id').references(() => bookFiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index('storyteller_jobs_book_id_idx').on(t.bookId, t.createdAt),
    uniqueIndex('storyteller_jobs_storyteller_book_uuid_uidx').on(t.storytellerBookUuid),
    // One live job per book; a finished or failed one does not block the next.
    uniqueIndex('storyteller_jobs_active_book_uidx')
      .on(t.bookId)
      .where(sql`${t.status} in ('pending', 'uploading', 'aligning', 'downloading')`),
    // The runner's only query: active jobs in the order they were last touched.
    index('storyteller_jobs_active_updated_at_idx')
      .on(t.updatedAt)
      .where(sql`${t.status} in ('pending', 'uploading', 'aligning', 'downloading')`),
    check('storyteller_jobs_status_chk', sql`${t.status} in ('pending', 'uploading', 'aligning', 'downloading', 'completed', 'failed', 'cancelled')`),
    check('storyteller_jobs_stage_progress_chk', sql`${t.stageProgress} is null or (${t.stageProgress} >= 0 and ${t.stageProgress} <= 1)`),
  ],
);

export type StorytellerJobRow = typeof storytellerJobs.$inferSelect;
export type NewStorytellerJobRow = typeof storytellerJobs.$inferInsert;
