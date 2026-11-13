import { z } from 'zod';
import {
  ALCANCES_EXCLUSION,
  horaValida,
  TIPOS_ACTOR,
} from './expedientes.domain';

const str = (max: number) => z.string().trim().max(max);
/** Campo tolerante: si viene mal, queda null y no tumba el resto del payload. */
const optStr = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().max(max))
    .optional()
    .nullable()
    .catch(null);
const optBool = z.boolean().optional().nullable().catch(null);

/**
 * Campo opcional `expediente` del registro de emisión (contrato v1 + ajustes de Emisión):
 * cproductor, cproducto, documentosEnWizard y documentos[tipo] = { recibido, ref, url }.
 */
export const expedientePayloadSchema = z
  .object({
    version: z.coerce.number().optional().catch(undefined),
    centidad: optStr(1),
    citem: optStr(32),
    cgestor: optStr(50),
    ccanalalt: optStr(32),
    cusuario: optStr(32),
    xlogin: optStr(100),
    cproductor: optStr(32),
    cproducto: optStr(32),
    producto: optStr(32),
    cramo: z.coerce.number().int().optional().nullable().catch(null),
    estadoPago: optStr(16),
    documentosEnWizard: optBool,
    asegurado: z
      .object({
        tipoDoc: optStr(2),
        documento: optStr(32),
        nombre: optStr(150),
        apellido: optStr(150),
        email: optStr(200),
        telefono: optStr(40),
      })
      .partial()
      .optional()
      .nullable()
      .catch(null),
    snapshot: z.record(z.unknown()).optional().nullable().catch(null),
    /** v1.4: correos del tomador y del asegurado/titular (los avisos van a todos los válidos). */
    correos: z
      .array(z.string().trim().max(200))
      .max(10)
      .optional()
      .nullable()
      .catch(null),
    documentos: z
      .record(
        z
          .object({
            recibido: optBool,
            ref: optStr(500),
            url: optStr(1000),
            /** v1.3: lo que el OCR leyó del documento al emitir (campos clave normalizados). */
            ocrLeido: z
              .object({
                tipoDoc: optStr(2),
                documento: optStr(32),
                nombre: optStr(150),
                apellido: optStr(150),
                placa: optStr(20),
                serial: optStr(40),
                serialMotor: optStr(40),
                marca: optStr(80),
                modelo: optStr(120),
                anio: optStr(4),
                vencimiento: optStr(20),
              })
              .partial()
              .optional()
              .nullable()
              .catch(null),
          })
          .partial()
          .nullable()
          .catch(null),
      )
      .optional()
      .nullable()
      .catch(null),
    carpetaExpediente: optStr(500),
  })
  .partial();

export type ExpedientePayload = z.infer<typeof expedientePayloadSchema>;

const tipoRequisito = z
  .string()
  .trim()
  .regex(/^[a-z_]{2,32}$/, 'Tipo de requisito inválido');

export const configUpdateSchema = z.object({
  body: z.object({
    motivo: str(500).min(3, 'El motivo es obligatorio'),
    alcance: z
      .object({
        canales: z.boolean(),
        gestores: z.boolean(),
        productores: z.boolean(),
        desconocida: z.boolean(),
      })
      .partial()
      .optional(),
    validacion: z.enum(['manual', 'automatica']).optional(),
    // Se ordena y se quitan repetidos antes de validar.
    cadenciaDias: z
      .preprocess(
        (v) =>
          Array.isArray(v)
            ? Array.from(new Set(v.map(Number))).sort((a, b) => a - b)
            : v,
        z.array(z.number().int().min(0).max(90)).min(1).max(10),
      )
      .optional(),
    destinatariosResumen: z
      .array(z.string().trim().email().max(200))
      .max(20)
      .optional(),
    horaDiaria: z.string().refine(horaValida, 'Hora HH:MM').optional(),
    horaResumen: z.string().refine(horaValida, 'Hora HH:MM').optional(),
    requisitosPorProducto: z.record(z.array(tipoRequisito).max(10)).optional(),
  }),
  // Campos desconocidos (p. ej. `cambios` reenviado por la pantalla) se ignoran.
});

const alcanceExclusion = z.enum(ALCANCES_EXCLUSION);

export const exclusionCreateSchema = z.object({
  body: z
    .object({
      alcance: alcanceExclusion,
      motivo: str(500).min(3, 'El motivo es obligatorio'),
      expedienteId: z.coerce.number().int().positive().optional(),
      cnpoliza: str(64).optional(),
      empresaId: z.coerce.number().int().positive().optional(),
      documento: str(32).optional(),
      tipoDoc: str(2).optional(),
      /**
       * documento (asegurado), cnpoliza (póliza) o el código de canal (ccanalalt),
       * gestor (cgestor) o intermediario (cproductor), según el alcance.
       */
      valor: str(64).optional(),
    })
    .refine(
      (b) =>
        b.expedienteId != null ||
        !!b.valor ||
        (b.alcance === 'poliza'
          ? !!b.cnpoliza
          : b.alcance === 'asegurado'
            ? !!b.documento
            : false),
      'Indique valor, expedienteId, o cnpoliza (póliza) / documento (asegurado).',
    ),
});

