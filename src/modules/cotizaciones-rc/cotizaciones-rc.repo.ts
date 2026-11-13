/**
 * Acceso a cotizacion_rc con SQL directo: los cambios de estado son reclamos atómicos (UPDATE … WHERE estado = …
 * RETURNING) para que un pago notificado dos veces no emita dos pólizas.
 */
import prisma from '../../config/prisma';
import {
  DIAS_VIGENCIA,
  generarCodigo,
  type CotizacionNueva,
  type FilaCotizacion,
  type RegistroPago,
} from './cotizaciones-rc.domain';

const json = (v: unknown): string => JSON.stringify(v ?? null);

export async function crear(
  c: CotizacionNueva,
  ahora: Date = new Date(),
): Promise<FilaCotizacion> {
  const [{ id }] = await prisma.$queryRaw<{ id: number }[]>`
    SELECT nextval(pg_get_serial_sequence('cotizacion_rc', 'crc_id'))::int AS id`;
  const codigo = generarCodigo(c.producto, ahora.getFullYear(), id);
  const rows = await prisma.$queryRaw<FilaCotizacion[]>`
    INSERT INTO cotizacion_rc
      (crc_id, crc_codigo, crc_producto, crc_origen, crc_tomador_nombre, crc_tomador_documento, crc_tomador_correo,
       crc_moneda, crc_datos, crc_expira_en)
    VALUES
      (${id}, ${codigo}, ${c.producto}, ${c.origen}, ${c.tomadorNombre}, ${c.tomadorDocumento}, ${c.tomadorCorreo},
       ${c.moneda}, ${json(c.datos)}::jsonb, CURRENT_TIMESTAMP + make_interval(days => ${DIAS_VIGENCIA}::int))
    RETURNING crc_id AS id, crc_codigo AS codigo, crc_producto AS producto, crc_estado AS estado, crc_origen AS origen,
      crc_tomador_nombre AS "tomadorNombre", crc_tomador_documento AS "tomadorDocumento",
      crc_tomador_correo AS "tomadorCorreo", crc_moneda AS moneda, crc_opcion AS opcion, crc_datos AS datos,
      crc_pago AS pago, crc_poliza AS poliza, crc_error AS error, crc_correo_poliza AS "correoPoliza", crc_expira_en AS "expiraEn",
      crc_created_at AS "createdAt", crc_updated_at AS "updatedAt"`;
  return rows[0];
}

export async function porCodigo(
  codigo: string,
): Promise<FilaCotizacion | null> {
  const rows = await prisma.$queryRaw<FilaCotizacion[]>`
    SELECT crc_id AS id, crc_codigo AS codigo, crc_producto AS producto, crc_estado AS estado, crc_origen AS origen,
      crc_tomador_nombre AS "tomadorNombre", crc_tomador_documento AS "tomadorDocumento",
      crc_tomador_correo AS "tomadorCorreo", crc_moneda AS moneda, crc_opcion AS opcion, crc_datos AS datos,
      crc_pago AS pago, crc_poliza AS poliza, crc_error AS error, crc_correo_poliza AS "correoPoliza", crc_expira_en AS "expiraEn",
      crc_created_at AS "createdAt", crc_updated_at AS "updatedAt"
    FROM cotizacion_rc WHERE crc_codigo = ${codigo} LIMIT 1`;
  return rows[0] ?? null;
}

export interface FiltroLista {
  codigo: string | null;
  texto: string | null;
  estado: string | null;
  /** vigentes (por defecto) | vencidas (pasaron los 15 días sin pagarse) | todas (historial completo). */
  vigencia: 'vigentes' | 'vencidas' | 'todas';
  desde: string | null;
  hasta: string | null;
}

/**
 * Búsqueda del admin sobre todo el historial (el registro no se borra). Una pagada o emitida nunca cuenta como
 * vencida: los 15 días solo cierran el acceso y el pago del cliente. Sin el JSON completo.
 */
