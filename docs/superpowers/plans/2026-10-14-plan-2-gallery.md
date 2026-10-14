# Forge Neo Client — план 2: галерея и библиотека

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Галерея становится библиотекой: быстрая сетка на тысячи картинок, просмотр на весь экран, выделение и действия пачкой, теги, поиск, замок скрытых картинок, галерея чекпоинтов с превью, стек LoRA, пресеты настроек и экран журнала.

**Architecture:** Как в плане 1: main владеет данными (SQLite-миграции, запросы, файлы, HTTP к Forge), renderer получает их через типизированный IPC. Новое: запросы галереи с фильтрами идут в main (`images.query`), замок живёт в main и решает, что отдаётся renderer'у и протоколом `fnc-img`, превью чекпоинтов проксируются через новый протокол `fnc-ckpt`.

**Tech Stack:** Electron, electron-vite, React, TypeScript (strict), pnpm, vitest, better-sqlite3, zustand, Radix Primitives (Dialog, DropdownMenu, Slider, Tooltip, Checkbox), Phosphor Icons, CSS Modules. Node `crypto.scrypt` для замка. Новых библиотек виртуализации нет — раскладка своя (она уже есть в `gallery-items.ts`).

**Spec:** `docs/superpowers/specs/2026-10-13-forge-neo-client-design.md`. Исполнитель читает разделы 5 (Интерфейс, Теги, Скрытые картинки), 9, 11 и 12 до начала работы.

**Этот план покрывает** из спеки: виртуализацию и клавиатуру галереи (§11 Производительность, Клавиатура), растворение мозаики в картинку (§11 Движение), выделение и действия пачкой, просмотр картинки (без апскейла, img2img и ползунка «до/после» — план 3), теги, поиск, скрытые картинки и замок, галерею чекпоинтов, стек LoRA, пресеты, экран журнала с экспортом и сроком хранения.
**Не покрывает** (план 3): img2img, hires fix, апскейл, панель ресурсов и расширение, перезапуск Forge и выгрузку модели, экспорт и импорт, настройку папки картинок.

**Предпосылки.** До плана 2 выполнены задачи U1–U3 (вне планов, по просьбам пользователя): компонент `ui/Slider` и прокручиваемые меню (U1), список серверов (U2), пресеты негатива (U3). План использует `Slider` и стиль меню из U1; миграции плана 2 добавляются **после** миграций U2/U3 — номер версии не указан намеренно: каждая новая миграция дописывается в конец массива `MIGRATIONS` в `src/main/storage/db.ts`.

## Global Constraints

- Все строки, видимые пользователю, — английские и лежат только в `src/renderer/locales/en.ts`; в JSX и в main строковых литералов для показа нет.
- Готовые наборы компонентов и темы (MUI, Ant, shadcn/ui, Tailwind) запрещены. Разрешены Radix Primitives и Phosphor Icons (начертание Regular, размеры 16 и 20).
- Цвета, отступы, скругления, длительности — только через CSS-переменные из `src/renderer/styles/tokens.css`; сырых значений в компонентах нет.
- Текст не меньше 12 px; начертания только 400 и 500; заглавными ничего не набирается.
- Анимируются только `transform` и `opacity`; при `prefers-reduced-motion` переходы мгновенные.
- Все HTTP-запросы к Forge идут из main-процесса. Renderer: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Промпты в журнал не пишутся. Ошибка записи в журнал не прерывает операцию.
- Каждый запрос генерации отправляется с `override_settings_restore_afterwards: false`, `save_images: false`, `batch_size: 1`, `n_iter: 1`.
- Каждый коммит, меняющий поведение, добавляет строку в `CHANGELOG.md` (раздел `Unreleased`) и приводит `README.md` в соответствие. Оба файла на английском.
- Тесты запускаются командой `pnpm test`. Один файл: `pnpm test <путь>`. Перед коммитом — `pnpm build` (CSS-модули проверяются только сборкой).
- Минимальный размер окна 1100×700.
- Реальные пути, имена моделей и адрес сервера пользователя в коммиты не попадают.
- Ошибки пересекают границы кодами (`JobError`, `IpcErrorKey`), не текстом.

## Review Focus

