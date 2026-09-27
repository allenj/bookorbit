import { basename, extname } from 'path';
import { isAudioFormat } from '@bookorbit/types';
import type { StorytellerIneligibleReason } from '@bookorbit/types';

import { naturalCompare } from '../../common/utils/natural-sort.utils';

export interface ReadAlongCandidateFile {
  id: number;
  absolutePath: string;
  format: string | null;
  sizeBytes: number | null;
  mediaOverlayAvailable: boolean | null;
}

export interface ReadAlongSources<T extends ReadAlongCandidateFile = ReadAlongCandidateFile> {
  ebook: T;
  /** In playback order, the order Storyteller must receive them in. */
  audio: T[];
}

export type ReadAlongSourceSelection<T extends ReadAlongCandidateFile> =
  | { sources: ReadAlongSources<T>; reason: null }
  | { sources: null; reason: Extract<StorytellerIneligibleReason, 'no_epub' | 'no_audio' | 'has_read_along'> };

function isEpub(file: ReadAlongCandidateFile): boolean {
  return file.format?.toLowerCase() === 'epub';
}

/**
 * The EPUB and audio a read-along would be made from. A book that already has a read-along is
 * refused rather than given a second one; deleting it is how to ask for a fresh alignment.
 */
export function selectReadAlongSources<T extends ReadAlongCandidateFile>(files: readonly T[]): ReadAlongSourceSelection<T> {
  const present = files.filter((file) => (file.sizeBytes ?? 0) > 0);
  if (present.some((file) => isEpub(file) && file.mediaOverlayAvailable === true)) return { sources: null, reason: 'has_read_along' };

  const ebook = present.find((file) => isEpub(file));
  if (!ebook) return { sources: null, reason: 'no_epub' };

  const audio = present
    .filter((file) => file.format !== null && isAudioFormat(file.format))
    .sort((a, b) => naturalCompare(basename(a.absolutePath), basename(b.absolutePath)));
  if (audio.length === 0) return { sources: null, reason: 'no_audio' };

  return { sources: { ebook, audio }, reason: null };
}

/**
 * Storyteller stores every track of a book in one folder and orders them by name, so tracks get a
 * numeric prefix that keeps BookOrbit's order and cannot collide.
 */
export function storytellerAudioFilename(absolutePath: string, index: number, total: number): string {
  const name = basename(absolutePath);
  if (total === 1) return name;
  return `${String(index + 1).padStart(String(total).length, '0')} - ${name}`;
}

/** The name the finished file is attached under, beside the EPUB it was made from. */
export function readAlongFilename(sourceEpubPath: string, attempt: number): string {
  const stem = basename(sourceEpubPath, extname(sourceEpubPath));
  return attempt === 0 ? `${stem} (read-along).epub` : `${stem} (read-along ${attempt + 1}).epub`;
}
