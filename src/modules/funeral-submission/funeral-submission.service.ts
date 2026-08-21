import { Prisma } from '@prisma/client';
import prisma from '../../config/prisma';
import { startCheckoutLink, inferModuloGroupId } from '../flow/flow.service';
import { buildFuneralCheckoutPatch } from './funeral-checkout-patch';
import { sendFuneralPaymentLinkEmail } from './funeral-approval-mail';

export type FuneralSubmissionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'paid'
  | 'expired';

export interface CreateFuneralSubmissionInput {
  empresaId: number;
  sessionId: string;
  canal?: string;
  tomadorRif?: string;
  tomadorNombre?: string;
  tomadorEmail?: string;
  cplan: string;
  planName?: string;
  cramo?: number;
  scoreTotal: number;
  scoreBreakdown: unknown[];
  healthAnswers: Record<string, unknown>;
  snapshot: Record<string, unknown>;
}

const PAYMENT_LINK_TTL_HOURS = Number(
  process.env.FUNERAL_PAYMENT_LINK_TTL_HOURS || 72,
);

function formatRow(row: {
  id: string;
  empresaId: number;
  sessionId: string;
  canal: string;
  estado: string;
  tomadorRif: string | null;
  tomadorNombre: string | null;
  tomadorEmail: string | null;
  cplan: string;
  planName: string | null;
  cramo: number | null;
  scoreTotal: number;
  scoreBreakdown: unknown;
  healthAnswers: unknown;
  snapshotJson: unknown;
  rejectReason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  paymentUrl: string | null;
  paymentSid: string | null;
  paymentExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    empresaId: row.empresaId,
    sessionId: row.sessionId,
    canal: row.canal,
    estado: row.estado,
    tomadorRif: row.tomadorRif,
    tomadorNombre: row.tomadorNombre,
    tomadorEmail: row.tomadorEmail,
    cplan: row.cplan,
    planName: row.planName,
    cramo: row.cramo,
    scoreTotal: row.scoreTotal,
    scoreBreakdown: row.scoreBreakdown,
    healthAnswers: row.healthAnswers,
    snapshot: row.snapshotJson,
    rejectReason: row.rejectReason,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    paymentUrl: row.paymentUrl,
    paymentSid: row.paymentSid,
    paymentExpiresAt: row.paymentExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class FuneralSubmissionService {
  async create(input: CreateFuneralSubmissionInput) {
    const row = await prisma.funeralSubmission.create({
      data: {
        empresaId: input.empresaId,
        sessionId: input.sessionId,
        canal: input.canal?.trim() || 'default',
        estado: 'pending',
        tomadorRif: input.tomadorRif ?? null,
        tomadorNombre: input.tomadorNombre ?? null,
        tomadorEmail: input.tomadorEmail ?? null,
        cplan: input.cplan,
        planName: input.planName ?? null,
        cramo: input.cramo ?? null,
        scoreTotal: input.scoreTotal,
        scoreBreakdown: input.scoreBreakdown as Prisma.InputJsonValue,
        healthAnswers: input.healthAnswers as Prisma.InputJsonValue,
        snapshotJson: input.snapshot as Prisma.InputJsonValue,
      },
    });
    return formatRow(row);
  }

  async listByEmpresa(
    empresaId: number,
    opts?: { estado?: string; limit?: number },
  ) {
    const where: Prisma.FuneralSubmissionWhereInput = { empresaId };
    if (opts?.estado) where.estado = opts.estado;

    const rows = await prisma.funeralSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(opts?.limit ?? 100, 200),
    });
    return rows.map(formatRow);
  }

  async getById(id: string, empresaId?: number) {
    const row = await prisma.funeralSubmission.findFirst({
      where: {
        id,
        ...(empresaId ? { empresaId } : {}),
      },
    });
    return row ? formatRow(row) : null;
  }

  async approve(id: string, opts: { reviewedBy?: string; empresaId?: number }) {
    const existing = await this.getById(id, opts.empresaId);
    if (!existing) return null;
    if (existing.estado !== 'pending') {
      throw new Error(`La solicitud ya está en estado "${existing.estado}".`);
    }

    if (!existing.tomadorEmail?.trim()) {
      throw new Error(
        'La solicitud no tiene correo del tomador para enviar el link de pago.',
      );
    }

    const snapshot =
      existing.snapshot && typeof existing.snapshot === 'object'
        ? (existing.snapshot as Record<string, unknown>)
        : {};

    const moduloGroupId = await inferModuloGroupId(existing.empresaId);
    if (!moduloGroupId) {
      throw new Error(
        'No se encontró grupo de módulos activo para esta empresa.',
      );
    }

    const expiresAt = new Date(
      Date.now() + PAYMENT_LINK_TTL_HOURS * 60 * 60 * 1000,
    );

    const patch = buildFuneralCheckoutPatch(snapshot, {
      submissionId: id,
      cplan: existing.cplan,
      planName: existing.planName ?? undefined,
      paymentExpiresAt: expiresAt,
    });

    const linkResult = await startCheckoutLink(
      existing.empresaId,
      moduloGroupId,
      patch,
    );
    if ('error' in linkResult) {
      throw new Error(linkResult.error);
    }

    const mail = await sendFuneralPaymentLinkEmail({
      to: existing.tomadorEmail,
      name: existing.tomadorNombre ?? undefined,
      planName: existing.planName ?? undefined,
      paymentUrl: linkResult.checkoutUrl,
      expiresAt,
    });

    const row = await prisma.funeralSubmission.update({
      where: { id },
      data: {
        estado: 'approved',
        reviewedBy: opts.reviewedBy ?? 'tecnico',
        reviewedAt: new Date(),
        rejectReason: null,
        paymentUrl: linkResult.checkoutUrl,
        paymentSid: linkResult.sid,
        paymentExpiresAt: expiresAt,
      },
    });

    return {
      ...formatRow(row),
      emailSent: mail.sent,
      emailError: mail.error,
    };
  }

  async reject(
    id: string,
    opts: { reviewedBy?: string; reason?: string; empresaId?: number },
  ) {
    const existing = await this.getById(id, opts.empresaId);
    if (!existing) return null;
    if (existing.estado !== 'pending') {
      throw new Error(`La solicitud ya está en estado "${existing.estado}".`);
    }

    const row = await prisma.funeralSubmission.update({
      where: { id },
      data: {
        estado: 'rejected',
        reviewedBy: opts.reviewedBy ?? 'tecnico',
        reviewedAt: new Date(),
        rejectReason: opts.reason?.trim() || 'Rechazada por el técnico.',
      },
    });
    return formatRow(row);
  }
}
