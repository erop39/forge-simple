# Archiving generations: design proposal

Status: phase 1 is implemented (archive the selection, list, restore a whole archive) with the choices below marked as decided; phases 2 and 3 are not. The red "Delete all generations" button in the server dialog exists and
deletes for good; this is how archiving would give the same relief without losing anything.

## Goal

Free the gallery (and disk) of old generations while keeping the pictures **and** what made them (prompt, settings,
seed, tags), and be able to get any of it back. One user, one machine, a few thousand to tens of thousands of images.

## What there is today

- Images: PNG files plus small JPEG thumbnails in the images folder (approved roots, see `CLAUDE.md`), rows in `images`.
- What made them: one `jobs` row per image batch (`params` JSON with prompt, checkpoint, LoRA, seed, hires…), `tags`, a
  hidden flag, a link to a source image for upscales.
- A 1-megapixel PNG is about 1.5–2 MB, so 10 000 images are 15–20 GB. PNG does not compress further.

## Archive unit

One archive is **a folder** the app creates, named `<date>-<label>`:

```
2026-10-16-autumn-portraits/
  manifest.json      format name + version, app version, created at, counts, total bytes
  records.json       one entry per image: job params, seed, infotext, size, created at, tags, file names, sha256
  images/            the PNG files, original names
  thumbs/            the thumbnails (so an archive can be browsed without decoding every PNG)
```

Why a folder and not a zip or a database:

- PNG is already compressed: a zip adds CPU, memory and a dependency and saves nothing.
- A folder can be browsed, copied to an external disk or NAS, zipped by the user, and survives a damaged file.
- `manifest.json` carries a format version, like the settings backup, so a future app can refuse or convert it.
- A per-archive SQLite file would make queries easy but ties the archive to one engine and one ABI, and it is opaque.

## Where archives live

- A user-chosen **archive folder** (setting, picked like the image folder: native picker, write test), default a sibling
  of the images folder. It can be an external disk or a share; archives are never needed to run the app.
- A table `archives` (name, path, created at, image count, bytes, what was archived) so the app lists archives even when
  the disk is unplugged (shown as "not available"), instead of scanning folders.
- Several archive folders over time are fine: each archive stores its own absolute path.

## What goes in

Chosen in the gallery, in this order of usefulness:

1. The current selection (the selection bar gets "Archive").
2. A rule: everything older than N days, or with a tag, or from one model/job group; the dialog shows count and size first.
3. Later: a monthly "archive what is older than N days" reminder, never silently.

**Hidden images are left out** in the first version. An archive folder is plain files, so putting hidden images in it would
copy them out from behind the password. Encrypting archives with the lock password is possible later, but it is its own
project (key handling, lost password = lost archive). Until then they stay in the gallery, and the dialog says how many
were skipped.

## Archive flow (move, never lose)

1. Choose images, show count and size, check free space on the archive disk.
2. Copy each file to the archive while hashing it; verify size and sha256 after the copy.
3. Write `records.json` and `manifest.json`, then a row in `archives`.
4. Only now delete the images from the gallery (the same removal as today, one transaction per image), and the jobs that
   no longer have images. If any step fails, nothing is deleted from the gallery and the half-written archive folder is removed.
5. Log entry with names and counts only (never prompts, never paths of the user's folders beyond the file name).

## Restore

- From the archive list: restore the whole archive or a selection of it.
- Files are copied back to the active images folder, thumbnails are regenerated, `jobs` (as finished) and `images` rows are
  recreated, tags re-attached. An image already in the gallery (same seed, params and created time) is skipped, so a
  restore twice does not duplicate.
- Restored images get new ids; links between an upscale and its source are rebuilt by the archive's own ids.

## Browsing without restoring (second step)

A read-only archive viewer using `thumbs/` and `records.json`: look, search by prompt/tag, open the full image from the
archive disk, and restore only what is wanted. This makes archiving feel safe, because nothing disappears from sight.

## Interaction with the other features

- **Delete all generations** (red button): its confirmation should offer "Archive first" once this exists.
- **Settings backup** stays separate: it holds settings, never images.
- **Focused view / search**: archived images are not in the gallery, so they are not searched; the archive viewer has its own search.
- **Privacy**: `records.json` holds prompts. Archives are user data like the settings export: never committed, never logged.

## Phases

1. Archive the selection, archive list, restore a whole archive. (Smallest useful thing; covers "clear the gallery without losing".)
2. Rules by age or tag, free-space check, selection restore, "Archive first" in the delete-all dialog.
3. Archive viewer, optional zip export of an archive, optional encryption of hidden images, reminders.

## Decisions (taken 2026-10-16: the proposals below were accepted)

1. Where should archives go: an external disk, a NAS over the VPN, or a folder on the laptop? (Decides the default and whether slow or missing disks need special care.)
2. Folder per archive (proposed) or a single zip file per archive?
3. Hidden images: left out for now (proposed), or archived with a clear warning?
4. Move (delete from the gallery after a verified copy, proposed) or copy (keep both)?
5. Do you want age-based archiving at all, or only manual?
