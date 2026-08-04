export function one<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

export async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results;
}

export const id = () => crypto.randomUUID();

export function orderNo(): string {
  const date = new Date();
  const day = date.toISOString().slice(0, 10).replaceAll('-', '');
  return `MC-${day}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export function caseNo(): string {
  const token = crypto.randomUUID().replaceAll('-', '').toUpperCase();
  return `CAS-${token.slice(0, 5)}-${token.slice(5, 10)}`;
}

export async function audit(
  db: D1Database,
  input: { actorId: string; action: string; entityType: string; entityId: string; requestId: string; before?: unknown; after?: unknown }
): Promise<void> {
  await db.prepare(`INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, before_json, after_json, request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id(), input.actorId, input.action, input.entityType, input.entityId,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      input.requestId)
    .run();
}
