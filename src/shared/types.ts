export type Family = 'sdxl' | 'zimage' | 'qwen' | 'lumina' | 'krea2' | 'anima';
export type JobType = 'txt2img' | 'img2img' | 'upscale';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
export interface LoraRef { name: string; weight: number; enabled: boolean }
export interface HiresSettings {
  scale: 1 | 1.5 | 2 | 4;
  upscaler: string;
  secondPassSteps: number;
  denoisingStrength: number;
  /** Second-pass CFG (hr_cfg, or hr_distilled_cfg for distilled families); absent = the first pass value. */
  cfgScale?: number;
}
export interface Img2ImgSettings {
  sourceImageId: number;
  denoisingStrength: number;
  /** Forge resize_mode: resize, crop, fill, or latent upscale. */
  resizeMode: 0 | 1 | 2 | 3;
}
export interface UpscaleSettings {
  sourceImageId: number;
  upscaler: string;
  scale: 1.5 | 2 | 4;
}
export interface GenerationParams {
  family: Family;
  checkpoint: string;          // поле title из /sd-models
  modules: string[];           // имена или пути, см. FINDINGS.modulesAs
  prompt: string;
  negativePrompt: string;
  width: number; height: number;
  steps: number;
  cfgScale: number;
  distilledCfg: number;
  shift: number | null;
  clipSkip: number | null;
  sampler: string; scheduler: string;
  seed: number;                // -1 = случайный
  count: number;               // сколько задач создать, 1..8
  loras: LoraRef[];
  /** Optional so jobs saved before hires fix remain valid. Scale 1 means Off. */
  hires?: HiresSettings;
  /** Optional for old txt2img jobs. Image bytes are never persisted with job params. */
  img2img?: Img2ImgSettings;
  /** A finished image to upscale; the source bytes stay in the managed image store. */
  upscale?: UpscaleSettings;
}
export type JobErrorCode = 'missingParts' | 'forgeHttp' | 'forgeInvalid' | 'noImages' | 'storage' | 'network' | 'stopped' | 'corruptJob' | 'sourceMissing' | 'sourceLocked' | 'sourceCorrupt' | 'sizeLimit' | 'unexpected';
/** detail carries server or system text for txt2img only; source-image jobs omit arbitrary Forge text. */
export interface JobError { code: JobErrorCode; status?: number; detail?: string; missing?: string[] }
export interface Job {
  id: number; serverId: number; type: JobType; status: JobStatus;
  params: GenerationParams; error: JobError | null;
  createdAt: number; finishedAt: number | null;
  durationMs: number | null; stepsPerSec: number | null; peakVram: number | null;
}
export interface ImageRecord {
  id: number; jobId: number; url: string; thumbUrl: string;   // fnc-img://…
  width: number; height: number; seed: number; infotext: string;
  createdAt: number; durationMs: number | null; hidden: boolean; sourceImageId: number | null;
  tags: string[];
  /** The image came out of a hires second pass or an upscale (the HD badge). */
  enhanced?: boolean;
  /** Hidden image while hidden images are locked: url, thumbUrl, infotext are empty, seed and jobId are 0, tags are empty. */
  locked: boolean;
}
/** Gallery query: newest first; `text` and every tag in `tags` must match. */
export interface ImageQuery { limit: number; beforeId?: number; text?: string; tags?: string[] }
/** Saved image with the exact settings from its generation job. */
export interface ImageDetails { image: ImageRecord; params: GenerationParams; jobType: JobType }
export interface JobProgress {
  jobId: number; step: number; totalSteps: number;
  stage: 'sampling' | 'hires' | 'upscaling';
  stepsPerSec: number | null; elapsedMs: number; preview: string | null; // data URL
}
export type ConnectionState = 'connected' | 'slow' | 'reconnecting' | 'offline';
export interface ConnectionStatus { state: ConnectionState; latencyMs: number | null; attempts: number; lastOkAt: number | null }
export interface MemoryMetrics {
  ramUsed: number | null; ramTotal: number | null
  vramUsed: number | null; vramTotal: number | null
  allocated: number | null; reserved: number | null; vramPeak: number | null; oom: number | null
}
export interface ForgeStats {
  version: string | null; forgeVersion: string | null; torchVersion: string | null
  cpuPercent: number | null; ramUsed: number | null; ramTotal: number | null
  gpuName: string | null; gpuUtilization: number | null; gpuTemperature: number | null
  gpuFanPercent: number | null; gpuPowerWatts: number | null; gpuPowerLimitWatts: number | null
  gpuVramUsed: number | null; gpuVramTotal: number | null
}
export interface ResourceSample { time: number; memory: MemoryMetrics; stats: ForgeStats | null }
export interface ResourceSnapshot { samples: ResourceSample[]; failed: boolean; extension: 'unknown' | 'available' | 'absent' }
export const OPLOG_LEVELS = ['info', 'warn', 'error'] as const
export type OplogLevel = (typeof OPLOG_LEVELS)[number];
export const OPLOG_CATEGORIES = [
  'app', 'connection', 'catalog', 'checkpoint', 'queue', 'generation',
  'preset', 'settings', 'storage', 'error', 'lock', 'resources', 'server', 'backup',
] as const
export type OplogCategory = (typeof OPLOG_CATEGORIES)[number];
export interface OplogEntry {
  id: number; time: number; level: OplogLevel; category: OplogCategory;
  messageKey: string; durationMs: number | null; jobId: number | null; details: Record<string, unknown>;
}

