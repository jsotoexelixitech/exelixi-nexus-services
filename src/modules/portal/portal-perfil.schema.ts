import { z } from 'zod';

export const portalPerfilBodySchema = z
  .object({
    resolverGestorPorEmail: z.boolean().optional(),
    centidad: z.enum(['P', 'C', 'G']).optional().nullable(),
    citem: z.string().max(20).optional().nullable(),
    cproductor: z.string().max(20).optional().nullable(),
    cusuario: z.string().max(20).optional().nullable(),
    cgestor: z.string().max(50).optional().nullable(),
    ccanalaltIn: z.string().max(20).optional().nullable(),
    cscanalaltIn: z.string().max(20).optional().nullable(),
  })
  .optional();

export const empresaPortalConfigBodySchema = z.object({
  centidad: z.enum(['P', 'C', 'G']).optional(),
  citem: z.string().max(20).optional(),
  cproductor: z.string().max(20).optional().nullable(),
  cusuario: z.string().max(20).optional().nullable(),
  resolverGestorPorEmail: z.boolean().optional(),
  ccanalaltIn: z.string().max(20).optional().nullable(),
  cscanalaltIn: z.string().max(20).optional().nullable(),
});

export type PortalPerfilInput = z.infer<typeof portalPerfilBodySchema>;
export type EmpresaPortalConfigInput = z.infer<
  typeof empresaPortalConfigBodySchema
>;
