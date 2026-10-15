import type { ImageQuery } from '@shared/types'

/** 1 when the image's job was an upscale or ran a hires second pass. */
export const ENHANCED_SQL = `(SELECT CASE WHEN j.type = 'upscale' OR COALESCE(json_extract(j.params, '$.hires.scale'), 1) > 1 THEN 1 ELSE 0 END
  FROM jobs j WHERE j.id = images.job_id) AS enhanced`

/** Escapes LIKE wildcards so user text matches literally (pair with ESCAPE '\'). */
export const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&')

/**
 * SQL for one gallery page, newest first. Text matches the job's prompt, checkpoint or any LoRA name;
 * every tag must be attached. Hidden images are left out of filtered results unless `revealHidden`.
 */
export function buildImageQuery(q: ImageQuery, revealHidden: boolean): { sql: string; args: unknown[] } {
  const where: string[] = []
  const args: unknown[] = []
  const text = q.text?.trim()
  const tags = q.tags ?? []
  if (q.beforeId !== undefined) {
    where.push('images.id < ?')
    args.push(q.beforeId)
  }
  if (text) {
    const like = `%${escapeLike(text)}%`
    // ulower (registered in db.ts) folds case beyond ASCII, which LIKE alone does not.
    where.push(`(ulower(json_extract(jobs.params, '$.prompt')) LIKE ulower(?) ESCAPE '\\'
      OR ulower(json_extract(jobs.params, '$.checkpoint')) LIKE ulower(?) ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM json_each(jobs.params, '$.loras')
        WHERE ulower(json_extract(value, '$.name')) LIKE ulower(?) ESCAPE '\\'))`)
    args.push(like, like, like)
  }
  for (const tag of tags) {
    where.push(`EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.image_id = images.id AND ulower(t.name) = ulower(?))`)
    args.push(tag)
  }
  if ((text || tags.length > 0) && !revealHidden) where.push('images.hidden = 0')
  const sql = `SELECT images.*, ${ENHANCED_SQL} FROM images JOIN jobs ON jobs.id = images.job_id
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY images.id DESC LIMIT ?`
  args.push(q.limit)
  return { sql, args }
}
