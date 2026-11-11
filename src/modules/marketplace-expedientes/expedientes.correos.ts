/**
 * v1.4 (11-nov-2026): destinatarios de los avisos al cliente. La Mundial pidió que lleguen al
 * tomador Y al asegurado/titular. Reglas puras, sin BD:
 * - `aseguradoEmail` (columna) sigue siendo el correo principal (el de siempre: el del titular o,
 *   si la emisión no lo traía, el del tomador).
 * - Los demás van en `snapshot.correos` (JSON, sin migración). Si la clave existe, ya se resolvió
 *   (aunque esté vacía); si no existe, es un expediente anterior y se busca en la cotización del wizard.
 * El código de verificación del acceso por cédula NO usa esto: va solo al correo principal.
 */
import { emailValido } from './expedientes.domain';

const MAX_CORREOS = 10;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Válidos, en minúsculas y sin repetidos, en el orden recibido (máx. 10). */
export function unirCorreos(valores: unknown[]): string[] {
  const out: string[] = [];
  for (const v of valores) {
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (emailValido(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_CORREOS) break;
  }
  return out;
}

/** `snapshot.correos` si la emisión (v1.4) o una resolución anterior lo dejó; null si no existe. */
export function correosDelSnapshot(snapshot: unknown): string[] | null {
  const c = rec(snapshot).correos;
  return Array.isArray(c) ? unirCorreos(c) : null;
}

/** Todos los destinatarios conocidos del expediente: el principal primero. */
export function correosDe(e: {
  aseguradoEmail?: string | null;
  snapshot?: unknown;
}): string[] {
  return unirCorreos([
    e.aseguradoEmail,
    ...(correosDelSnapshot(e.snapshot) ?? []),
  ]);
}

/**
 * Expedientes sin correo (registrados antes de v1.4 o sin el bloque `expediente`): correos del estado
 * del wizard guardado en la cotización (`cotizacion_json_data`) o en la mesa técnica
 * (`funeral_submission.snapshot_json`, también bajo `data`): tomador, asegurado si es otra persona
 * (RCV) y titular (personas, 1er asegurado).
 * `principal` = la misma regla de Emisión para `asegurado.email`: el del titular o, si no lo trae,
 * el del tomador.
 */
export function contactosDeWizard(jsonData: unknown): {
  principal: string | null;
  correos: string[];
} {
  const raiz = rec(jsonData);
  const jd = Object.keys(rec(raiz.tomador)).length ? raiz : rec(raiz.data);
  const asegurados = rec(jd.funeral).asegurados;
  const aseg0 = Array.isArray(asegurados) ? asegurados[0] : null;
  const tomador = unirCorreos([rec(jd.tomador).email])[0] ?? null;
  const asegurado =
    jd.sameInsured === false
      ? (unirCorreos([rec(jd.asegurado).email])[0] ?? null)
      : null;
  const titular = unirCorreos([rec(aseg0).email])[0] ?? null;
  return {
    principal: titular ?? asegurado ?? tomador,
    correos: unirCorreos([tomador, asegurado, titular]),
  };
}

export function correosDeCotizacion(jsonData: unknown): string[] {
  return contactosDeWizard(jsonData).correos;
}
