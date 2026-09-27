import { readAlongFilename, selectReadAlongSources, storytellerAudioFilename } from './read-along-sources';

function file(id: number, absolutePath: string, format: string, extra: { sizeBytes?: number; mediaOverlayAvailable?: boolean } = {}) {
  return { id, absolutePath, format, sizeBytes: extra.sizeBytes ?? 100, mediaOverlayAvailable: extra.mediaOverlayAvailable ?? false };
}

describe('selectReadAlongSources', () => {
  it('pairs the plain EPUB with every audio track in natural order', () => {
    const selection = selectReadAlongSources([
      file(1, '/b/Book.epub', 'epub'),
      file(2, '/b/Part 10.mp3', 'mp3'),
      file(3, '/b/Part 2.mp3', 'mp3'),
      file(4, '/b/Part 1.mp3', 'mp3'),
    ]);

    expect(selection.reason).toBeNull();
    expect(selection.sources?.ebook.id).toBe(1);
    expect(selection.sources?.audio.map((f) => f.id)).toEqual([4, 3, 2]);
  });

  it('refuses a book that already has a read-along', () => {
    const selection = selectReadAlongSources([
      file(1, '/b/Book.epub', 'epub'),
      file(2, '/b/Book (read-along).epub', 'epub', { mediaOverlayAvailable: true }),
      file(3, '/b/Book.m4b', 'm4b'),
    ]);

    expect(selection).toEqual({ sources: null, reason: 'has_read_along' });
  });

  it('needs an EPUB and audio, and ignores empty files', () => {
    expect(selectReadAlongSources([file(1, '/b/Book.m4b', 'm4b')]).reason).toBe('no_epub');
    expect(selectReadAlongSources([file(1, '/b/Book.epub', 'epub'), file(2, '/b/Book.pdf', 'pdf')]).reason).toBe('no_audio');
    expect(selectReadAlongSources([file(1, '/b/Book.epub', 'epub', { sizeBytes: 0 }), file(2, '/b/Book.m4b', 'm4b')]).reason).toBe('no_epub');
  });
});

describe('storytellerAudioFilename', () => {
  it('keeps a single track as it is', () => {
    expect(storytellerAudioFilename('/b/Book.m4b', 0, 1)).toBe('Book.m4b');
  });

  it('prefixes tracks so Storyteller sorts them in playback order and names cannot collide', () => {
    expect(storytellerAudioFilename('/b/cd1/track.mp3', 0, 12)).toBe('01 - track.mp3');
    expect(storytellerAudioFilename('/b/cd2/track.mp3', 11, 12)).toBe('12 - track.mp3');
  });
});

describe('readAlongFilename', () => {
  it('names the result after the EPUB it was made from, numbering later attempts', () => {
    expect(readAlongFilename('/b/01. Neuromancer (2018).epub', 0)).toBe('01. Neuromancer (2018) (read-along).epub');
    expect(readAlongFilename('/b/Book.epub', 1)).toBe('Book (read-along 2).epub');
  });
});