export async function listar(f: FiltroLista): Promise<FilaCotizacion[]> {
  return prisma.$queryRaw<FilaCotizacion[]>`
    SELECT crc_id AS id, crc_codigo AS codigo, crc_producto AS producto, crc_estado AS estado, crc_origen AS origen,
      crc_tomador_nombre AS "tomadorNombre", crc_tomador_documento AS "tomadorDocumento",
      crc_tomador_correo AS "tomadorCorreo", crc_moneda AS moneda, crc_opcion AS opcion, NULL::jsonb AS datos,
      crc_pago AS pago, crc_poliza AS poliza, crc_error AS error, crc_correo_poliza AS "correoPoliza", crc_expira_en AS "expiraEn",
      crc_created_at AS "createdAt", crc_updated_at AS "updatedAt"
    FROM cotizacion_rc
    WHERE (${f.vigencia}::text = 'todas'
           OR (${f.vigencia}::text = 'vencidas'
               AND crc_expira_en <= CURRENT_TIMESTAMP AND crc_estado IN ('cotizada', 'pendiente_pago'))
           OR (${f.vigencia}::text = 'vigentes'
               AND (crc_expira_en > CURRENT_TIMESTAMP OR crc_estado IN ('pagada', 'emitida'))))
      AND (${f.codigo}::text IS NULL OR crc_codigo ILIKE '%' || ${f.codigo}::text || '%')
      AND (${f.texto}::text IS NULL OR crc_tomador_nombre ILIKE '%' || ${f.texto}::text || '%'
           OR crc_tomador_documento ILIKE '%' || ${f.texto}::text || '%')
      AND (${f.estado}::text IS NULL OR crc_estado = ${f.estado}::text)
      AND (${f.desde}::text IS NULL OR crc_created_at >= (${f.desde}::text)::date)
      AND (${f.hasta}::text IS NULL OR crc_created_at < (${f.hasta}::text)::date + 1)
    ORDER BY crc_created_at DESC
    LIMIT 200`;
}

/** Deja la cotización esperando el pago, con los intentos de checkout vigentes. */
export async function guardarCheckout(
  codigo: string,
  opcion: string,
  pago: unknown,
): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE cotizacion_rc
    SET crc_estado = 'pendiente_pago', crc_opcion = ${opcion}, crc_pago = ${json(pago)}::jsonb,
        crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado IN ('cotizada', 'pendiente_pago')`;
  return n > 0;
}

/** Reclamo atómico del pago: solo una notificación pasa de pendiente_pago a pagada. */
export async function marcarPagada(
  codigo: string,
  opcion: string,
  pagado: unknown,
): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE cotizacion_rc
    SET crc_estado = 'pagada', crc_opcion = ${opcion},
        crc_pago = COALESCE(crc_pago, '{}'::jsonb) || jsonb_build_object('pagado', ${json(pagado)}::jsonb),
        crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado = 'pendiente_pago' AND (crc_pago -> 'canal') IS NULL`;
  return n > 0;
}

/** ¿La referencia ya pagó otra cotización? */
export async function referenciaUsada(
  referencia: string,
  codigo: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM cotizacion_rc
    WHERE crc_codigo <> ${codigo} AND crc_pago -> 'pagado' ->> 'referencia' = ${referencia}`;
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Reclamo atómico de la emisión de una cotización pagada sin póliza o con la emisión a medias (varias pólizas y
 * alguna sin emitir: crc_poliza.parcial). Se libera solo a los 5 minutos.
 */
export async function reclamarEmision(codigo: string): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE cotizacion_rc SET crc_emitiendo_en = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado = 'pagada'
      AND (crc_poliza IS NULL OR crc_poliza ->> 'parcial' = 'true')
      AND (crc_emitiendo_en IS NULL OR crc_emitiendo_en < CURRENT_TIMESTAMP - interval '5 minutes')`;
  return n > 0;
}

/**
 * Pólizas ya emitidas de una cotización pagada que aún no las tiene todas (RCP + RCE): se guardan al salir cada
 * una para que un reintento no la vuelva a emitir. La cotización sigue pagada hasta guardarPoliza.
 */
export async function guardarPolizaParcial(
  codigo: string,
  poliza: unknown,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cotizacion_rc SET crc_poliza = ${json(poliza)}::jsonb, crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado = 'pagada'`;
}

export async function guardarPoliza(
  codigo: string,
  poliza: unknown,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cotizacion_rc
    SET crc_estado = 'emitida', crc_poliza = ${json(poliza)}::jsonb, crc_error = NULL, crc_emitiendo_en = NULL,
        crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo}`;
}

export async function guardarError(
  codigo: string,
  error: string,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cotizacion_rc SET crc_error = ${error.slice(0, 2000)}, crc_emitiendo_en = NULL, crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo}`;
}

/** Emisión hecha desde el cotizador (admin, recibo pendiente): solo si la cotización no está pagada ni emitida. */
export async function marcarEmitidaPendiente(
  codigo: string,
  opcion: string | null,
  poliza: unknown,
): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE cotizacion_rc
    SET crc_estado = 'emitida', crc_opcion = COALESCE(${opcion}, crc_opcion), crc_poliza = ${json(poliza)}::jsonb,
        crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado IN ('cotizada', 'pendiente_pago')`;
  return n > 0;
}

/**
 * Reclamo atómico de la emisión sin pago del canal («emitir como pendiente»): solo una cotización sin pago
 * confirmado, vigente y sin póliza, o con la emisión del canal a medias de esa misma opción. Deja la marca
 * crc_pago.canal (cierra el pago en línea) y se libera solo a los 5 minutos.
 */
