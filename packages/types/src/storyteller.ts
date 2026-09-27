/**
 * Where a read-along job stands on the BookOrbit side. Storyteller's own stage and progress are
 * carried alongside while it aligns, because a single alignment can run for hours.
 */
export const STORYTELLER_JOB_STATUSES = ["pending", "uploading", "aligning", "downloading", "completed", "failed", "cancelled"] as const;
export type StorytellerJobStatus = (typeof STORYTELLER_JOB_STATUSES)[number];

export const ACTIVE_STORYTELLER_JOB_STATUSES = ["pending", "uploading", "aligning", "downloading"] as const satisfies readonly StorytellerJobStatus[];

export function isActiveStorytellerJobStatus(status: StorytellerJobStatus): boolean {
  return (ACTIVE_STORYTELLER_JOB_STATUSES as readonly StorytellerJobStatus[]).includes(status);
}

/** Storyteller's alignment stages, in the order it runs them. */
export type StorytellerStage = "SPLIT_TRACKS" | "TRANSCRIBE_CHAPTERS" | "SYNC_CHAPTERS";

export interface StorytellerServer {
  id: number;
  name: string;
  baseUrl: string;
  username: string;
  hasPassword: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveStorytellerServerRequest {
  name: string;
  baseUrl: string;
  username: string;
  /** Omitted to keep the stored password. */
  password?: string;
  enabled: boolean;
}

export interface StorytellerTestResult {
  connected: boolean;
  error?: string;
}

export interface StorytellerJob {
  id: number;
  bookId: number;
  status: StorytellerJobStatus;
  stage: StorytellerStage | null;
  /** 0-1 within the current stage, as Storyteller reports it. */
  stageProgress: number | null;
  queuePosition: number | null;
  errorMessage: string | null;
  resultFileId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type StorytellerIneligibleReason =
  | "not_configured"
  | "single_file_library"
  | "no_epub"
  | "no_audio"
  | "has_read_along"
  | "job_active";

export interface StorytellerBookState {
  /** A Storyteller server is configured and enabled. */
  available: boolean;
  eligible: boolean;
  reason: StorytellerIneligibleReason | null;
  job: StorytellerJob | null;
}
