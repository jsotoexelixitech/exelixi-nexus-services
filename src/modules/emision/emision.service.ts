import prisma from '../../config/prisma';
import logger from '../../utils/logger';

export interface RegistrarEmisionDto {
  empresaId: number;
  producto: string; // "rcv" | "funerario" | etc.
  polizaNumero: string;
  cnrecibo?: string;
  urlpoliza?: string;
  tomadorNombre?: string;
  tomadorIdentificacion?: string;
  planNombre?: string;
  frecuencia?: string;
  monto?: number;
  jsonData?: Record<string, unknown>;
}

export class EmisionService {
  /**
   * Registra una emisión exitosa en la base de datos Nexus.
   * Llamado desde los módulos externos (emision-api) tras recibir
   * confirmación de La Mundial.
   */
  async registrar(dto: RegistrarEmisionDto) {
    logger.info(
      `[EmisionService] Registrando emisión empresa=${dto.empresaId} producto=${dto.producto} poliza=${dto.polizaNumero}`,
    );

    // Buscar o crear una cotización base para enlazar la emisión
    // Si el módulo no envía cotizacionId, creamos una cotización "huella" con el JSON completo
    const cotizacion = await prisma.cotizacion.create({
      data: {
        empresaId: dto.empresaId,
        estado: 'emitida',
        jsonData: (dto.jsonData ?? {}) as object,
      },
    });

    const emision = await prisma.emision.create({
      data: {
        empresaId: dto.empresaId,
        cotizacionId: cotizacion.id,
        polizaNumero: dto.polizaNumero,
        estado: 'emitida',
        jsonData: {
          producto: dto.producto,
          cnrecibo: dto.cnrecibo ?? null,
          urlpoliza: dto.urlpoliza ?? null,
          tomadorNombre: dto.tomadorNombre ?? null,
          tomadorIdentificacion: dto.tomadorIdentificacion ?? null,
          planNombre: dto.planNombre ?? null,
          frecuencia: dto.frecuencia ?? null,
          monto: dto.monto ?? null,
          ...(dto.jsonData ?? {}),
        } as object,
      },
      include: {
        empresa: { select: { id: true, nombre: true } },
      },
    });

    logger.info(
      `[EmisionService] Emisión registrada id=${emision.id} poliza=${emision.polizaNumero}`,
    );

    return emision;
  }

  /**
   * Devuelve todas las emisiones agrupadas por empresa.
   * Usado por la pantalla de Tráfico del admin.
   */
  async trafico(desde?: string, hasta?: string) {
    const where: Record<string, unknown> = {};

    if (desde || hasta) {
      where['createdAt'] = {
        ...(desde ? { gte: new Date(desde) } : {}),
        ...(hasta ? { lte: new Date(hasta + 'T23:59:59Z') } : {}),
      };
    }

    const emisiones = await prisma.emision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        empresa: { select: { id: true, nombre: true, rif: true, feeTransaccion: true } },
      },
    });

    // Agrupar por empresa
    const mapaEmpresas: Record<
      number,
      {
        empresaId: number;
        empresaNombre: string;
        empresaRif: string;
        feeTransaccion: number;
        total: number;
        porProducto: Record<string, number>;
        polizas: typeof emisiones;
      }
    > = {};

    for (const e of emisiones) {
      const eId = e.empresaId;
      if (!mapaEmpresas[eId]) {
        mapaEmpresas[eId] = {
          empresaId: eId,
          empresaNombre: e.empresa.nombre,
          empresaRif: e.empresa.rif,
          feeTransaccion: e.empresa.feeTransaccion ? Number(e.empresa.feeTransaccion) : 0,
          total: 0,
          porProducto: {},
          polizas: [],
        };
      }
      mapaEmpresas[eId].total += 1;

      const prod =
        ((e.jsonData as Record<string, unknown>)?.producto as string) ??
        'desconocido';
      mapaEmpresas[eId].porProducto[prod] =
        (mapaEmpresas[eId].porProducto[prod] ?? 0) + 1;
      mapaEmpresas[eId].polizas.push(e);
    }

    return {
      totalEmisiones: emisiones.length,
      empresas: Object.values(mapaEmpresas),
    };
  }

  /**
   * Emisiones de una empresa en particular.
   */
  async porEmpresa(empresaId: number, desde?: string, hasta?: string) {
    const where: Record<string, unknown> = { empresaId };
    if (desde || hasta) {
      where['createdAt'] = {
        ...(desde ? { gte: new Date(desde) } : {}),
        ...(hasta ? { lte: new Date(hasta + 'T23:59:59Z') } : {}),
      };
    }
    return prisma.emision.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { empresa: { select: { id: true, nombre: true } } },
    });
  }
}