1. **Скрытая картинка при закрытом замке доступна по прямому адресу.** Renderer получает урезанную запись, но `fnc-img://local/<путь>` может быть запрошен напрямую (из старой записи в памяти, из devtools). Ожидание: протокол отвечает 404 на файлы и миниатюры скрытых картинок, пока замок закрыт. Тест в задаче 2.
2. **Поиск и теги находят скрытые картинки.** Ожидание: при закрытом замке запрос с текстом или тегом, совпадающим со скрытой картинкой, её не возвращает, а подсказка тегов не показывает теги, которые есть только у скрытых картинок. Тесты в задачах 1 и 2.
3. **LoRA или чекпоинт из пресета нет на сервере.** Ожидание: пресет применяется, недостающие части видны в карточке модели как «Not found», запуск получает `failed` с `missing` (как в плане 1), приложение не падает. Тест в задаче 10.
4. **Метаданные LoRA без `ss_tag_frequency`, с ним в виде строки JSON или с мусором.** Ожидание: триггер-слова пустые, каталог грузится. Тест в задаче 9.
5. **Тысячи картинок и быстрая прокрутка.** Ожидание: в DOM только видимые плитки и запас в один экран; подгрузка страниц не дублирует и не теряет картинки при одновременном удалении. Тест в задаче 3.

---

## Структура файлов

```
src/main/
  storage/db.ts                 + миграции: tags, image_tags, presets, lora_meta
  storage/repos.ts              + images.query/get/setHidden, tags.*, presets.*, loraMeta.*, checkpointMeta.*
  storage/image-query.ts        новый: сборка SQL для images.query (фильтры, курсор)
  lock/lock.ts                  новый: пароль (scrypt), состояние замка
  forge/previews.ts             новый: перебор кандидатов превью, кэш на диске
  forge/lora-meta.ts            новый: триггер-слова и базовая модель из метаданных
  ckpt-protocol.ts              новый: обработчик протокола fnc-ckpt://
  ipc/register.ts               + каналы images/tags/lock/presets/loras/checkpoints/oplog
src/shared/
  types.ts                      + ImageQuery, ImageDetails, Preset, LoraInfo, LockState
  ipc.ts                        + новые методы Api и события
src/renderer/
  state/store.ts                + query, selection, lock, presets, viewer
  state/masonry.ts              новый: раскладка с координатами и видимый диапазон
  components/Gallery.tsx        виртуализация, выделение, клавиатура
  components/SelectionBar.tsx   новый
  components/Viewer.tsx         новый
  components/TagEditor.tsx      новый
  components/SearchField.tsx    новый
  components/LockButton.tsx, LockDialog.tsx   новые
  components/CheckpointGallery.tsx            новый
  components/LoraStack.tsx, LoraPicker.tsx    новые
  components/PresetMenu.tsx, SavePresetDialog.tsx  новые
  components/LogPanel.tsx       новый
```

---

### Task 1: Теги и запрос галереи в main

**Files:**
- Modify: `src/main/storage/db.ts`, `src/main/storage/repos.ts`, `src/shared/types.ts`
- Create: `src/main/storage/image-query.ts`, `src/main/storage/image-query.test.ts`
- Test: `src/main/storage/repos.test.ts`

**Interfaces:**
- Produces (shared/types.ts):
  ```ts
  export interface ImageQuery { limit: number; beforeId?: number; text?: string; tags?: string[] }
  // ImageRecord gains: tags: string[]; locked: boolean
  ```
  `locked: true` означает урезанную запись: `url`, `thumbUrl`, `infotext` — пустые строки, `seed` 0, `tags` [], остальное (id, jobId, width, height, createdAt, durationMs, hidden) как есть.
- Produces (repos): `images.query(q: ImageQuery, opts: { revealHidden: boolean }): ImageRow[]`, `images.get(id): ImageRow | null`, `images.setHidden(ids: number[], hidden: boolean): number`, `tags.forImages(ids: number[]): Map<number, string[]>`, `tags.add(imageIds: number[], names: string[]): void`, `tags.remove(imageIds: number[], names: string[]): void`, `tags.suggest(prefix: string, limit: number, opts: { revealHidden: boolean }): string[]`.

- [ ] **Step 1: Миграция.** `tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)`, `image_tags (image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (image_id, tag_id))`, индекс `image_tags(tag_id)`. Тест: база предыдущей версии с картинкой обновляется, картинка на месте.
- [ ] **Step 2: Тесты `image-query.test.ts`** (на временной базе через `openDb`):
  ```ts
  test('text matches prompt, checkpoint and LoRA names from the job params, case-insensitive', …)
  test('several tags narrow the result (AND)', …)
  test('text and tags combine', …)
  test('cursor: beforeId pages without gaps or repeats', …)
  test('hidden images are excluded from text/tag matches unless revealHidden', …)
  test('hidden images without filters are still listed (as locked rows) when not revealed', …)
  test('LIKE wildcards in text are literal: "50%" does not match everything', …)
  ```
