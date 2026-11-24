/**
 * Por qué sigue incompleta una póliza (reglas puras, sin BD). Cada expediente INCOMPLETO cae
 * en UNA sola categoría, por prioridad, para que el resumen sume: la suma del desglose es igual
 * a `incompletos` (los contadores «con algún documento en X» se pisan entre sí y no suman).
 *
 * Prioridad (la primera que aplica gana), mirando solo los requisitos aplicables al producto:
 * 1. conErrores       algún documento observado que NO es por datos cambiados
 *                     (no coincide, ilegible, sin certeza u observado a mano)
 * 2. datosCambiados   observado solo porque los datos se cambiaron en el formulario
 * 3. noLeidos         recibido y el OCR no pudo leerlo (error técnico vigente; validación automática)
 * 4. porValidar       recibido que espera a un analista: validación manual, o en automática sin
 *                     archivo para la IA o con decisión manual
 * 5. analizando       recibido con archivo que la IA está revisando (validación automática)
 * 6. faltanDocumentos solo le faltan documentos por enviar
 * 7. otros            cualquier caso no previsto (estado guardado desactualizado); debería ser 0
 */
import { ExpedientesConfig, requisitosAplicables } from './expedientes.domain';
import { conDatosModificados, diagnosticoVigente } from './expedientes.ia';

/** En orden de prioridad. */
export const CATEGORIAS_INCOMPLETO = [
  'conErrores',
  'datosCambiados',
  'noLeidos',
  'porValidar',
  'analizando',
  'faltanDocumentos',
  'otros',
] as const;
export type CategoriaIncompleto = (typeof CATEGORIAS_INCOMPLETO)[number];
export type DesgloseIncompletos = Record<CategoriaIncompleto, number>;

export interface RequisitoCategoria {
  tipo: string;
  estado: string;
  ref?: string | null;
  decision?: string | null;
  diagnostico?: unknown;
  analisisRef?: string | null;
}

/** Categoría del expediente incompleto; `null` si el expediente no está incompleto. */
export function categoriaIncompleto(
  exp: { producto: string; estadoDocumental: string },
  reqs: RequisitoCategoria[],
  config: ExpedientesConfig,
): CategoriaIncompleto | null {
  if (exp.estadoDocumental !== 'incompleto') return null;
  const porTipo = new Map(reqs.map((r) => [r.tipo, r]));
  // Igual que calcularEstadoDocumental: el requisito aplicable sin fila cuenta como faltante.
  const aplicables: RequisitoCategoria[] = requisitosAplicables(
    exp.producto,
    config,
  ).map((tipo) => porTipo.get(tipo) ?? { tipo, estado: 'faltante' });

  const observados = aplicables.filter((r) => r.estado === 'observado');
  if (observados.some((r) => !conDatosModificados(r))) return 'conErrores';
  if (observados.length) return 'datosCambiados';

  const recibidos = aplicables.filter((r) => r.estado === 'recibido');
  if (recibidos.length) {
    if (config.validacion !== 'automatica') return 'porValidar';
    // La IA solo analiza lo que tiene archivo y no tiene decisión manual.
    const enIa = recibidos.filter((r) => !!r.ref && r.decision !== 'manual');
    if (enIa.some((r) => diagnosticoVigente(r)?.resultado === 'error_tecnico'))
      return 'noLeidos';
    if (enIa.length < recibidos.length) return 'porValidar';
    return 'analizando';
  }

  if (aplicables.some((r) => r.estado === 'faltante'))
    return 'faltanDocumentos';
  return 'otros';
}

export function desgloseVacio(): DesgloseIncompletos {
  return Object.fromEntries(
    CATEGORIAS_INCOMPLETO.map((c) => [c, 0]),
  ) as DesgloseIncompletos;
}

/** Cuenta los expedientes incompletos por categoría: la suma es el número de incompletos. */
export function desgloseIncompletos<
  E extends { id: number; producto: string; estadoDocumental: string },
>(
  exps: E[],
  reqsDe: (e: E) => RequisitoCategoria[],
  config: ExpedientesConfig,
): DesgloseIncompletos {
  const desglose = desgloseVacio();
  for (const e of exps) {
    const c = categoriaIncompleto(e, reqsDe(e), config);
    if (c) desglose[c]++;
  }
  return desglose;
}