/** What Civitai knows about a file (looked up by its SHA-256 on request). */
export interface CivitaiInfo {
  modelId: number; versionId: number; name: string; versionName: string; baseModel: string
  trainedWords: string[]; imageUrl: string | null; checkedAt: number
  /** When the version was published on Civitai (ms); null when it did not say. Absent in answers stored before 2026-10-16. */
  publishedAt?: number | null
}
export interface CivitaiProgress { running: boolean; done: number; total: number; found: number; paused: boolean }
export type ModelKind = 'checkpoint' | 'lora'
export interface CheckpointInfo {
  title: string; name: string; filename: string; family: Family
  /** Forge's short and full hashes; null when the server did not report them. */
  hash?: string | null; sha256?: string | null
  /** The family was set by hand rather than detected from the name. */
  familyOverridden?: boolean
  favorite?: boolean; note?: string
  /** Page of this file on Civitai once it was looked up and found. */
  civitai?: { url: string; name: string; baseModel: string } | null
  /** fnc-model://… ; answers 404 when Forge has no preview for it. */
  previewUrl?: string
  /** For sorting: when the app first saw the file (ms; null: it was there before the app looked), the Civitai release date, and how often it was used. */
  addedAt?: number | null; releasedAt?: number | null; uses?: number; lastUsedAt?: number | null
  /** Trigger words: the user's own list, else Civitai's (checkpoints have none in the file). */
  triggers?: string[]; triggersEdited?: boolean
}
export interface LoraInfo {
  name: string; alias?: string; path: string
  /** The family its training metadata names; null when unknown or not one of ours. */
  hash?: string | null
  baseFamily?: Family | null
  /** Trigger words: the user's own list when set, else the most frequent training tags. */
  triggers?: string[]
  triggersEdited?: boolean
  favorite?: boolean; note?: string; previewUrl?: string
  civitai?: { url: string; name: string; baseModel: string } | null
  addedAt?: number | null; releasedAt?: number | null; uses?: number; lastUsedAt?: number | null
}
export interface ModuleInfo { name: string; filename: string }
export interface Catalog { checkpoints: CheckpointInfo[]; modules: ModuleInfo[]; loras: LoraInfo[];
  samplers: string[]; schedulers: string[]; upscalers: string[]; loadedCheckpoint: string | null; fetchedAt: number
  /** Per-preset default module lists from the server's options (full paths). */
  familyModules: Partial<Record<Family, string[]>> }
export interface PartStatus { role: 'model' | 'module' | 'upscaler' | 'lora'; value: string; found: boolean }
/** A saved Forge server as the renderer sees it. Exactly one (or none) is active. */
export interface ServerInfo { id: number; name: string; url: string; active: boolean }
/** A saved negative prompt; its text replaces the Negative field when applied. */
export interface NegativePreset { id: number; name: string; text: string; createdAt: number }
/** A saved second pass: scale, upscaler, steps, denoising and CFG to apply together. */
export interface HiresPreset { id: number; name: string; settings: HiresSettings; createdAt: number }
/** What the active Forge allows: restart needs it to run with --api-server-stop. */
export interface ForgeCapabilities { canRestart: boolean }
/** Unhealthy: generations failed with HTTP 500 several times in a row; a restart is advised. */
export interface ForgeHealth { unhealthy: boolean }
/**
 * Result of a restart request. `restarting`: Forge accepted (or dropped the connection while exiting).
 * `notAllowed`: Forge runs without --api-server-stop. `notRestartable`: its launcher cannot restart it.
 */
export type RestartOutcome = 'restarting' | 'notAllowed' | 'notRestartable'
/** Which log entries to list or export; newest first. Text search happens in the renderer on the shown text. */
export interface OplogQuery {
  level?: OplogLevel; category?: OplogCategory; from?: number; limit?: number
  /** Only these entries (the panel's search results, for export). */
  ids?: number[]
}
/** The session lock over hidden images: whether a password is set and whether hidden images are shown now. */
export interface LockState { hasPassword: boolean; open: boolean }