- [ ] **Step 3: Реализовать `buildImageQuery(q, revealHidden): { sql: string; args: unknown[] }`** в `image-query.ts`. Текст ищется по `json_extract(jobs.params,'$.prompt')`, `'$.checkpoint'` и по именам LoRA (`EXISTS (SELECT 1 FROM json_each(jobs.params,'$.loras') WHERE json_extract(value,'$.name') LIKE ?)`) через `LIKE ? ESCAPE '\'` с экранированием `%`, `_`, `\`. Теги — `EXISTS` на каждый тег. Если есть текст или теги и `!revealHidden` — `images.hidden = 0`. Порядок `images.id DESC`, лимит.
- [ ] **Step 4: Теги в repos.** `tags.add` нормализует имена (trim, схлопнуть пробелы, длина 1..40, пустые отбрасываются), создаёт недостающие теги. `tags.remove` после удаления связей удаляет теги без картинок (спека: «тег, не привязанный ни к одной картинке, удаляется»). То же после `images.delete` — тест: удалили единственную картинку с тегом → тега нет. `tags.suggest` — по префиксу без учёта регистра, по убыванию числа картинок; без `revealHidden` считает только видимые картинки.
- [ ] **Step 5: Run** `pnpm test src/main/storage`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: tags and filtered image queries in storage` (без строки в CHANGELOG — поведения для пользователя ещё нет).

---

### Task 2: Замок и скрытие

**Files:**
- Create: `src/main/lock/lock.ts`, `src/main/lock/lock.test.ts`, `src/renderer/components/LockButton.tsx`, `LockDialog.tsx` (+ css, тесты)
- Modify: `src/main/storage/image-protocol.ts`, `src/main/ipc/register.ts`, `src/shared/ipc.ts`, `src/shared/types.ts`, `src/renderer/components/TopBar.tsx`, `ImageTile.tsx`, `src/renderer/state/store.ts`, `locales/en.ts`

**Interfaces:**
- Consumes: Task 1 `images.query/setHidden`, `ImageRecord.locked`.
- Produces:
  ```ts
  // shared/types.ts
  export interface LockState { hasPassword: boolean; open: boolean }
  // main/lock/lock.ts
  export interface Lock {
    state(): LockState
    setPassword(oldPassword: string | null, newPassword: string): Promise<void> // rejects 'error.wrongPassword'
    open(password: string): Promise<void>                                      // rejects 'error.wrongPassword'
    close(): void
    isOpen(): boolean
  }
  export function createLock(settings: { get(k: string): string | null; set(k: string, v: string): void }, oplog: Oplog): Lock
  ```
  Api: `lock: { state(): Promise<LockState>; open(pw: string): Promise<void>; close(): Promise<void>; setPassword(old: string | null, next: string): Promise<void> }`, `images: { …; query(q: ImageQuery): Promise<ImageRecord[]>; setHidden(ids: number[], hidden: boolean): Promise<void> }`. События: `'lock': LockState`, `'images:changed': { ids: number[] }`. `IPC_ERROR_KEYS` += `'error.wrongPassword'`, `'error.noPassword'`.

