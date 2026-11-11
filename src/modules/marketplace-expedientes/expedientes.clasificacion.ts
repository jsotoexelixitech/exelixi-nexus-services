/**
 * Qué le falta al cliente en un expediente incompleto (reglas puras, sin BD). Lo usan los
 * recordatorios y la puesta en marcha (11-nov-2026):
 * - faltan_documentos: algún requisito aplicable sin cargar (faltante).
 * - corregir: algún documento observado que el cliente debe reenviar (no coincide, ilegible,
 *   sin certeza o «no se pudo leer», o una observación manual del administrador).
 * - ambos: las dos cosas.
 * - solo_datos_modificados: lo único observado es «datos_modificados» (el dato se cambió en el
 *   formulario; lo revisa el equipo, no es culpa del cliente). No se le envía correo solo por eso.
 * - solo_en_revision: todo lo pendiente ya está cargado y espera revisión; no hay nada que pedir.
 */
import type { MktExpedienteRequisito } from '@prisma/client';
import { ExpedientesConfig, requisitosAplicables } from './expedientes.domain';
import { conDatosModificados } from './expedientes.ia';

export type MotivoSolicitud = 'faltan_documentos' | 'corregir' | 'ambos';
export type ClasificacionExpediente =
  | MotivoSolicitud
  | 'solo_datos_modificados'
  | 'solo_en_revision';

type ReqClasificable = Pick<
  MktExpedienteRequisito,
  'tipo' | 'estado' | 'decision' | 'diagnostico' | 'analisisRef' | 'ref'
>;

export function clasificarExpediente(
  producto: string,
  reqs: ReqClasificable[],
  config: ExpedientesConfig,
): ClasificacionExpediente {
  const porTipo = new Map(reqs.map((r) => [r.tipo, r]));
  let faltan = false;
  let corregir = false;
  let datosModificados = false;
  for (const tipo of requisitosAplicables(producto, config)) {
    const r = porTipo.get(tipo);
    const estado = r?.estado ?? 'faltante';
    if (estado === 'faltante') faltan = true;
    else if (estado === 'observado') {
      // La decisión manual del administrador prevalece: si lo observó, el cliente debe corregir.
      if (r && r.decision !== 'manual' && conDatosModificados(r))
        datosModificados = true;
      else corregir = true;
    }
  }
  if (faltan && corregir) return 'ambos';
  if (faltan) return 'faltan_documentos';
  if (corregir) return 'corregir';
  if (datosModificados) return 'solo_datos_modificados';
  return 'solo_en_revision';
}

/** ¿Hay algo que pedirle al cliente? */
export function hayQuePedirAlCliente(c: ClasificacionExpediente): boolean {
  return c === 'faltan_documentos' || c === 'corregir' || c === 'ambos';
}