/** Varios valores en una sola acción: cada uno queda como una exclusión propia. */
export const exclusionLoteSchema = z.object({
  body: z.object({
    alcance: alcanceExclusion,
    motivo: str(500).min(3, 'El motivo es obligatorio'),
    valores: z
      .array(str(64).min(1, 'Valor vacío'))
      .min(1, 'Elija al menos un valor')
      .max(200, 'Máximo 200 valores por acción'),
    /** Solo póliza: empresa de las pólizas (opcional, como en la exclusión individual). */
    empresaId: z.coerce.number().int().positive().optional(),
  }),
});

export const exclusionesQuerySchema = z.object({
  todas: z.string().max(10).optional(),
  alcance: alcanceExclusion.optional(),
});

export const actoresQuerySchema = z.object({
  tipo: z.enum(TIPOS_ACTOR),
  q: z.string().trim().max(100).optional(),
});

/** Validar a mano: motivo opcional (queda en la auditoría de la excepción). */
export const validarSchema = z.object({
  body: z.object({ motivo: str(500).optional() }).passthrough(),
});

export const observarSchema = z.object({
  body: z.object({ motivo: str(500).min(3, 'El motivo es obligatorio') }),
});

/** Productos del flujo con config OCR propia (los mismos de /api/config/:empresa/:producto/ocr). */
export const PRODUCTOS_OCR = ['rcv', 'funerario', 'patrimoniales'] as const;
export type ProductoOcr = (typeof PRODUCTOS_OCR)[number];

/** ccanalalt como lo guarda el OCR: texto sin espacios (acepta número). */
const codigoCanal = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().min(1).max(64));

/** cproductor como llega en el SSO (centidad P + citem): texto corto sin espacios. */
const codigoProductor = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,32}$/, 'Código de productor no válido'),
  );

export const ocrPorCanalQuerySchema = z.object({
  producto: z.enum(PRODUCTOS_OCR).default('rcv'),
});

/** Puntos de comercialización de un canal (lista bajo demanda, paginada). */
export const puntosCanalQuerySchema = z.object({
  canal: codigoCanal,
  pagina: z.coerce.number().int().min(1).max(10_000).default(1),
  porPagina: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(60).optional(),
});

export type PuntosCanalQuery = z.infer<typeof puntosCanalQuerySchema>;

export const ocrPorCanalUpdateSchema = z.object({
  producto: z.enum(PRODUCTOS_OCR),
  /** Lista completa de canales con OCR OPCIONAL (el resto queda obligatorio). */
  canales: z.array(codigoCanal).max(2000),
  /** Canales opcionales que la pantalla cargó: si ya no coinciden, otro guardó antes (409). */
  base: z.array(codigoCanal).max(2000).optional(),
  /**
   * Lista completa de productores (cproductor) con OCR OPCIONAL. Ausente = no se tocan
   * (clientes anteriores solo mandan canales).
   */
  productores: z.array(codigoProductor).max(2000).optional(),
  /** cproductor → nombre para mostrar (no hay catálogo: se agregan por código + nombre). */
  productoresNombres: z
    .record(z.string().max(32), z.string().trim().max(120))
    .optional(),
  /** Productores opcionales que la pantalla cargó: si ya no coinciden, 409. */
  baseProductores: z.array(codigoProductor).max(2000).optional(),
  motivo: str(500).min(3, 'El motivo es obligatorio'),
});

export type OcrPorCanalUpdate = z.infer<typeof ocrPorCanalUpdateSchema>;

export const listQuerySchema = z.object({
  estadoDoc: z.enum(['completo', 'incompleto', 'sin_informacion']).optional(),
  estadoPago: z.enum(['pagada', 'pendiente']).optional(),
  // C / G / P (centidad del SSO) o el nombre del área.
  area: z.string().trim().max(20).optional(),
  producto: z
    .enum(['rcv', 'personas', 'patrimonial', 'pastora', 'viajero'])
    .optional(),
  desde: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  hasta: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
  vendedor: z.string().trim().max(100).optional(),
  /** Canal del ranking (ccanalalt o SIN_IDENTIFICAR): incluye sus gestores y puntos. */
  canal: z.string().trim().max(64).optional(),
  /** Productor del ranking (cproductor o SIN_IDENTIFICAR). */
  productor: z.string().trim().max(64).optional(),
  agrupar: z.enum(['poliza', 'asegurado']).optional(),
  /** Solo pólizas con algún documento errado (no coincide, ilegible, sin certeza: observado). */
  conErrores: z.preprocess(
    (v) =>
      v === true || v === 'true' || v === '1'
        ? true
        : v === false || v === 'false' || v === '0'
          ? false
          : undefined,
    z.boolean().optional(),
  ),
  /** v1.3: solo pólizas con datos cambiados en el formulario respecto al OCR al emitir. */
  datosModificados: z.preprocess(
    (v) =>
      v === true || v === 'true' || v === '1'
        ? true
        : v === false || v === 'false' || v === '0'
          ? false
          : undefined,
    z.boolean().optional(),
  ),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const indicadoresQuerySchema = listQuerySchema.pick({
  area: true,
  desde: true,
  hasta: true,
});

export const JOBS = [
  'diaria',
  'nocturna',
  'conciliacion',
  'validacion_ia',
] as const;
export type JobName = (typeof JOBS)[number];