- [ ] **Step 1: Тесты `lock.test.ts`:** пароль хранится в `settings['lock.hash']` как `scrypt$<N>$<saltHex>$<hashHex>` (N = 16384, соль 16 байт, ключ 32 байта), никогда не открытым текстом; `open` с неверным паролем отклоняется и пишет `lock`-событие уровня `warn` без пароля в деталях; сравнение через `timingSafeEqual`; смена пароля требует старый; `setPassword(null, …)` разрешён только когда пароля нет; `close` и новый экземпляр `createLock` (перезапуск) — замок закрыт.
- [ ] **Step 2: Реализовать `lock.ts`.** Минимальная длина пароля 4 (иначе `error.invalidParams`).
- [ ] **Step 3: Тесты протокола:** при закрытом замке `fnc-img://local/<файл скрытой картинки>` и её миниатюры → 404; при открытом → файл. Резолверу протокола передаётся функция `isBlocked(relPath): boolean`, которая смотрит в базу (`images.file_path`/`thumb_path` с `hidden = 1`) и в `lock.isOpen()`.
- [ ] **Step 4: IPC.** `images:query` урезает скрытые строки (`locked: true`), если замок закрыт; `images:list` из плана 1 становится обёрткой над `query` без фильтров. `images:setHidden` — пишет `storage`-событие (ids и признак, без промптов) и шлёт `images:changed`. Скрытие разрешено без пароля только если пароль задан (иначе `error.noPassword` — renderer сначала просит задать пароль, спека: «пароль задаётся при первом скрытии»). Закрытие и открытие замка шлют `lock`, renderer перезагружает галерею.
- [ ] **Step 5: Renderer.** Кнопка замка в TopBar (значок `LockSimple` / `LockSimpleOpen`, подпись для диктора). Диалог: задать пароль (два поля) при первом скрытии, ввести пароль, сменить пароль. Скрытая плитка при закрытом замке — `--surface-1`, диагональная штриховка (`repeating-linear-gradient` из токенов линий — это узор, не декоративный градиент; оформить токеном `--hatch`), значок замка, тот же размер. При открытом — картинка с меткой-значком «hidden». Действие «Hide/Unhide» на плитке (рядом с Delete) и клавиша `H` на плитке в фокусе.
- [ ] **Step 6: Тесты renderer:** закрытый замок → плитка без `img`; открыть паролем → картинки видны с меткой; первая попытка скрыть без пароля открывает диалог задания пароля.
- [ ] **Step 7: README** (раздел Hidden images: защищает от взгляда на экран, файлы не шифруются, как сбросить забытый пароль — удалить ключ `lock.hash` из `settings`), CHANGELOG. Commit `feat: hide images behind a session lock`.

---

### Task 3: Виртуализированная галерея и клавиатура

**Files:**
- Create: `src/renderer/state/masonry.ts`, `masonry.test.ts`
- Modify: `src/renderer/components/Gallery.tsx`, `ImageTile.tsx`, `JobTile.tsx`, их css и тесты; `src/renderer/state/gallery-items.ts`

**Interfaces:**
- Consumes: `galleryItems`, `layoutColumns` из плана 1.
- Produces:
  ```ts
  export interface Placed { key: string; column: number; x: number; y: number; w: number; h: number }
  export function placeItems(items: GalleryItem[], columns: number, width: number, gap: number): { placed: Placed[]; height: number }
  export function visibleSlice(placed: Placed[], top: number, bottom: number): Placed[]
  ```

- [ ] **Step 1: Тесты `masonry.test.ts`:** высота плитки = ширина колонки × h/w записи; каждая плитка в самой короткой колонке (как `layoutColumns`); `visibleSlice` возвращает плитки, пересекающие `[top, bottom]`; 10 000 элементов раскладываются быстрее 50 мс.
- [ ] **Step 2: Реализовать.** Плитки абсолютно позиционированы через `transform: translate(x, y)`; контейнер высотой `height`. Рендер — `visibleSlice(placed, scrollTop - viewport, scrollTop + 2 × viewport)` (запас в один экран сверху и снизу). Подгрузка следующей страницы — когда нижняя граница видимого запаса ближе одного экрана к `height`, а не по наблюдателю; повтор после ошибки — при следующей прокрутке (закрывает отложенную мелочь плана 1).
- [ ] **Step 3: Клавиатура.** Roving tabindex: в галерее одна точка табуляции, стрелки двигают фокус к ближайшей плитке в направлении (влево/вправо — соседняя колонка на той же высоте, вверх/вниз — соседняя в колонке), `Home`/`End`, `Enter` открывает просмотр (задача 5), `Delete` удаляет с Undo (как в плане 1), `H` скрывает (задача 2). Кнопки на плитке доступны по `Tab` только внутри плитки в фокусе. Фокус прокручивает плитку в видимую область.
- [ ] **Step 4: Растворение.** Когда задача становится картинкой, плитка картинки 260 мс проявляется поверх последнего превью (`opacity` 0→1, токен `--dur-reveal`), затем превью убирается. При `prefers-reduced-motion` — сразу.
- [ ] **Step 5: Тесты:** в DOM не больше плиток, чем помещается в 3 экрана (jsdom: задать размеры через мок `ResizeObserver` и `scrollTop`); стрелки переносят фокус; одна точка табуляции; растворение — класс снимается по таймеру.
- [ ] **Step 6: В окне** (mock-forge, 300+ картинок — вспомогательный скрипт заполнения временной базы допускается в `tools/`): прокрутка плавная, в DOM ограниченное число плиток. CHANGELOG, commit `feat: virtualized gallery with keyboard navigation`.

