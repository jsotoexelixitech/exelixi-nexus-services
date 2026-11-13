/**
 * Cotizaciones del cotizador RC: guardar, buscar, mandar a pagar y emitir como pagada.
 *
 * Pago → emisión (todo del lado servidor):
 *   1. crearCheckout: sesión de Pagos (startCheckoutLink) con notifyUrl a este servicio y un token por intento.
 *   2. El cliente paga en el módulo de Pagos; pagos-api avisa a notifyUrl (POST /pago-callback/:codigo?t=…).
 *   3. confirmarPago: valida token, monto y que la referencia sea un pago verificado en pagos.registros_pago;
 *      reclama la cotización (pendiente_pago → pagada) y dispara la emisión.
 *   4. emitirPagada: nest-api emite (modo cotizador) y cobra el recibo (collection/activate) → emitida.
 * El navegador del cliente nunca emite: solo consulta el estado.
 */
import { randomBytes } from 'crypto';
import logger from '../../utils/logger';
import { AppError } from '../../utils/app-error';
import { startCheckoutLink } from '../flow/flow.service';
import * as repo from './cotizaciones-rc.repo';
import * as nest from './cotizaciones-rc.nest';
import {
  MAX_INTENTOS,
  OPCIONES,
  alternativaDe,
  armarCobro,
  emisionDeOpcion,
  esObj,
  evaluarRegistros,
  intentoPorToken,
  intentosDe,
  monedaDeCobro,
  montoTolerancia,
  normalizarCodigo,
  pagoDeNotificacion,
  redondear,
  sha256,
  validarCotizacionNueva,
  vencida,
  type FilaCotizacion,
  type IntentoPago,
  type ModoVerificacion,
  type MotivoVerificacion,
  type Opcion,
  type PagoConfirmado,
} from './cotizaciones-rc.domain';

type Obj = Record<string, unknown>;

/** COTIZACIONES_RC_VERIFICAR_PAGO: enforce (por defecto) | warn (solo aviso, QA sin pagos.registros_pago) | off. */
export function modoVerificacion(): ModoVerificacion {
  const raw = String(process.env.COTIZACIONES_RC_VERIFICAR_PAGO ?? 'enforce')
    .toLowerCase()
    .trim();
  return raw === 'warn' || raw === 'off' ? raw : 'enforce';
}

function configCheckout() {
  const empresaId = Number(process.env.COTIZACIONES_RC_EMPRESA_ID);
  const moduloGroupId = Number(process.env.COTIZACIONES_RC_MODULO_GROUP_ID);
  const notifyBase = String(process.env.COTIZACIONES_RC_NOTIFY_BASE_URL ?? '')
    .trim()
    .replace(/\/$/, '');
  if (
    !(empresaId > 0) ||
    !(moduloGroupId > 0) ||
    !/^https?:\/\//i.test(notifyBase)
  ) {
    throw new AppError(
      'Pago en línea sin configurar en nexus-api: COTIZACIONES_RC_EMPRESA_ID, COTIZACIONES_RC_MODULO_GROUP_ID y COTIZACIONES_RC_NOTIFY_BASE_URL.',
      503,
    );
  }
  return { empresaId, moduloGroupId, notifyBase };
}

function codigoValido(v: unknown): string {
  const codigo = normalizarCodigo(v);
  if (!codigo)
    throw new AppError(
      'El código de cotización no tiene el formato correcto (ej. RCG-2026-000123-7KQ4).',
      400,
    );
  return codigo;
}

export async function crear(body: unknown): Promise<FilaCotizacion> {
  const nueva = validarCotizacionNueva(body);
  const fila = await repo.crear(nueva);
  logger.info(
    `[cotizaciones-rc] creada ${fila.codigo} producto=${fila.producto} origen=${fila.origen}`,
  );
  return fila;
}

/**
 * 404 si no existe; 410 si venció sin pago (una pagada o emitida se sigue pudiendo consultar).
 * `admin`: el historial no vence para el canal; los 15 días solo cierran el acceso y el pago del cliente.
 */
