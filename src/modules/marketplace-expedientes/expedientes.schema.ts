import { z } from 'zod';
import { horaValida } from './expedientes.domain';

const str = (max: number) => z.string().trim().max(max);
const optStr = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().max(max))
    .optional()
    .nullable();

/** Campo opcional `expediente` del registro de emisión (contrato v1). Tolerante. */
export const expedientePayloadSchema = z
  .object({
    version: z.coerce.number().optional(),
    centidad: optStr(1),
    citem: optStr(32),
    cgestor: optStr(50),
    ccanalalt: optStr(32),
    cusuario: optStr(32),
    xlogin: optStr(100),
    producto: optStr(32),
    cramo: z.coerce.number().int().optional().nullable(),
    estadoPago: optStr(16),
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
      .nullable(),
    snapshot: z.record(z.unknown()).optional().nullable(),
    documentos: z
      .record(
        z
          .object({
            recibido: z.boolean().optional(),
            ref: optStr(500),
          })
          .partial(),
      )
      .optional()
      .nullable(),
    carpetaExpediente: optStr(500),
  })
  .partial();

export type ExpedientePayload = z.infer<typeof expedientePayloadSchema>;

const tipoRequisito = z
  .string()
  .trim()
  .regex(/^[a-z_]{2,32}$/, 'Tipo de requisito inválido');

export const configUpdateSchema = z.object({
  body: z
    .object({
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
      cadenciaDias: z
        .array(z.number().int().min(0).max(90))
        .min(1)
        .max(10)
        .refine(
          (a) => a.every((v, i) => i === 0 || v > a[i - 1]),
          'cadenciaDias debe ser ascendente y sin repetidos',
        )
        .optional(),
      destinatariosResumen: z
        .array(z.string().trim().email().max(200))
        .max(20)
        .optional(),
      horaDiaria: z.string().refine(horaValida, 'Hora HH:MM').optional(),
      horaResumen: z.string().refine(horaValida, 'Hora HH:MM').optional(),
      requisitosPorProducto: z
        .record(z.array(tipoRequisito).max(10))
        .optional(),
    })
    .strict(),
});

export const exclusionCreateSchema = z.object({
  body: z
    .object({
      alcance: z.enum(['asegurado', 'poliza']),
      motivo: str(500).min(3, 'El motivo es obligatorio'),
      expedienteId: z.coerce.number().int().positive().optional(),
      cnpoliza: str(64).optional(),
      empresaId: z.coerce.number().int().positive().optional(),
      documento: str(32).optional(),
      tipoDoc: str(2).optional(),
    })
    .refine(
      (b) =>
        b.expedienteId != null ||
        (b.alcance === 'poliza' ? !!b.cnpoliza : !!b.documento),
      'Indique expedienteId, o cnpoliza (póliza) / documento (asegurado).',
    ),
});

export const observarSchema = z.object({
  body: z.object({ motivo: str(500).min(3, 'El motivo es obligatorio') }),
});

export const listQuerySchema = z.object({
  estadoDoc: z.enum(['completo', 'incompleto']).optional(),
  estadoPago: z.enum(['pagada', 'pendiente']).optional(),
  area: z.enum(['canal', 'gestor', 'productor', 'desconocida']).optional(),
  producto: z.enum(['rcv', 'personas', 'patrimonial']).optional(),
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
  agrupar: z.enum(['poliza', 'asegurado']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export type ListQuery = z.infer<typeof listQuerySchema>;

export const indicadoresQuerySchema = listQuerySchema.pick({
  area: true,
  desde: true,
  hasta: true,
});

export const JOBS = ['conciliacion'] as const;
export type JobName = (typeof JOBS)[number];