---

### Task 4: Выделение и действия пачкой

**Files:**
- Create: `src/renderer/components/SelectionBar.tsx` (+ css, test)
- Modify: `Gallery.tsx`, `ImageTile.tsx`, `store.ts`, `src/main/ipc/register.ts`, `src/shared/ipc.ts`

**Interfaces:**
- Consumes: Task 1 теги, Task 2 `images.setHidden`.
- Produces: store `selection: Set<number>`, `toggleSelect(id, mode: 'single' | 'add' | 'range')`, `clearSelection()`. Api `images.deleteMany(ids: number[]): Promise<{ deleted: number[]; failed: number[] }>`, `tags.add(ids, names)`, `tags.remove(ids, names)`, `tags.suggest(prefix): Promise<string[]>`.

- [ ] **Step 1: Тесты:** `Ctrl`+щелчок добавляет/убирает, `Shift`+щелчок выделяет диапазон в порядке галереи, `Esc` снимает выделение; выделенная плитка — граница 2 px `--signal` и значок-галочка (не только цвет); при выделении внизу над панелью промпта появляется панель «N selected · Tags · Hide · Delete · Clear».
- [ ] **Step 2: Реализовать.** Удаление пачкой — одно уведомление с Undo на всю пачку (5 с), затем `images.deleteMany`; частичная ошибка — уведомление с числом неудачных, неудачные возвращаются в сетку. Скрытие пачкой — через Task 2. Теги пачкой — диалог `TagEditor` в режиме пачки (задача 6) — до задачи 6 кнопка Tags не показывается.
- [ ] **Step 3: CHANGELOG, commit** `feat: select images and act on several at once`.

---

### Task 5: Просмотр картинки

**Files:**
- Create: `src/renderer/components/Viewer.tsx` (+ css, test)
- Modify: `src/main/ipc/register.ts`, `src/shared/ipc.ts`, `src/shared/types.ts`, `store.ts`, `Gallery.tsx`

**Interfaces:**
- Produces:
  ```ts
  export interface ImageDetails { image: ImageRecord; params: GenerationParams; jobType: JobType }
  ```
  Api `images.details(id): Promise<ImageDetails>` (отказ `error.notFound`; для скрытой при закрытом замке тоже `error.notFound`), `images.saveAs(id): Promise<boolean>` (main показывает `dialog.showSaveDialog` с именем `forge-<id>-<seed>.png`, копирует файл; `false` при отмене). Store `viewerId: number | null`, `openViewer(id)`, `closeViewer()`, `reuseSettings(params)`.

- [ ] **Step 1: Тесты:** открывается по `Enter`/двойному щелчку; полная картинка (`url`, не `thumbUrl`); справа параметры (модель, размер, шаги, CFG/shift по профилю, сэмплер, планировщик, сид, LoRA, время генерации) моноширинным для значений; `←`/`→` листают в порядке галереи; `Esc` закрывает и возвращает фокус на плитку; «Reuse settings» переносит все параметры, включая промпт, негатив, LoRA и сид, в панель промпта и закрывает просмотр; «Delete» — с тем же Undo; «Hide» — через Task 2.
- [ ] **Step 2: Реализовать** на Radix Dialog, на весь окно, раскрытие из плитки 260 мс (`transform: scale` от прямоугольника плитки, `opacity`), при reduced motion — сразу. Действий апскейла и img2img нет (план 3).
- [ ] **Step 3: README** (раздел Viewer), CHANGELOG, commit `feat: full-screen image viewer`.

---

### Task 6: Теги в интерфейсе и теги для результатов

**Files:**
- Create: `src/renderer/components/TagEditor.tsx`, `Tag.tsx` (+ css, test)
- Modify: `Viewer.tsx`, `SelectionBar.tsx`, `ParamsPanel.tsx`, `src/shared/types.ts`, `src/main/ipc/register.ts`, `src/main/queue/runner.ts`, `store.ts`

**Interfaces:**
- Consumes: Task 1 `tags.*`, Task 4 Api `tags.*`.
- Produces: `GenerationParams.tags: string[]` (по умолчанию `[]`; `parseParams` старых задач даёт `[]`; валидация в `jobs:enqueue`: не больше 20, каждый 1..40 символов). Runner после сохранения картинки вызывает `repos.tags.add([imageId], params.tags)`.

