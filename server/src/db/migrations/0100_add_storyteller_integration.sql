CREATE TABLE "storyteller_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"book_id" integer NOT NULL,
	"requested_by_user_id" integer,
	"storyteller_book_uuid" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"stage" varchar(40),
	"stage_progress" real,
	"queue_position" integer,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"result_file_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storyteller_jobs_status_chk" CHECK ("storyteller_jobs"."status" in ('pending', 'uploading', 'aligning', 'downloading', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "storyteller_jobs_stage_progress_chk" CHECK ("storyteller_jobs"."stage_progress" is null or ("storyteller_jobs"."stage_progress" >= 0 and "storyteller_jobs"."stage_progress" <= 1))
);
--> statement-breakpoint
CREATE TABLE "storyteller_servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"base_url" varchar(500) NOT NULL,
	"username" varchar(200) NOT NULL,
	"password_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storyteller_jobs" ADD CONSTRAINT "storyteller_jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyteller_jobs" ADD CONSTRAINT "storyteller_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyteller_jobs" ADD CONSTRAINT "storyteller_jobs_result_file_id_book_files_id_fk" FOREIGN KEY ("result_file_id") REFERENCES "public"."book_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storyteller_jobs_book_id_idx" ON "storyteller_jobs" USING btree ("book_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storyteller_jobs_storyteller_book_uuid_uidx" ON "storyteller_jobs" USING btree ("storyteller_book_uuid");--> statement-breakpoint
CREATE UNIQUE INDEX "storyteller_jobs_active_book_uidx" ON "storyteller_jobs" USING btree ("book_id") WHERE "storyteller_jobs"."status" in ('pending', 'uploading', 'aligning', 'downloading');--> statement-breakpoint
CREATE INDEX "storyteller_jobs_active_updated_at_idx" ON "storyteller_jobs" USING btree ("updated_at") WHERE "storyteller_jobs"."status" in ('pending', 'uploading', 'aligning', 'downloading');