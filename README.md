# Forge Neo Client

A desktop client (Electron + React + TypeScript) for the Forge Neo image-generation API. Forge runs
on one PC; the client runs on another machine (for example a laptop on the same VPN) and talks to
Forge's HTTP API. One user, no login.

## What version 0.2.0 does

- Keeps a list of Forge Neo servers and switches between them; shows whether the link is connected, slow, reconnecting or offline.
- Loads the server's checkpoints, VAE and text-encoder modules, samplers and schedulers, and detects
  each checkpoint's model family (SDXL, Z-Image, Qwen, Lumina, Krea 2, Anima) to pick sensible
  defaults and show only the parameters that family uses.
- Text-to-image generation from a floating prompt bar, with the full parameter set in a side panel.
  One request makes one image; asking for several queues several jobs.
- A checkpoint gallery and a LoRA gallery: previews from Forge's own preview files, search, family and folder filters, favorites, notes, a hand-set model family, trigger words (read from the LoRA file's training tags, editable) and a LoRA stack with weights in the parameters panel.
- Hires fix for text-to-image: Off, 1.5×, 2× or 4× with a Forge upscaler, second-pass steps, denoising strength and an optional second-pass CFG. The panel shows the target dimensions; scale choices that exceed 4096 pixels on either side are hidden.
- A queue in the app, not in Forge: jobs run one at a time, can be cancelled while waiting or running,
  and failed or interrupted jobs can be retried. If Forge becomes unreachable the queue pauses and
  continues by itself when Forge is back; the job that was running is marked interrupted. A job that
  was running when the app quit is marked interrupted on the next start, and the queue goes on.
- A gallery of everything generated, with live progress and preview for the running job, delete with
  Undo, and older images loaded as you scroll. Images are kept on this machine, not on the server
  (Forge is asked not to save them).
- Hides chosen images behind a session lock with a password (see Hidden images).
- Recovers from a broken Forge model state: after a generation fails with HTTP 500 the model is unloaded so
  the next job loads it afresh; when generations keep failing, a notice suggests restarting Forge.