- [ ] **Step 1: Тесты:** `TagEditor` — ввод с подсказкой из `tags.suggest`, `Enter` или `,` добавляет, `Backspace` в пустом поле убирает последний, значок × убирает; тег — прямоугольник со скруглением 4, 12 px, граница `--line`. В просмотре клавиша `T` фокусирует редактор. В режиме пачки — общие теги показаны полностью, частичные — со значком «у части»; удаление частичного убирает у всех.
- [ ] **Step 2: Тест runner:** задача с `tags: ['night', 'sea']` → у сохранённой картинки эти теги; пустой список — без вызова.
- [ ] **Step 3: Реализовать.** В боковой панели параметров — поле «Tags for results».
- [ ] **Step 4: README, CHANGELOG, commit** `feat: tag images and tag results of a job`.

---

### Task 7: Поиск

**Files:**
- Create: `src/renderer/components/SearchField.tsx` (+ css, test)
- Modify: `TopBar.tsx`, `store.ts`, `Gallery.tsx`

**Interfaces:**
- Consumes: Task 1 `ImageQuery`, Task 2 `images.query`, Task 4 `tags.suggest`.
- Produces: store `query: { text: string; tags: string[] }`, `setQuery(patch)`; при изменении — перезагрузка первой страницы через `images.query` с задержкой 250 мс после ввода.

- [ ] **Step 1: Тесты:** `/` вне полей ввода фокусирует поиск (в поле показана клавиша `/`); выбор тега из подсказки превращает его в чип; несколько чипов — И; `Esc` в поле очищает текст, второй `Esc` — чипы и уходит из поля; при активном фильтре плитки задач (очередь) не показываются, а над сеткой строка «N results · Clear»; пустой результат — отдельный текст, не пустая галерея первого запуска.
- [ ] **Step 2: Реализовать.** Поиск слева в верхней строке, область перетаскивания окна не перекрывает поле (`-webkit-app-region: no-drag`).
- [ ] **Step 3: README, CHANGELOG, commit** `feat: search images by prompt, model, LoRA and tags`.

---

### Task 8: Галерея чекпоинтов

**Files:**
- Create: `src/main/forge/previews.ts`, `previews.test.ts`, `src/main/ckpt-protocol.ts`, `ckpt-protocol.test.ts`, `src/renderer/components/CheckpointGallery.tsx` (+ css, test)
- Modify: `src/main/storage/repos.ts` (`checkpointMeta`), `src/main/forge/catalog.ts`, `src/main/index.ts`, `src/renderer/index.html` (CSP), `src/shared/types.ts`, `src/shared/ipc.ts`, `PromptBar.tsx`, `tools/mock-forge/server.ts`

**Interfaces:**
- Produces:
  ```ts
  // CheckpointInfo gains: familyOverridden: boolean; previewUrl: string   // 'fnc-ckpt://<serverId>/<encodeURIComponent(title)>'
  export function previewCandidates(modelFilename: string): string[]
  // repos.checkpointMeta: get(serverId, filename), setFamily(serverId, filename, family | null), setPreview(serverId, filename, path | '')
  ```
  Api `checkpoints.setFamily(title: string, family: Family | null): Promise<void>` (null — вернуть автоопределение).

