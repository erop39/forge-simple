import type { ImageQuery } from '@shared/types'

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
    where.push(`(json_extract(jobs.params, '$.prompt') LIKE ? ESCAPE '\\'
      OR json_extract(jobs.params, '$.checkpoint') LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM json_each(jobs.params, '$.loras') WHERE json_extract(value, '$.name') LIKE ? ESCAPE '\\'))`)
    args.push(like, like, like)
  }
  for (const tag of tags) {
    where.push(`EXISTS (SELECT 1 FROM image_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.image_id = images.id AND t.name = ?)`)
    args.push(tag)
  }
  if ((text || tags.length > 0) && !revealHidden) where.push('images.hidden = 0')
  const sql = `SELECT images.* FROM images JOIN jobs ON jobs.id = images.job_id
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY images.id DESC LIMIT ?`
  args.push(q.limit)
  return { sql, args }
}
