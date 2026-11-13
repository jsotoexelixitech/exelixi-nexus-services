/**
 * Llamadas a nest-api para la cotización pagada: tasa BCV, emisión de riesgos generales con prima informada
 * (modo cotizador) y cobro del recibo. Son las rutas que ya usan el cotizador RC y los módulos RCV/funerario/personas.
 * La key de Nexus (NEST_API_KEY) necesita emissions:riesgos-generales, emissions:riesgos-generales-prima y
 * collection:write.
 */
type Obj = Record<string, unknown>;
const esObj = (v: unknown): v is Obj =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export class NestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const base = (): string =>
  (process.env.NEST_API_URL || 'http://127.0.0.1:3002').replace(/\/$/, '');
const key = (): string =>
  process.env.NEST_API_KEY || process.env.NEST_SERVICE_API_KEY || '';

function mensaje(body: unknown, status: number): string {
  const m = esObj(body) ? (body.message ?? body.error) : null;
  return (
    (Array.isArray(m) ? m.join('; ') : typeof m === 'string' ? m : '') ||
    `nest-api HTTP ${status}`
  );
}

async function pedir(
  ruta: string,
  init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
): Promise<Obj> {
  if (!key())
    throw new NestError('NEST_API_KEY no configurada en nexus-api.', 503);
  const res = await fetch(`${base()}${ruta}`, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      apikey: key(),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok || (esObj(body) && body.status === false))
    throw new NestError(mensaje(body, res.status), res.status);
  // nest-api envuelve en { status, data } o { status, result }.
  const o = esObj(body) ? body : {};
  return esObj(o.data) ? o.data : esObj(o.result) ? o.result : o;
}

/** Tasa BCV del dólar para la fecha (Sis2000), la misma con la que Pagos convierte a bolívares. */
export async function tasaBcv(fecha: string): Promise<number> {
  const d = await pedir(
    `/api/v1/moneda/tasa-bcv?fecha=${encodeURIComponent(fecha)}`,
    { method: 'GET', timeoutMs: 20_000 },
  );
  const ptasa = Number(d.ptasa);
  if (!(ptasa > 0))
    throw new NestError('nest-api no devolvió la tasa BCV del día.', 502);
  return ptasa;
}

export interface PolizaEmitida {
  cnpoliza: string;
  cnrecibo: string;
  urlpoliza: string;
}

export async function emitir(body: Obj): Promise<PolizaEmitida> {
  const d = await pedir('/api/v1/riesgos-generales/emision', {
    method: 'POST',
    body,
    timeoutMs: 90_000,
  });
  const cnpoliza = String(d.cnpoliza ?? '').trim();
  if (!cnpoliza)
    throw new NestError('Sis2000 no devolvió el número de póliza.', 502);
  return {
    cnpoliza,
    cnrecibo: String(d.cnrecibo ?? '').trim(),
    urlpoliza: String(d.urlpoliza ?? '').trim(),
  };
}

/** Cobro del recibo con el pago verificado (spCobroSis_Ad + soporte): deja el recibo pagado y genera el ingreso de caja. */
export async function cobrarRecibo(
  body: Obj,
): Promise<{ ingresoCaja: string | null; transaccion: unknown }> {
  const d = await pedir('/api/v1/external/collection/activate', {
    method: 'POST',
    body,
    timeoutMs: 90_000,
  });
  const cobro = esObj(d.cobro) ? d.cobro : {};
  return {
    ingresoCaja: d.ingresoCaja ? String(d.ingresoCaja) : null,
    transaccion: cobro.transaccion ?? null,
  };
}