- [ ] **Step 1: Тест `previewCandidates`:** для `D:\models\Stable-diffusion\sdxl\exampleMix_v10.safetensors` → в этом порядке `…\exampleMix_v10.png`, `.preview.png`, `.jpg`, `.preview.jpg`, `.jpeg`, `.preview.jpeg`, `.webp`, `.preview.webp`; работает с `/` и `\`.
- [ ] **Step 2: Тесты протокола (с mock-forge):** первый запрос перебирает кандидатов через `/sd_extra_networks/thumb?filename=` до первого 200, сохраняет найденный путь в `checkpoint_meta.preview_path` и байты в `userData/ckpt-cache/<serverId>/<sha1(title)>.<ext>`; следующий запрос отдаётся из кэша без сети; нет превью → `preview_path = ''`, 404 и повторного перебора нет до `catalog.get(true)`; одновременно не больше 4 запросов к Forge от протокола; Forge недоступен → 404 без записи в мету. CSP: `img-src` += `fnc-ckpt:`.
- [ ] **Step 3: Семейство вручную.** Каталог применяет `checkpoint_meta.family` поверх `detectFamily`; `familyOverridden` выставлен. Смена пишет `settings`-событие (имя файла, было/стало).
- [ ] **Step 4: Renderer.** Окно поверх экрана (Radix Dialog), открывается кнопкой со значком сетки рядом с выбором модели в панели промпта. Сверху фильтр «All, SDXL, Z-Image, Qwen-Image, Lumina, Krea 2, Anima» со счётчиками и поиск по имени (без учёта регистра, по пути с папками); сетка карточек (превью 3:4, имя, семейство, метка «Loaded» для `catalog.loadedCheckpoint` — со значком, не только цветом); виртуализация через `placeItems` из задачи 3 с фиксированной высотой; `loading="lazy"`; карточка без превью — заглушка `--surface-1` с первой буквой имени. Действия карточки: «Use» (как выбор в списке), меню семейства. Клавиатура: стрелки, `Enter` — Use, `Esc`.
- [ ] **Step 5: Тесты renderer:** фильтр и счётчики, поиск, Use закрывает окно и меняет чекпоинт, смена семейства обновляет счётчики.
- [ ] **Step 6: В окне** с mock-forge (превью для части моделей) и, только для чтения, с настоящим Forge (адрес — в implementer-common.md). README, CHANGELOG, commit `feat: checkpoint gallery with previews and family filter`.

---

### Task 9: Стек LoRA

**Files:**
- Create: `src/main/forge/lora-meta.ts`, `lora-meta.test.ts`, `src/renderer/components/LoraStack.tsx`, `LoraPicker.tsx` (+ css, тесты)
- Modify: `src/main/storage/db.ts` (миграция `lora_meta`), `repos.ts`, `catalog.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `ParamsPanel.tsx`, `PromptBar.tsx`, `src/main/ipc/register.ts` (проверка недостающих LoRA)

**Interfaces:**
- Produces:
  ```ts
  export interface LoraInfo { name: string; path: string; triggers: string[]; baseFamily: Family | null }
  // Catalog.loras: LoraInfo[]
  export function triggersFromMetadata(metadata: Record<string, unknown>): string[]   // top-8 by frequency
  export function baseFamilyFromMetadata(metadata: Record<string, unknown>): Family | null
  ```
  Миграция: `lora_meta (server_id INTEGER NOT NULL, path TEXT NOT NULL, triggers TEXT, default_weight REAL, PRIMARY KEY (server_id, path))`. Api `loras.setTriggers(path: string, triggers: string[]): Promise<void>`.

- [ ] **Step 1: Тесты `lora-meta.test.ts`:** `ss_tag_frequency` объектом `{dir: {tag: count}}` и строкой JSON — суммируются по папкам, сортируются по убыванию, не больше 8; отсутствует или мусор → `[]` (Review Focus 4); `ss_base_model_version` / `modelspec.architecture` с `sdxl` → `'sdxl'`, с `flux`/неизвестным → `null`.
- [ ] **Step 2: Каталог** сливает правки из `lora_meta` поверх метаданных.
- [ ] **Step 3: Проверка перед отправкой.** Включённая LoRA, которой нет в `catalog.loras`, попадает в `missing` задачи (`missingParts`) так же, как чекпоинт; выключенные не проверяются. Тест в `register` или runner — там, где сейчас проверка чекпоинта.
- [ ] **Step 4: Renderer.** В боковой панели — «LoRA»: кнопка «Add» открывает `LoraPicker` (поиск по имени, список, Enter добавляет); карточка: имя, `Checkbox` «включена», `Slider` веса −2..2 шаг 0.05 с числом, триггер-слова чипами (щелчок вставляет слово в конец промпта через `, `), «Edit triggers» (TagEditor-подобное поле), предупреждение со значком, если `baseFamily` известен и не совпадает с семейством текущего чекпоинта, удаление из стека. В панели промпта — кнопка «LoRA n» (n — включённые), открывает боковую панель на этом блоке. Не больше 16 LoRA (ограничение валидации из плана 1).
- [ ] **Step 5: Тесты renderer:** добавить, выключить (в `params.loras` с `enabled: false`), вес, щелчок по триггеру, счётчик в панели промпта, предупреждение о семействе.
- [ ] **Step 6: README, CHANGELOG, commit** `feat: LoRA stack with weights and trigger words`.

---

### Task 10: Пресеты настроек

