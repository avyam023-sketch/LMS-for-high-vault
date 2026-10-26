import { query } from '../db/pool.js';

export async function audit(req, action, { entity = null, entityId = null, meta = {}, actorId } = {}) {
  try {
    await query(
      'INSERT INTO audit_log (actor_id, action, entity, entity_id, meta, ip) VALUES ($1, $2, $3, $4, $5, $6)',
      [actorId ?? req?.user?.id ?? null, action, entity, entityId == null ? null : String(entityId), meta, req?.ip ?? null],
    );
  } catch (err) {
    console.error('audit log write failed', err);
  }
}
