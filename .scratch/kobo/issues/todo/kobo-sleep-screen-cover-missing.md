---
status: todo
category: bug
assignee: jeff
id: 1
---
# Kobo sleep screen shows no cover art (book list is fine)

Reported 2026-08-06: "Dungeon Crawler Carl" stopped showing artwork on the Kobo sleep
screen. Covers render correctly in the on-device book list. Root cause is **not
confirmed** — two candidates below, and a cheap device-side test discriminates them.
Do that test before writing code.

## What was verified

BookOrbit serves **one fixed-size thumbnail for every Kobo image request**, regardless of
the dimensions the device asked for.

- `server/src/modules/kobo/services/kobo-thumbnail.service.ts:25-38` streams
  `thumbnail.jpg` off disk with no resizing.
- The three routes in `server/src/modules/kobo/kobo-device.controller.ts:33-68` bind
  `:width` and `:height` and then never pass them anywhere.
- Both templates handed to the device in `kobo-sync.controller.ts:105-106`
  (`image_url_template`, `image_url_quality_template`) point at those routes, so every
  size the device requests collapses to the same file.

Live data for the affected book (id 88, library 1, `coverSource: extracted`):

| Asset | Dimensions |
| --- | --- |
| Stored cover | JPEG 3000x4779 baseline |
| Served thumbnail | **JPEG 377x600** |

377x600 is ample for library-grid tiles and far below any current Kobo's full-screen
resolution (1072x1448 on a Clara 2E, 1264x1680 on a Libra Colour, 1440x1920 on a Sage).
The sleep screen is the only surface that requests a full-screen image, and it is the
only surface that is broken.

Note the thumbnail is 377 wide, not 400: `generateThumbnail`
(`server/src/modules/metadata/lib/cover.ts:38`) caps at 400x600 using
`fit: 'inside', withoutEnlargement: true`. Commit `1a64ff10` (2026-03-26) switched that
from `fit: 'cover', position: 'top'`, which used to force exactly 400x600. This cover is
unusually tall (aspect 0.63), so it now lands short of 400.

## Two candidate causes

1. **Undersized image.** Nickel will not use a full-screen sleep image smaller than the
   screen and silently falls back to the default. Fits the symptom exactly. The
   `fit: 'cover'` to `fit: 'inside'` change is a plausible trigger for *stopped* rather
   than *never worked*, though it does not fully explain it, since 400x600 was also below
   screen resolution.
2. **Stale versioned CoverImageId.** `buildVersionedCoverImageId`
   (`kobo-book-identity.service.ts:110`) appends `metadataUpdatedAt` to the image id. Any
   metadata edit mints a new id. The device re-fetches list thumbnails lazily while
   browsing but does not necessarily re-fetch the full-size sleep image, leaving the new
   id with no cached full-size asset. Book 88's `updatedAt` is 2026-07-29, so it did
   change shortly before the report.

## Test that discriminates

Open the book on the device, back out to the library, then sleep it.

- Artwork returns: cause 2 (stale image id).
- Still blank: cause 1 (undersized image).

## Fix

`KoboThumbnailService` should resize to the requested dimensions instead of serving a
fixed thumbnail. The stored cover is 3000x4779 here, so there is plenty of headroom to
resize up from.

- Thread `width`/`height` from all three controller routes into `serveThumbnail`.
- Resize from the full cover, not from `thumbnail.jpg`.
- Cache by book id + requested size. Per `CLAUDE.md` scale rules this is a hot sync path
  across tens of thousands of books, so do not re-encode per request, and keep the cache
  bounded and invalidated when the cover changes.
- Clamp requested dimensions before handing them to sharp: they arrive from the device as
  untrusted path params, and an unbounded resize target is a memory-exhaustion vector.

This change is correct on its own merits whichever cause turns out to be real — serving a
377x600 JPEG in response to a 1264x1680 request is wrong regardless. Cause 2 would need
handling separately if the test points there.

## Not investigated

- No ssh to the Synology (port 22 refused), so the server request log showing which sizes
  the device actually asks for was never read. That log would settle this outright.
- The tracker account (`nyt-tracker`, id 2) holds only `opds_access` and
  `library_edit_metadata`, so it cannot read the audit log or another user's Kobo
  entitlements.