**Files:**
- Create: `src/renderer/components/PresetMenu.tsx`, `SavePresetDialog.tsx` (+ css, тесты)
- Modify: `src/main/storage/db.ts` (миграция `presets`), `repos.ts`, `src/main/ipc/register.ts`, `src/shared/types.ts`, `src/shared/ipc.ts`, `PromptBar.tsx`, `ParamsPanel.tsx`, `store.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PresetParams = Omit<GenerationParams, 'prompt' | 'negativePrompt' | 'seed' | 'count'>
  export interface Preset { id: number; name: string; params: PresetParams; createdAt: number }
  ```
  Миграция `presets (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, params TEXT NOT NULL, created_at INTEGER NOT NULL)`; теги по умолчанию — `params.tags`. Api `presets: { list(); save(name, params: PresetParams); rename(id, name); remove(id); applied(id) }` — `applied` только пишет событие `preset` в журнал. Имя занято → `error.presetNameTaken` (ключ из U3 переиспользуется).

- [ ] **Step 1: Тесты:** сохранение не содержит промпт, негатив, сид и число картинок (проверить ключи JSON); применение заменяет параметры, сохраняя промпт, негатив, сид и число; пресет с чекпоинтом, которого нет на сервере, применяется, карточка модели показывает «Not found» (Review Focus 3); журнал `preset` с именем на создание, применение, переименование, удаление.
- [ ] **Step 2: Реализовать.** Меню пресетов в панели промпта слева от выбора модели (спека: «выбор пресета или чекпоинта»), с прокруткой как у остальных меню; «Save as preset…» внизу боковой панели и в меню; переименование и удаление в меню (удаление с подтверждением).
- [ ] **Step 3: README, CHANGELOG, commit** `feat: settings presets`.

---

### Task 11: Экран журнала

**Files:**
- Create: `src/renderer/components/LogPanel.tsx` (+ css, test)
- Modify: `src/main/oplog/oplog.ts`, `src/main/ipc/register.ts`, `src/main/index.ts`, `src/shared/ipc.ts`, `TopBar.tsx`, `locales/en.ts`

**Interfaces:**
- Consumes: `Oplog.list(OplogFilter)`, `purgeOlderThan(days)` из плана 1.
- Produces: Api `oplog: { list(f: OplogFilter): Promise<OplogEntry[]>; export(f: OplogFilter): Promise<boolean>; retention(): Promise<number>; setRetention(days: number): Promise<void> }`; событие `'oplog:added': OplogEntry`.

- [ ] **Step 1: Тесты main:** `export` пишет JSON Lines текущей выборки в файл из `dialog.showSaveDialog` (диалог внедряется зависимостью); срок хранения в `settings['oplog.retentionDays']`, по умолчанию 90, допустимо 1..3650; при запуске `purgeOlderThan(retention)`; смена пишет `settings`-событие.
- [ ] **Step 2: Тесты renderer:** боковая панель справа (кнопка в TopBar, `Esc` закрывает); строки новые сверху: время (`Intl.DateTimeFormat`), уровень (значок + слово), категория, текст через `t(messageKey, details)`, длительность моноширинным; фильтры уровень, категория, период (1 h, 24 h, 7 d, All), поиск по тексту — по уже переведённому тексту на стороне renderer; новые события приходят живыми; щелчок по событию с `jobId` открывает просмотр картинки этой задачи, если она есть и не скрыта при закрытом замке — иначе ничего; «Export» и поле «Keep for N days».
- [ ] **Step 3: README** (раздел Operation log), CHANGELOG, commit `feat: operation log panel with filters and export`.

---

### Task 12: Сквозная проверка и выпуск 0.2.0

- [ ] **Step 1: e2e** (как в плане 1, на mock-forge, без Electron): задача с тегами → картинка с тегами находится поиском по тегу и по имени LoRA; скрытая картинка при закрытом замке не находится и её файл не отдаётся протоколом; пресет сохраняется и применяется после перезапуска на той же базе.
- [ ] **Step 2: Ручная проверка в окне** (mock-forge и, с согласия пользователя, его Forge): галерея на 300+ картинок, клавиатура по всем клавишам §11, просмотр, выделение, теги, поиск, замок, галерея чекпоинтов на ~480 моделях, LoRA, пресеты, журнал. Окно 1100×700.
- [ ] **Step 3: README** — экраны и возможности 0.2.0; известные ограничения (нет img2img, апскейла, панели ресурсов — план 3).
- [ ] **Step 4 (с пользователем): выпуск.** CHANGELOG `[0.2.0] - <дата>`, версия, тег `v0.2.0` — только после проверки пользователем.
