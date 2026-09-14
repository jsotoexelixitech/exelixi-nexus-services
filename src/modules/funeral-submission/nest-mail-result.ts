/**
 * nest-api envuelve el body: { status: true, data: { sent, success, error } }.
 * Sin esto, un correo que sí salió queda como "no enviado" en mesa técnica.
 */
export function nestMailAccepted(
  res: { ok: boolean; status: number },
  body: unknown,
): { sent: boolean; error?: string } {
  const rec =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const inner =
    rec.data && typeof rec.data === 'object'
      ? (rec.data as Record<string, unknown>)
      : rec;
  const sent =
    inner.sent === true || rec.sent === true || inner.success === true;
  if (res.ok && sent) return { sent: true };
  const err =
    (typeof inner.error === 'string' && inner.error) ||
    (typeof rec.error === 'string' && rec.error) ||
    (typeof rec.message === 'string' && rec.message) ||
    `HTTP ${res.status}`;
  return { sent: false, error: err };
}
