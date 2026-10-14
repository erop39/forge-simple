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
}
/** Saved image with the exact settings from its generation job. */
export interface ImageDetails { image: ImageRecord; params: GenerationParams; jobType: JobType }
export interface JobProgress {
  jobId: number; step: number; totalSteps: number;
  stage: 'sampling' | 'hires' | 'upscaling';
  stepsPerSec: number | null; elapsedMs: number; preview: string | null; // data URL
}
export type ConnectionState = 'connected' | 'slow' | 'reconnecting' | 'offline';
export interface ConnectionStatus { state: ConnectionState; latencyMs: number | null; attempts: number; lastOkAt: number | null }
export type OplogLevel = 'info' | 'warn' | 'error';
export type OplogCategory = 'app' | 'connection' | 'catalog' | 'checkpoint' | 'queue' | 'generation'
  | 'preset' | 'settings' | 'storage' | 'error' | 'lock' | 'resources' | 'server' | 'backup';
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
