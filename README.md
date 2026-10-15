# Forge Neo Client

A desktop client (Electron + React + TypeScript) for the Forge Neo image-generation API. Forge runs
on one PC; the client runs on another machine (for example a laptop on the same VPN) and talks to
Forge's HTTP API. One user, no login.

## What version 0.1.0 does

- Keeps a list of Forge Neo servers and switches between them; shows whether the link is connected, slow, reconnecting or offline.
- Loads the server's checkpoints, VAE and text-encoder modules, samplers and schedulers, and detects
  each checkpoint's model family (SDXL, Z-Image, Qwen, Lumina, Krea 2, Anima) to pick sensible
  defaults and show only the parameters that family uses.
- Text-to-image generation from a floating prompt bar, with the full parameter set in a side panel.
  One request makes one image; asking for several queues several jobs.
- Hires fix for text-to-image: Off, 1.5×, 2× or 4× with a Forge upscaler, second-pass steps and denoising strength. The panel shows the target dimensions; scale choices that exceed 4096 pixels on either side are hidden.
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

The app keeps everything under Electron's per-user data folder (`%APPDATA%\forge-neo-client` on Windows):

- `forge-neo-client.db` - SQLite database with servers, jobs, image records, settings and the operation log. The log is the `oplog` table; entries older than the retention period (90 days unless changed in the Activity log panel, 1 to 3650) are purged at start-up.
- `images/` - generated PNGs in month folders (`images/2026-10/`) and JPEG thumbnails in `images/thumbs/`.

## Screens

- **Top bar** - a 44 px strip that drags the window. It shows the connection chip (the active server's name and Connected, Slow, Reconnecting with the attempt count, or Offline) and a settings button, which both open the server dialog, the lock button for hidden images (closed or open padlock; it asks for the password, locks at once when open, or offers to set a password when none is set) and the Activity log button.
- **Activity log** - a side panel on the right (`Esc` closes it) with the operation log, newest first: time, level (icon and word), category, the message and the duration where there is one. Filter by level, category and period (last hour, 24 hours, 7 days, all time) and search the shown text; new entries appear while it is open. Clicking an entry that belongs to a job shows, for a failed job, its stored error (code, HTTP status and Forge's message, which is kept with the job and never copied into the log), and for a finished job opens its image if the gallery has it loaded. Export writes every entry matching the level, category and period filters (not only those loaded in the panel), or exactly the rows shown while a text search is active, to a JSON Lines file you choose (the log records only its file name); Keep for sets how many days entries are kept. Forge's own console output is not in it: it stays on the home PC, the API does not expose it.
- **Server dialog** - the saved Forge Neo servers (each started with `--api --listen`), each with a name and address; the active one is marked. Add, edit, delete (with confirmation) or Use a server. A new or changed address is tested before it is saved, and a wrong one shows what to check under the field. Switching is refused while a job runs. Under the list, Unload model and Restart Forge act on the active server (see Restarting Forge). Queued jobs stay with the server they were queued on: those of an inactive server show "Waiting for <name>" and run once it is active again. Deleting a server removes its queued jobs; its images stay. With no saved server the dialog opens by itself on the add form. The add form starts with "This PC" and `http://127.0.0.1:7860` (Forge on the same PC), both editable; Use this PC puts that address back after a change. When that address is already saved, the form starts empty.
- **Prompt bar** - floats at the bottom centre. The prompt field grows to six lines; `Ctrl+Enter` generates (from the prompt or the negative prompt) and `Up Arrow` in an empty prompt field brings back the last prompt. The row below holds the checkpoint (grouped by model family in its menu), aspect ratio, a steps slider, image count, a Negative toggle (not offered for families without a negative prompt), the All parameters button and Generate; in a narrow window the controls move to a second line under the checkpoint. Switching checkpoints keeps the selected image dimensions and proportions. The bookmark button next to the Negative toggle holds saved negative prompts: choosing one replaces the negative text (and opens the field), "Save current as preset…" names the current negative, and "Manage presets…" renames or deletes them. Switching checkpoints or servers keeps the negative text, also through a model family without a negative prompt. Drag a saved image from the gallery onto the bar to use it as an img2img source; the bar shows its thumbnail and an option to remove it.
- The prompt field appears as soon as the window opens. You can type while models load; Generate becomes available once a model is ready.
- **Wheel adjustment** - with the pointer over a slider or number field (in the prompt bar, the parameters panel or the log panel), the mouse wheel steps the value: up increases, down decreases, Shift+wheel moves ten steps. Values stay within their limits (width and height on multiples of 8) and the page does not scroll while you do it.
- **Parameters panel** - slides in from the right over the canvas (`Esc` closes it). It shows the model card (checkpoint and modules, each marked found or not found), the sampling parameters of the model family (CFG, Distilled CFG and Shift as sliders), seed, size, hires fix with target size and second-pass controls, and the list of VAE and text encoder modules. In img2img mode, resize mode and denoising replace the hires controls.
- **Gallery** - the canvas. Tiles sit in columns (at least two, about one per 226 px) and new ones appear at the top-left. A waiting job has a dashed border and its place in the queue; the running one shows the live preview, stage, step count, speed and elapsed time with a progress line, and both have Cancel. A failed or interrupted job shows what happened and when, with Retry and Dismiss (and a Restart Forge icon after a Forge 500, when Forge allows restarts). A finished image shows its frame marking (number, seconds, size, and the local time it was made, with the date when not today) and Hide and Delete buttons on hover or keyboard focus (`H` on a focused tile hides or unhides it); deleting hides the image and Undo stays available for 5 seconds. A hidden image is a hatched tile with a lock while the lock is closed, and carries a Hidden label while it is open (see Hidden images). When a job finishes, its image fades in over the last preview (at once with reduced motion). Older images load as you scroll; only the tiles near the view are drawn, so thousands of images scroll smoothly. The gallery is one stop in the `Tab` order: the arrow keys move between tiles (left and right to the neighbouring column at the same height, up and down within a column), `Home` and `End` jump to the first and last loaded tile, `Delete` deletes the focused image (with Undo), and `Tab` reaches the focused tile's buttons.
- **Image viewer** - click a finished image or focus it and press Enter to see the full-size file. The panel below shows the saved prompt, negative prompt when present, model, scheduler, sampler, steps, dimensions, actual seed, relevant guidance and hires settings, generation time, creation date and time, and enabled LoRAs. Copy prompt writes the saved positive prompt to the system clipboard. Send to img2img attaches this image as the source and closes the viewer; your current prompt and other settings stay in the bar. The arrow icons or Left/Right keys move through gallery images, loading older images as needed. The X icon or Escape closes the viewer and returns focus to the opening tile.

## Known limitations

Not in the app yet (planned, see `docs/superpowers/plans/` and `docs/STATUS.md`):

- Img2img sources currently come from saved gallery images; dropping an external file into the app is not supported yet. The upscale request and queue are implemented for saved images, but the viewer action and before/after display are planned next.
- LoRA selection in the interface (the request builder supports LoRAs, the screens do not).
- Tags and search in the interface (the storage and the `images.query` call support them), "Reuse settings" and "Save as" for an image.
- Settings presets (negative-prompt presets exist).
- A checkpoint gallery with previews.
- A server status panel (VRAM, CPU, GPU).
- Export and import of presets and servers.