export async function obtener(
  codigoRaw: unknown,
  admin = false,
): Promise<FilaCotizacion> {
  const codigo = codigoValido(codigoRaw);
  const fila = await repo.porCodigo(codigo);
  if (!fila)
    throw new AppError(
      `No existe la cotización ${codigo}. Revisa el código.`,
      404,
    );
  if (
    !admin &&
    vencida(fila) &&
    (fila.estado === 'cotizada' || fila.estado === 'pendiente_pago')
  ) {
    throw new AppError(
      `La cotización ${codigo} venció (15 días). Haz una cotización nueva.`,
      410,
    );
  }
  return fila;
}

const fechaIso = (v: unknown): string | null => {
  const t = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

export function listar(q: Obj): Promise<FilaCotizacion[]> {
  const limpio = (v: unknown) =>
    String(v ?? '')
      .trim()
      .slice(0, 80) || null;
  // «vencida» no es un estado guardado: es una cotización sin pagar con los 15 días cumplidos.
  const estado = limpio(q.estado);
  const vigencia =
    estado === 'vencida' || q.vigencia === 'vencidas'
      ? 'vencidas'
      : q.vigencia === 'todas'
        ? 'todas'
        : 'vigentes';
  return repo.listar({
    codigo: limpio(q.codigo)?.toUpperCase() ?? null,
    texto: limpio(q.q),
    estado: estado === 'vencida' ? null : estado,
    vigencia,
    desde: fechaIso(q.desde),
    hasta: fechaIso(q.hasta),
  });
}

/** Emisión hecha en el cotizador por el canal (recibo pendiente de cobro): la cotización queda emitida. */
export async function registrarEmisionPendiente(
  codigoRaw: unknown,
  body: unknown,
): Promise<FilaCotizacion> {
  const fila = await obtener(codigoRaw);
  const b = esObj(body) ? body : {};
  if (b.estado !== 'emitida') {
    throw new AppError(
      'Solo se puede registrar el estado emitida; pendiente_pago y pagada los fija el flujo de pago.',
      400,
    );
  }
  const p = esObj(b.poliza) ? b.poliza : {};
  const cnpoliza = String(p.cnpoliza ?? '').trim();
  if (!cnpoliza) throw new AppError('poliza.cnpoliza es obligatorio.', 400);
  const opcion = OPCIONES.includes(b.opcion as Opcion)
    ? (b.opcion as Opcion)
    : null;
  const ok = await repo.marcarEmitidaPendiente(fila.codigo, opcion, {
    cnpoliza,
    cnrecibo: String(p.cnrecibo ?? '').trim(),
    urlpoliza: String(p.urlpoliza ?? '').trim(),
    cobro: { ok: false, pendiente: true },
    emitidaEn: new Date().toISOString(),
  });
  if (!ok)
    throw new AppError(
      `La cotización ${fila.codigo} ya está ${fila.estado}.`,
      409,
    );
  return obtener(fila.codigo);
}

function urlRetorno(returnUrl: unknown, codigo: string): string | null {
  try {
    const u = new URL(String(returnUrl ?? ''));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.searchParams.set('cotizacion', codigo);
    return u.toString();
  } catch {
    return null;
  }
}

/** Manda la cotización a pagar: crea el checkout en Pagos por la prima de la opción elegida. */
export async function crearCheckout(codigoRaw: unknown, body: unknown) {
  const cfg = configCheckout();
  const fila = await obtener(codigoRaw);
  if (vencida(fila))
    throw new AppError(`La cotización ${fila.codigo} venció (15 días).`, 410);
  if (fila.estado === 'pagada' || fila.estado === 'emitida') {
    throw new AppError(
      `La cotización ${fila.codigo} ya está ${fila.estado}.`,
      409,
    );
  }
  const b = esObj(body) ? body : {};
  const alt = alternativaDe(fila.datos, b.opcion);
  emisionDeOpcion(fila.datos, alt);
  const moneda = monedaDeCobro(fila.moneda);
  const hoy = new Date().toISOString().slice(0, 10);
  const tasa =
    moneda === 'BS'
      ? 1
      : await nest.tasaBcv(hoy).catch((e: unknown) => {
          throw new AppError(
            `No se pudo obtener la tasa BCV del día: ${e instanceof Error ? e.message : String(e)}`,
            502,
          );
        });
  const totalVes = redondear(alt.prima * tasa);

  const token = randomBytes(24).toString('hex');
  const notifyUrl = `${cfg.notifyBase}/api/cotizaciones-rc/pago-callback/${fila.codigo}?t=${token}`;
  const successUrl = urlRetorno(b.returnUrl, fila.codigo);
  const datos = esObj(fila.datos) ? fila.datos : {};
  const tomador = esObj(datos.tomador) ? datos.tomador : {};

  const link = await startCheckoutLink(cfg.empresaId, cfg.moduloGroupId, {
    checkout: {
      referenceId: fila.codigo,
      title: `Responsabilidad Civil · opción ${alt.opcion}`,
      subtitle: `Cotización ${fila.codigo} · La Mundial de Seguros`,
      totalVes,
      ...(moneda === 'USD' ? { totalUsd: alt.prima, exchangeRate: tasa } : {}),
      lines: [
        {
          label: `Prima anual · opción ${alt.opcion}`,
          amountVes: totalVes,
          ...(moneda === 'USD' ? { amountUsd: alt.prima } : {}),
        },
      ],
    },
    rules: {
      requirePayment: true,
      lockFields: true,
      hideNavigation: true,
      onSuccess: successUrl
        ? { mode: 'redirect', redirectUrl: successUrl }
        : { mode: 'none' },
    },
    payer: {
      documentType: String(tomador.tipoDoc ?? '').trim() || undefined,
      documentNumber:
        String(tomador.documento ?? '').replace(/\D/g, '') || undefined,
      name: fila.tomadorNombre,
      phone: String(tomador.telefono ?? '').trim() || undefined,
      email: fila.tomadorCorreo || undefined,
    },
    payload: {
      notifyUrl,
      idOperacion: fila.codigo,
      referenceId: fila.codigo,
      source: 'cotizador-rc',
      ...(successUrl ? { successUrl } : {}),
    },
  });
  if ('error' in link)
    throw new AppError(`No se pudo abrir el pago: ${link.error}`, 502);

  const intento: IntentoPago = {
    tokenHash: sha256(token),
    opcion: alt.opcion,
    prima: alt.prima,
    moneda,
    tasa,
    totalVes,
    sid: link.sid,
    checkoutUrl: link.checkoutUrl,
    creadoEn: new Date().toISOString(),
  };
  // Se conservan los últimos intentos: si el cliente paga en una pestaña anterior, ese pago también cuenta.
  const intentos = [...intentosDe(fila.pago), intento].slice(-MAX_INTENTOS);
  const ok = await repo.guardarCheckout(fila.codigo, alt.opcion, { intentos });
  if (!ok)
    throw new AppError(`La cotización ${fila.codigo} ya no admite pago.`, 409);
  logger.info(
    `[cotizaciones-rc] checkout ${fila.codigo} opcion=${alt.opcion} totalVes=${totalVes} sid=${link.sid}`,
  );
  return {
    codigo: fila.codigo,
    opcion: alt.opcion,
    prima: alt.prima,
    moneda,
    tasa,
    totalVes,
    checkoutUrl: link.checkoutUrl,
  };
}

/** ¿La referencia es un pago verificado por pagos-api? Sin tabla o con la BD caída: db_unavailable. */
async function verificarPago(
  pago: PagoConfirmado,
): Promise<{ verified: boolean; reason: MotivoVerificacion }> {
  if (modoVerificacion() === 'off')
    return { verified: true, reason: 'disabled' };
  try {
    return evaluarRegistros(
      await repo.registrosDePago(pago.referencia),
      pago.monto,
    );
  } catch (e) {
    logger.warn(
      `[cotizaciones-rc] verificación de pago ref=${pago.referencia}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { verified: false, reason: 'db_unavailable' };
  }
}

/**
 * Notificación de pagos-api (notifyUrl). Responde rápido y emite en segundo plano: la emisión tarda más que el
 * tiempo de espera del aviso. Es idempotente: una cotización ya pagada o emitida no se vuelve a procesar.
 */
export async function confirmarPago(
  codigoRaw: unknown,
  token: unknown,
  body: unknown,
) {
  const codigo = codigoValido(codigoRaw);
  const fila = await repo.porCodigo(codigo);
  if (!fila) throw new AppError(`No existe la cotización ${codigo}.`, 404);
  const intento = intentoPorToken(fila.pago, String(token ?? ''));
  if (!intento) throw new AppError('Notificación de pago no autorizada.', 403);

  const b = esObj(body) ? body : {};
  if (b.paymentVerified !== true || b.status !== 'ok') {
    return {
      codigo,
      estado: fila.estado,
      procesado: false,
      motivo: 'pago_no_verificado',
    };
  }
  if (fila.estado === 'pagada' || fila.estado === 'emitida') {
    return {
      codigo,
      estado: fila.estado,
      procesado: false,
      motivo: 'ya_procesado',
    };
  }

  const pago = pagoDeNotificacion(b);
  if (pago.monto < intento.totalVes - montoTolerancia(intento.totalVes)) {
    logger.warn(
      `[cotizaciones-rc] ${codigo}: pago ${pago.monto} menor que el total ${intento.totalVes} (ref ${pago.referencia})`,
    );
    throw new AppError(
      'El monto pagado es menor que la prima de la cotización.',
      400,
    );
  }
  if (await repo.referenciaUsada(pago.referencia, codigo)) {
    throw new AppError(
      'La referencia de pago ya se usó en otra cotización.',
      409,
    );
  }
  const check = await verificarPago(pago);
  if (!check.verified) {
    const modo = modoVerificacion();
    logger.warn(
      `[cotizaciones-rc] ${codigo}: pago ref=${pago.referencia} no verificado (${check.reason}) modo=${modo}`,
    );
    if (modo === 'enforce') {
      throw new AppError(
        `El pago no está verificado en Pagos (${check.reason}). No se emite la póliza.`,
        409,
      );
    }
  }

  const reclamado = await repo.marcarPagada(codigo, intento.opcion, {
    referencia: pago.referencia,
    monto: pago.monto,
    metodo: pago.metodo,
    fecha: pago.fecha,
    detalle: pago.detalle,
    opcion: intento.opcion,
    totalVes: intento.totalVes,
    tasa: intento.tasa,
    verificacion: check.reason,
    confirmadoEn: new Date().toISOString(),
  });
  if (!reclamado)
    return {
      codigo,
      estado: 'pagada',
      procesado: false,
      motivo: 'ya_procesado',
    };

  logger.info(
    `[cotizaciones-rc] ${codigo}: pago confirmado ref=${pago.referencia} monto=${pago.monto} opcion=${intento.opcion}`,
  );
  void emitirPagada(codigo).catch((e) =>
    logger.error(
      `[cotizaciones-rc] ${codigo}: emisión sin controlar: ${String(e)}`,
    ),
  );
  return { codigo, estado: 'pagada', procesado: true };
}

function pagadoDe(
  fila: FilaCotizacion,
): { pago: PagoConfirmado; opcion: Opcion } | null {
  const p =
    esObj(fila.pago) && esObj(fila.pago.pagado) ? fila.pago.pagado : null;
  if (!p || !p.referencia) return null;
  return {
    opcion: p.opcion as Opcion,
    pago: {
      referencia: String(p.referencia),
      monto: Number(p.monto),
      metodo: p.metodo ? String(p.metodo) : null,
      fecha: String(p.fecha),
      detalle: esObj(p.detalle) ? p.detalle : {},
    },
  };
}

/** Sis2000 no permite dos pólizas vigentes con el mismo asegurado, plan y unidad: se prueba la unidad siguiente. */
const MAX_UNIDADES = 5;

async function cobrar(
  codigo: string,
  poliza: nest.PolizaEmitida,
  pago: PagoConfirmado,
): Promise<Obj> {
  try {
    const c = await nest.cobrarRecibo(armarCobro(poliza.cnrecibo, pago));
    logger.info(
      `[cotizaciones-rc] ${codigo}: recibo ${poliza.cnrecibo} cobrado`,
    );
    return {
      ok: true,
      ingresoCaja: c.ingresoCaja,
      transaccion: c.transaccion,
      cobradoEn: new Date().toISOString(),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error(
      `[cotizaciones-rc] ${codigo}: cobro del recibo ${poliza.cnrecibo} falló: ${error}`,
    );
    return { ok: false, error };
  }
}

/** Emite en nest-api la cotización pagada y cobra el recibo. Solo corre con la cotización reclamada. */
export async function emitirPagada(codigo: string): Promise<void> {
  if (!(await repo.reclamarEmision(codigo))) return;
  try {
    const fila = await repo.porCodigo(codigo);
    const pagado = fila && pagadoDe(fila);
    if (!fila || !pagado)
      throw new Error('La cotización no tiene un pago confirmado.');
    const alt = alternativaDe(fila.datos, pagado.opcion);
    const emision: Obj = {
      ...emisionDeOpcion(fila.datos, alt),
      ncotizacion: codigo,
    };

    let poliza: nest.PolizaEmitida | null = null;
    const unidad =
      Number(emision.apartamento) > 0 ? Number(emision.apartamento) : 0;
    for (let i = 0; i < MAX_UNIDADES && !poliza; i++) {
      try {
        poliza = await nest.emitir(
          unidad ? { ...emision, apartamento: unidad + i } : emision,
        );
      } catch (e) {
        const duplicada =
          e instanceof nest.NestError &&
          e.status === 409 &&
          unidad > 0 &&
          i < MAX_UNIDADES - 1;
        if (!duplicada) throw e;
        logger.warn(
          `[cotizaciones-rc] ${codigo}: póliza vigente con la unidad ${unidad + i}; se prueba la siguiente`,
        );
      }
    }
    if (!poliza) throw new Error('No se pudo emitir la póliza.');
    logger.info(
      `[cotizaciones-rc] ${codigo}: emitida ${poliza.cnpoliza} recibo ${poliza.cnrecibo}`,
    );

    const cobro = poliza.cnrecibo
      ? await cobrar(codigo, poliza, pagado.pago)
      : { ok: false, error: 'La emisión no devolvió número de recibo.' };
    await repo.guardarPoliza(codigo, {
      ...poliza,
      cobro,
      emitidaEn: new Date().toISOString(),
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error(`[cotizaciones-rc] ${codigo}: emisión pagada falló: ${error}`);
    await repo.guardarError(codigo, error);
  }
}

const cobrando = new Set<string>();

/** Admin: reintenta la emisión de una pagada sin póliza, o el cobro de una emitida cuyo recibo quedó pendiente. */
export async function reintentar(codigoRaw: unknown): Promise<FilaCotizacion> {
  const fila = await obtener(codigoRaw);
  const pagado = pagadoDe(fila);
  if (!pagado)
    throw new AppError(
      `La cotización ${fila.codigo} no tiene un pago confirmado.`,
      409,
    );
  if (fila.estado === 'pagada' && !fila.poliza) {
    await emitirPagada(fila.codigo);
  } else if (
    fila.estado === 'emitida' &&
    esObj(fila.poliza) &&
    !(esObj(fila.poliza.cobro) && fila.poliza.cobro.ok === true)
  ) {
    if (cobrando.has(fila.codigo))
      throw new AppError('El cobro de esta cotización ya está en curso.', 409);
    cobrando.add(fila.codigo);
    try {
      const p = fila.poliza;
      const poliza = {
        cnpoliza: String(p.cnpoliza),
        cnrecibo: String(p.cnrecibo ?? ''),
        urlpoliza: String(p.urlpoliza ?? ''),
      };
      await repo.guardarPoliza(fila.codigo, {
        ...p,
        cobro: await cobrar(fila.codigo, poliza, pagado.pago),
      });
    } finally {
      cobrando.delete(fila.codigo);
    }
  } else {
    throw new AppError(
      `La cotización ${fila.codigo} no tiene nada pendiente (${fila.estado}).`,
      409,
    );
  }
  return obtener(fila.codigo);
}