- Restarts Forge and unloads the model from the server dialog (restart needs Forge's `--api-server-stop` flag).
- An operation log in the database: queue events, start and finish of every generation with its
  duration, checkpoint changes, connection loss and recovery, Forge restarts, errors. Prompts are never
  written to it. The Activity log panel shows, filters, searches and exports it.
- While its window is visible, the app samples Forge's read-only `/memory` endpoint every two seconds
  (every second during a job). It keeps only the latest 60 readings in memory and saves the sampled
  peak VRAM on each job. The gauge button in the top bar opens the resource panel (VRAM, RAM, CPU and GPU); CPU and GPU
  need the optional read-only stats extension described below.
- New in 0.2.0: a model library with sorting, duplicate finder, own previews and optional Civitai lookup and browser;
  default VAE and text encoders per family; settings presets; search and tags; selecting several images at once;
  a Hires on/off switch with presets; trigger words that go into the prompt with a LoRA.

## Requirements

- Node.js and pnpm.
- A running Forge Neo instance started with `--api --listen`.

## Install

```
git clone https://github.com/erop39/forge-simple.git forge-neo-client
cd forge-neo-client
git checkout feature/core
pnpm install
```

Development happens on `feature/core`; `main` holds the spec and plans. The `postinstall` step
rebuilds `better-sqlite3` for Electron's ABI. Keep the checkout outside cloud-synced folders
(OneDrive, Dropbox): `node_modules` and the build output are large and change constantly.

## Start

- `pnpm dev` - development mode with hot reload.
- Windows without a terminal: `scripts\start-windows.cmd` builds the current code and opens the app
  (make a desktop shortcut to it). It does not need `pnpm` on the PATH, only a completed `pnpm install`.

On first start the app checks once whether Forge answers on this PC (`http://127.0.0.1:7860`, only that
address, no network scan). If it does, it is saved as "This PC" and used straight away. Otherwise the server
dialog opens on the add form, already filled with that address: change it to your Forge address, for
example `http://100.x.y.z:7860`, or keep it. Servers, images and the log live in this PC's user data folder
(see Where data lives); they are not part of the repository and do not move between PCs.

## Commands

- `pnpm dev` - start the app in development mode.
- `pnpm build` - build main, preload and renderer into `out/`.
- `pnpm test` - run the test suite.
- `pnpm typecheck` - run the TypeScript checks.
- `pnpm mock-forge` - run a mock Forge server on port 7861 (override with `PORT`); it answers the `/sdapi/v1` endpoints the client uses and fakes generation progress. `MOCK_CATALOG=many` serves a long checkpoint list across model families; `STEP_MS` sets the time per fake step. `API_SERVER_STOP=1` makes it accept `server-restart` (it then drops every connection and refuses new ones for `RESTART_MS`, default 1500 ms); `FAIL_500=<n>` makes the next n generations fail with a Forge-shaped HTTP 500, `FAIL_500=until-unload` until the model is unloaded or the mock restarts.

## Restarting Forge and unloading the model

When Forge fails to load a checkpoint it can end up naming a model that is not really loaded; every
generation then fails with HTTP 500, whichever checkpoint you pick, until Forge is restarted.

- After a generation fails with HTTP 500 the app asks Forge to unload the checkpoint before the next job,
  so that job loads its model afresh. Two such failures in a row show "Forge keeps failing. Restart it?"
  above the prompt bar.
- **Unload model** (server dialog) frees the loaded checkpoint and its video memory; the next image loads
  it again. It is not available while a job runs.
- **Restart Forge** (server dialog, the notice, or a job tile that failed with a Forge 500) asks first,
  then restarts the Forge process on the home PC. The running job is marked interrupted, the queue waits,
  the connection shows Reconnecting and returns to Connected by itself once Forge is up again.
- Forge accepts a restart only when it was started with `--api-server-stop`. Add it to
  `COMMANDLINE_ARGS` in `webui-user.bat` (for example `set COMMANDLINE_ARGS=--api --listen --api-server-stop`)
  and restart Forge once by hand; until then the button is disabled with this hint.
- A Forge that hangs and no longer answers HTTP requests cannot be restarted from the app: restart it
  on the home PC.

## Resource monitor and optional Forge extension

The gauge button in the top bar opens a side panel (`Esc` or the X closes it; nothing is shown in the bar
itself) with four ring gauges for VRAM, RAM, CPU and GPU, one-minute graphs, peaks, model/cache
VRAM, OOM count, GPU temperature/fan/power, server details, and the existing Unload model and Restart
Forge controls. With Forge's built-in `GET /sdapi/v1/memory` alone, VRAM and Forge-process RAM work;
CPU, GPU activity, system RAM and version fields show dashes. Polling stops when the app window is
hidden or minimized. Failed memory polls do not change the generation queue.

To add the remaining readings, copy the whole `forge-extension/forge-neo-client-stats` folder into
Forge's `extensions` directory on the PC running Forge, then restart Forge. The folder must contain
`scripts/forge_neo_client_stats.py` after copying. The extension registers only
`GET /forge-neo-client/v1/stats` on Forge's existing API port; it starts no second service and makes
no changes to generation. It tries `pynvml`, then `nvidia-smi` for GPU readings. Missing sensors return
`null`. The client checks for the extension on connection and falls back to `/memory` if it is absent.
The extension has been syntax-checked and tested through the client parser and mock API; it has not
been installed or run against the user's Forge.

## Hidden images

Any image can be hidden with the eye button on its tile or the `H` key on a focused tile. The first time,
the app asks you to set a password (at least 4 characters, typed twice); only its scrypt hash (with a random
salt) is stored, in the `settings` table under `lock.hash`. Setting it does not unlock anything: the image
you hid is covered at once, and you unlock hidden images with that password when you want to see them.

While the lock is closed, a hidden image is a hatched tile with a lock and no picture: its prompt, tags and
seed are not sent to the window, text and tag searches do not find it, and its files are not served to the
window, and it cannot be unhidden or deleted. The lock button in the top bar (or a click on a locked tile) asks
for the password; the lock then stays open, with hidden images marked Hidden, until you lock it again or quit
the app. After five wrong passwords in a row, attempts are refused for 30 seconds.
Change password is in the unlock dialog and needs the current password.

This keeps hidden images from a glance at the screen. It is not encryption: the PNG and thumbnail files are
ordinary files in the images folder, readable by anyone with access to this user account.

Forgot the password? Quit the app and delete the `lock.hash` row from the `settings` table of
`forge-neo-client.db` (for example with the sqlite3 tool: `DELETE FROM settings WHERE key = 'lock.hash';`).
No image is lost: hidden images stay hidden. The lock button then asks you to set a new password; after that,
unlock with it to see them.

## Probe

`node tools/probe/probe.mjs http://HOST:7860` asks a live Forge instance read-only questions and writes
`tools/probe/probe-report.json` with the API behaviour the client depends on (see
`docs/forge-api-notes.md`). The report holds the server's model names and file paths, so it is
git-ignored; do not share it.

## Where data lives

By default the app keeps everything under Electron's per-user data folder (`%APPDATA%\forge-neo-client` on Windows):

- `forge-neo-client.db` - SQLite database with servers, jobs, image records, settings and the operation log. The log is the `oplog` table; entries older than the retention period (90 days unless changed in the Activity log panel, 1 to 3650) are purged at start-up.
- `images/` - generated PNGs in month folders (`images/2026-10/`) and JPEG thumbnails in `images/thumbs/`.

The server dialog's **Image storage** section can choose a writable folder for future images. Existing
PNGs and thumbnails stay where they were; the app continues to read them from their original paths,
including after restart. Choosing an unavailable folder leaves the current setting in place. If a
drive containing old images is disconnected, their tiles stay in the database but the files cannot
open until that drive returns; img2img from such a source fails with a source error.

For backup, copy `forge-neo-client.db` and **every** image folder you have used. Keep the same folder
paths when restoring the database on another PC. To move existing images manually, close the app
first and move the database and image folders together only if you also update the stored paths in
the database; the folder picker does not migrate old files. A safer option is to leave old folders
in place and use the picker only for new images.

## Screens

- **Top bar** - a 44 px strip that drags the window. It shows the connection chip (the active server's name and Connected, Slow, Reconnecting with the attempt count, or Offline), a resource panel button, a button that clears all failed and interrupted jobs for good, a settings button, the lock button for hidden images (closed or open padlock; it asks for the password, locks at once when open, or offers to set a password when none is set) and the Activity log button. The connection chip and settings button open the server dialog.
- **Activity log** - a side panel on the right (`Esc` closes it) with the operation log, newest first: time, level (icon and word), category, the message and the duration where there is one. Filter by level, category and period (last hour, 24 hours, 7 days, all time) and search the shown text; new entries appear while it is open. Clicking an entry that belongs to a job shows, for a failed job, its stored error (code, HTTP status and Forge's message, which is kept with the job and never copied into the log), and for a finished job opens its image if the gallery has it loaded. Export writes every entry matching the level, category and period filters (not only those loaded in the panel), or exactly the rows shown while a text search is active, to a JSON Lines file you choose (the log records only its file name); Keep for sets how many days entries are kept. Forge's own console output is not in it: it stays on the home PC, the API does not expose it.
- **Server dialog** - the saved Forge Neo servers (each started with `--api --listen`), each with a name and address; the active one is marked. Add, edit, delete (with confirmation) or Use a server. A new or changed address is tested before it is saved, and a wrong one shows what to check under the field. Switching is refused while a job runs. Under the list, Unload model and Restart Forge act on the active server (see Restarting Forge); Image storage picks the folder for future images. Queued jobs stay with the server they were queued on: those of an inactive server show "Waiting for <name>" and run once it is active again. Deleting a server removes its queued jobs; its images stay. With no saved server the dialog opens by itself on the add form. The add form starts with "This PC" and `http://127.0.0.1:7860` (Forge on the same PC), both editable; Use this PC puts that address back after a change. When that address is already saved, the form starts empty.
- **Prompt bar** - floats at the bottom centre. The prompt field grows to six lines; `Ctrl+Enter` generates (from the prompt or the negative prompt) and `Up Arrow` in an empty prompt field brings back the last prompt. The row below holds the checkpoint (grouped by model family in its menu), aspect ratio, a steps slider, image count, a Negative toggle (not offered for families without a negative prompt), the All parameters button and Generate; in a narrow window the controls move to a second line under the checkpoint. Switching checkpoints keeps the selected image dimensions and proportions. The bookmark button next to the Negative toggle holds saved negative prompts: choosing one replaces the negative text (and opens the field), "Save current as preset…" names the current negative, and "Manage presets…" renames or deletes them. Switching checkpoints or servers keeps the negative text, also through a model family without a negative prompt. The same menu has a "Default for <family>" choice: the negative saved there is filled in when you load a checkpoint of that family (or start the app); inside a family your text stays. Drag a saved image from the gallery onto the bar to use it as an img2img source; the bar shows its thumbnail and an option to remove it.
- The prompt field appears as soon as the window opens. You can type while models load; Generate becomes available once a model is ready.
- **Wheel adjustment** - with the pointer over a slider or number field (in the prompt bar, the parameters panel or the log panel), the mouse wheel steps the value: up increases, down decreases, Shift+wheel moves ten steps. Values stay within their limits (width and height on multiples of 8) and the page does not scroll while you do it.
- **Model galleries** - the grid button next to the checkpoint menu opens the checkpoint gallery; Add LoRA in the parameters panel opens the LoRA gallery. Cards show the preview Forge has next to the model file (`name.png`, `name.preview.png` and the jpg/jpeg/webp spellings; a letter when there is none), the family and whether it is the loaded checkpoint (or a LoRA made for another family). Search matches the name and folder; Family and Folder filter; favorites come first. Select a card for the details panel: Use (checkpoints) or Add to prompt (LoRA), the favorite star, a note, the model family (checkpoints: Automatic or one of the families; it changes the defaults the checkpoint loads with) and, for LoRA, the trigger words found in the file's metadata, which you can edit. Previews load once and are cached; a catalog refresh looks for new ones. The first open of a large library requests previews from Forge a few at a time. While the lists load at start, a loading bar with the server's name stands where the model menu will be.
- **Civitai lookup (optional)** - Update from Civitai in a model gallery asks first (it is off until you agree). It sends the SHA-256 hash of each checkpoint and LoRA file to civitai.com, about one request a second, nothing else, and you can stop it; Forge takes no part. Found files get the official name and base model, trigger words (Civitai's own replace the file's training tags until you edit them), a preview from Civitai when Forge has none, and Open on Civitai in the details panel. Files Civitai does not know are not asked again for 30 days. A card has its own Update from Civitai for one file. A card also lists the images you generated with that model: click one to make it the model's preview (the viewer has the same for the image on screen). The same lookup notes when a newer version of a model exists (chip, details note and a filter), and models that share a file hash or a Civitai version are marked as duplicates (filter Duplicates; the card lists the other copies). Adding a LoRA also puts its trigger words into the prompt (yours and Civitai's whole, from the file's training tags only the most frequent). Trigger words (Civitai's for LoRA and checkpoints alike) are buttons in the details panel that add the word to the prompt; the Sort menu offers name, recently added, release date (from Civitai), most used and recently used (counted from your finished generations), and the cards show the date or the count. Withdraw consent by running the lookup only when you want it; nothing runs in the background otherwise.
- **Parameters panel** - slides in from the right over the canvas (`Esc` closes it). It shows the model card (checkpoint and modules, each marked found or not found), the sampling parameters of the model family (CFG, Distilled CFG and Shift as sliders), seed, size, hires fix with target size and second-pass controls, and the list of VAE and text encoder modules. The hires upscaler can be saved as the default, the second pass has its own CFG, and the whole second pass can be saved as a named preset (Save as preset; pick one to apply it, the X deletes the selected one). CFG and Distilled CFG are sliders in the prompt bar, not in this panel. In img2img mode, resize mode and denoising replace the hires controls.
- **Gallery** - the canvas. Tiles sit in columns (at least two, about one per 226 px) and new ones appear at the top-left. A waiting job has a dashed border and its place in the queue; the running one shows the live preview, stage, step count, speed and elapsed time with a progress line, and both have Cancel. A failed or interrupted job shows what happened and when, with Retry and Dismiss (and a Restart Forge icon after a Forge 500, when Forge allows restarts). A finished image shows its frame marking (number, seconds, size, and the local time it was made, with the date when not today) an HD mark in the top right when it came out of hires fix or an upscale, and Send to hires, Hide and Delete buttons on hover or keyboard focus (Send to hires re-runs the image's own job, same model, prompt and seed, with a second pass whose scale, upscaler, steps, denoising and CFG you choose; it works for images made from a prompt) (`H` on a focused tile hides or unhides it); deleting hides the image and Undo stays available for 5 seconds. A hidden image is a hatched tile with a lock while the lock is closed, and carries a Hidden label while it is open (see Hidden images). When a job finishes, its image fades in over the last preview (at once with reduced motion). Older images load as you scroll; only the tiles near the view are drawn, so thousands of images scroll smoothly. The gallery is one stop in the `Tab` order: the arrow keys move between tiles (left and right to the neighbouring column at the same height, up and down within a column), `Home` and `End` jump to the first and last loaded tile, `Delete` deletes the focused image (with Undo), and `Tab` reaches the focused tile's buttons.
- **Civitai browser** - Browse Civitai in the model library shows new models by type, base model, name and period (last day, week or month), sorted by date, downloads or rating, safe-for-work only. Cards mark models already in your library and open the Civitai page; nothing about your library is sent.
- **Settings backup** - the server dialog's Export settings saves one JSON file with servers, settings presets, hires and negative presets, hand-set families, own trigger words, family defaults, upscaler choices and log retention; Import settings reads such a file, shows how many of each it would add and adds them only after you confirm. Names already taken become "<name> (imported)"; known server addresses and settings you already chose are left alone. Images, tags, jobs, the log, the lock password and the Civitai consent are never exported. The file lists your server addresses, so keep it private.
- **Defaults per family** - in the parameters panel's VAE and text encoders block, Use as default for <family> saves the current modules; every checkpoint of that family then starts with them (Back to Forge's choice undoes it). The LoRA gallery opens on the family of the selected model, with LoRA of unknown family included; pick All in the Family filter to see every LoRA. The side panel of a model gallery shows only for a selected card.
- **Settings presets** - the floppy-disk button left of the model menu lists saved sets of settings: picking one replaces the model, modules, LoRA, size, steps, CFG, sampler, scheduler, hires and tags and keeps your prompt, negative, seed and image count. Save current as preset… stores the current settings under a name (names are unique, ignoring case); Manage presets… renames or deletes. If a preset's model is not on the active server it still applies and the model card shows it as not found. This is separate from the negative-prompt presets (bookmark button) and the hires presets (in the Hires block).
- **Selection** - Ctrl/Cmd+click a tile to pick it, Shift+click to pick a range, `Space` on a focused tile to toggle it, `Esc` to clear. The bar above the prompt bar shows how many are picked and has Tags, Hide or Unhide, Delete (one Undo for all of them) and Clear.
- **Search and tags** - the search field in the top bar (`/` focuses it) matches prompts, model and LoRA names and tags; picking a tag suggestion makes a chip, and every chip must match. While a search is on, the gallery shows saved images only, with a results line and Clear search. The viewer has a Tags row (`T` focuses it; Enter or a comma adds, Backspace removes the last, × removes one) and Reuse settings, which loads the image's saved settings into the prompt bar. The parameters panel's Tags for results puts tags on every image of the next jobs.
- **Image viewer** - click a finished image or focus it and press Enter to see the full-size file. The panel below shows the saved prompt, negative prompt when present, model, scheduler, sampler, steps, dimensions, actual seed, relevant guidance and hires settings, generation time, creation date and time, and enabled LoRAs. Copy prompt writes the saved positive prompt to the system clipboard. Send to img2img attaches this image as the source and closes the viewer; your current prompt and other settings stay in the bar. Upscale lets you choose a method and 1.5×, 2× or 4× scale (limited to 4096 pixels per side), save the method as the default, and queue the result. Open that result to drag the before/after slider across it; Show in folder reveals the file in the file manager; zoom with the magnifier buttons, `+` and `-` keys, the mouse wheel and `0` to fit, and drag to pan. The area below the picture stays fixed (only the prompt text scrolls), so the picture keeps most of the window; Left/Right keys adjust the focused slider instead of changing images. If a hidden source is locked, the comparison is covered. The arrow icons or Left/Right keys move through gallery images, loading older images as needed. The X icon or Escape closes the viewer and returns focus to the opening tile.

## Known limitations

Not in the app yet (planned, see `docs/superpowers/plans/` and `docs/STATUS.md`):

- Img2img sources currently come from saved gallery images; dropping an external file into the app is not supported yet.
- "Save as" for an image (Show in folder reveals the saved file), 
