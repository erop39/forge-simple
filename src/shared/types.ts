export type Family = 'sdxl' | 'zimage' | 'qwen' | 'lumina' | 'krea2' | 'anima';
export type JobType = 'txt2img' | 'img2img' | 'upscale';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
export interface LoraRef { name: string; weight: number; enabled: boolean }
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
}
export type JobErrorCode = 'missingParts' | 'forgeHttp' | 'forgeInvalid' | 'noImages' | 'storage' | 'network' | 'stopped' | 'corruptJob' | 'unexpected';
/** detail carries server or system text verbatim; missing carries the unavailable file values. */
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
  /** Hidden image while hidden images are locked: url, thumbUrl, infotext are empty, seed is 0, tags are empty. */
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

export interface CheckpointInfo { title: string; name: string; filename: string; family: Family }
export interface ModuleInfo { name: string; filename: string }
export interface Catalog { checkpoints: CheckpointInfo[]; modules: ModuleInfo[]; loras: { name: string; path: string }[];
  samplers: string[]; schedulers: string[]; upscalers: string[]; loadedCheckpoint: string | null; fetchedAt: number
  /** Per-preset default module lists from the server's options (full paths). */
  familyModules: Partial<Record<Family, string[]>> }
export interface PartStatus { role: 'model' | 'module'; value: string; found: boolean }
/** A saved Forge server as the renderer sees it. Exactly one (or none) is active. */
export interface ServerInfo { id: number; name: string; url: string; active: boolean }
/** A saved negative prompt; its text replaces the Negative field when applied. */
export interface NegativePreset { id: number; name: string; text: string; createdAt: number }
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