export async function reclamarEmisionCanal(
  codigo: string,
  opcion: string,
  ahoraIso: string,
): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE cotizacion_rc
    SET crc_emitiendo_en = CURRENT_TIMESTAMP, crc_opcion = ${opcion}, crc_error = NULL,
        crc_pago = (CASE WHEN jsonb_typeof(crc_pago) = 'object' THEN crc_pago ELSE '{}'::jsonb END)
          || jsonb_build_object('canal', jsonb_build_object('opcion', ${opcion}::text, 'reclamadoEn', ${ahoraIso}::text)),
        crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado IN ('cotizada', 'pendiente_pago')
      AND (crc_pago -> 'pagado') IS NULL
      AND ((crc_poliza IS NULL AND crc_expira_en > CURRENT_TIMESTAMP)
           OR (crc_poliza ->> 'parcial' = 'true' AND crc_pago -> 'canal' ->> 'opcion' = ${opcion}::text))
      AND (crc_emitiendo_en IS NULL OR crc_emitiendo_en < CURRENT_TIMESTAMP - interval '5 minutes')`;
  return n > 0;
}

/** Pólizas ya emitidas por el canal de una cotización que aún no las tiene todas (RCP + RCE). */
export async function guardarPolizaParcialCanal(
  codigo: string,
  poliza: unknown,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cotizacion_rc SET crc_poliza = ${json(poliza)}::jsonb, crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado IN ('cotizada', 'pendiente_pago') AND (crc_pago -> 'canal') IS NOT NULL`;
}

/** La emisión del canal falló sin emitir ninguna póliza: se quita la marca y la cotización vuelve a admitir pago. */
export async function liberarCanal(codigo: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cotizacion_rc SET crc_pago = crc_pago - 'canal', crc_updated_at = CURRENT_TIMESTAMP
    WHERE crc_codigo = ${codigo} AND crc_estado IN ('cotizada', 'pendiente_pago') AND crc_poliza IS NULL`;
}

/** Pagos verificados por pagos-api (misma BD exelixi_nexus, esquema pagos). */
export async function registrosDePago(
  referencia: string,
): Promise<RegistroPago[]> {
  return prisma.$queryRaw<RegistroPago[]>`
    SELECT proveedor, estado, monto FROM pagos.registros_pago
    WHERE ref_ibp = ${referencia} ORDER BY updated_at DESC LIMIT 5`;
}

/** PDF «Condicionado y anexos» de la opción que se mandó a pagar (lo genera el cotizador al pedir el checkout). */
export async function guardarAnexos(
  codigo: string,
  opcion: string,
  nombre: string,
  pdf: Buffer,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cotizacion_rc
    SET crc_anexos_pdf = ${pdf}, crc_anexos_nombre = ${nombre}, crc_anexos_opcion = ${opcion}
    WHERE crc_codigo = ${codigo}`;
}

/** Anexos guardados para la opción pagada; null si no hay o son de otra opción. */
export async function anexosDe(
  codigo: string,
  opcion: string,
): Promise<{ nombre: string; pdf: Buffer } | null> {
  const rows = await prisma.$queryRaw<
    { nombre: string | null; pdf: Uint8Array | null }[]
  >`
    SELECT crc_anexos_nombre AS nombre, crc_anexos_pdf AS pdf FROM cotizacion_rc
    WHERE crc_codigo = ${codigo} AND crc_anexos_opcion = ${opcion} AND crc_anexos_pdf IS NOT NULL LIMIT 1`;
  const r = rows[0];
  return r?.pdf
    ? {
        nombre: r.nombre || 'Condicionado_y_anexos.pdf',
        pdf: Buffer.from(r.pdf),
      }
    : null;
}

/**
 * Reclamo atómico del correo de la póliza: solo una emitida, sin correo enviado y sin otro envío en curso (se
 * libera solo a los 5 minutos). Así la póliza sale una sola vez aunque coincidan la emisión y un reintento.
 */
export async function reclamarCorreoPoliza(
  codigo: string,
  ahoraIso: string,
): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE cotizacion_rc
    SET crc_correo_poliza = COALESCE(crc_correo_poliza, '{}'::jsonb) || jsonb_build_object('enviandoEn', ${ahoraIso}::text)
    WHERE crc_codigo = ${codigo} AND crc_estado = 'emitida' AND crc_poliza IS NOT NULL
      AND (crc_correo_poliza IS NULL
           OR (crc_correo_poliza ->> 'enviadoEn' IS NULL
               AND (crc_correo_poliza ->> 'enviandoEn' IS NULL
                    OR (crc_correo_poliza ->> 'enviandoEn')::timestamptz < CURRENT_TIMESTAMP - interval '5 minutes')))`;
  return n > 0;
}

/** Resultado del envío: { enviadoEn, a, adjuntos } o { error, intentadoEn, a }. */
export async function guardarCorreoPoliza(
  codigo: string,
  correo: unknown,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE cotizacion_rc SET crc_correo_poliza = ${json(correo)}::jsonb WHERE crc_codigo = ${codigo}`;
}
