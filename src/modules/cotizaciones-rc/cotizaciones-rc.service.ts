/**
 * Cotizaciones del cotizador RC: guardar, buscar, mandar a pagar y emitir como pagada.
 *
 * Pago → emisión (todo del lado servidor):
 *   1. crearCheckout: sesión de Pagos (startCheckoutLink) con notifyUrl a este servicio y un token por intento.
 *   2. El cliente paga en el módulo de Pagos; pagos-api avisa a notifyUrl (POST /pago-callback/:codigo?t=…).
 *   3. confirmarPago: valida token, monto y que la referencia sea un pago verificado en pagos.registros_pago;
 *      reclama la cotización (pendiente_pago → pagada) y dispara la emisión.
 *   4. emitirPagada: nest-api emite (modo cotizador) y cobra el recibo (collection/activate) → emitida.
 *      RCP + RCE son dos pólizas con un solo pago: se emite y se cobra una por ramo; la que ya salió no se reemite.
 * El navegador del cliente nunca emite: solo consulta el estado.
 */
import { randomBytes } from 'crypto';
import logger from '../../utils/logger';
import { AppError } from '../../utils/app-error';
import { startCheckoutLink } from '../flow/flow.service';
import * as repo from './cotizaciones-rc.repo';
import * as nest from './cotizaciones-rc.nest';
import {
  MAX_ADJUNTOS_BYTES,
  MAX_INTENTOS,
  NOMBRE_RAMO,
  OPCIONES,
  adjuntosQueCaben,
  alternativaDe,
  anexosDeCheckout,
  armarCobro,
  armarCorreoPoliza,
  armarPolizaGuardada,
  correoPolizaEnviado,
  correoValido,
  emisionesDeOpcion,
  esObj,
  evaluarRegistros,
  intentoPorToken,
  intentosDe,
  monedaDeCobro,
  montoTolerancia,
  nombrePdfPoliza,
  normalizarCodigo,
  pagoDeNotificacion,
  polizaParcial,
  polizasDe,
  reciboCobrado,
  redondear,
  repartirPago,
  sha256,
  validarCotizacionNueva,
  vencida,
  type FilaCotizacion,
  type IntentoPago,
  type ModoVerificacion,
  type MotivoVerificacion,
  type Opcion,
  type PagoConfirmado,
  type PolizaCotizacion,
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

/**
 * Manda la cotización a pagar: crea el checkout en Pagos por la prima de la opción elegida. Con dos pólizas
 * (RCP + RCE) es un solo pago por la suma de las primas, con una línea por póliza.
 */
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
  const emisiones = emisionesDeOpcion(fila.datos, alt);
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
  const primas = emisiones.map((e) => redondear(Number(e.prima_total)));
  const partesVes = repartirPago(totalVes, primas);
  const polizas = emisiones.map((e, i) => ({
    cramo: Number(e.cramo),
    producto: NOMBRE_RAMO[Number(e.cramo)] ?? 'Responsabilidad Civil',
    prima: primas[i],
  }));

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
      lines:
        polizas.length > 1
          ? polizas.map((p, i) => ({
              label: `${p.producto} · opción ${alt.opcion}`,
              amountVes: partesVes[i],
              ...(moneda === 'USD' ? { amountUsd: p.prima } : {}),
            }))
          : [
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
  // PDF «Condicionado y anexos» de la opción (lo arma el cotizador): se adjunta al correo de la póliza al emitir.
  const anexos = anexosDeCheckout(b.anexos);
  if (anexos) {
    try {
      await repo.guardarAnexos(
        fila.codigo,
        alt.opcion,
        anexos.nombre,
        anexos.pdf,
      );
    } catch (e) {
      logger.warn(
        `[cotizaciones-rc] ${fila.codigo}: no se guardaron los anexos: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else if (b.anexos !== undefined) {
    logger.warn(
      `[cotizaciones-rc] ${fila.codigo}: anexos del checkout descartados (no es un PDF o pasa de ${MAX_ADJUNTOS_BYTES} bytes)`,
    );
  }
  logger.info(
    `[cotizaciones-rc] checkout ${fila.codigo} opcion=${alt.opcion} polizas=${polizas.map((p) => `${p.cramo}:${p.prima}`).join('+')} totalVes=${totalVes} sid=${link.sid} anexos=${anexos ? anexos.pdf.length : 0} bytes`,
  );
  return {
    codigo: fila.codigo,
    opcion: alt.opcion,
    prima: alt.prima,
    moneda,
    tasa,
    totalVes,
    polizas,
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

/**
 * Cobra el recibo de una póliza con el pago confirmado. `x.mpago`: la parte del pago de ese recibo cuando el pago
 * cubre varias pólizas; `x.adicional`: no es el primer recibo que se cobra con esa referencia.
 */
async function cobrar(
  codigo: string,
  poliza: nest.PolizaEmitida,
  pago: PagoConfirmado,
  x: { mpago?: number; adicional?: boolean } = {},
): Promise<Obj> {
  if (!poliza.cnrecibo)
    return { ok: false, error: 'La emisión no devolvió número de recibo.' };
  // Una misma referencia de pago móvil no se cobra dos veces de forma automática: la cobranza lo rechaza como
  // «pago ya validado» y ese control no se esquiva. El segundo recibo queda pendiente para caja.
  if (x.adicional) {
    logger.warn(
      `[cotizaciones-rc] ${codigo}: recibo ${poliza.cnrecibo} pendiente para caja (referencia ${pago.referencia} ya aplicada al primer recibo)`,
    );
    return {
      ok: false,
      pendiente: true,
      ...(x.mpago != null ? { mpago: x.mpago } : {}),
      error: `Pendiente de cobro en caja: el pago (referencia ${pago.referencia}) cubre las dos pólizas y ya se aplicó al primer recibo.`,
    };
  }
  try {
    const c = await nest.cobrarRecibo(armarCobro(poliza.cnrecibo, pago, x));
    logger.info(
      `[cotizaciones-rc] ${codigo}: recibo ${poliza.cnrecibo} cobrado${x.mpago != null ? ` (Bs ${x.mpago} de ${pago.monto})` : ''}`,
    );
    return {
      ok: true,
      ...(x.mpago != null ? { mpago: x.mpago } : {}),
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

const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Correo de la póliza al tomador (nest-api mail/send, plantilla `branded`): datos de la póliza, enlace «Ver mi póliza»,
 * el PDF de la póliza, el recibo cobrado (ingreso de caja) y el de condicionado y anexos guardado en el checkout. Sale una sola vez (reclamo atómico) y
 * solo para cotizaciones pagadas. Con varias pólizas (RCP + RCE) es un único correo con todas las pólizas y sus
 * recibos cobrados. Nunca lanza: un fallo de correo no toca la emisión; queda en crc_correo_poliza.
 */
export async function enviarCorreoPoliza(codigo: string): Promise<void> {
  try {
    if (!(await repo.reclamarCorreoPoliza(codigo, new Date().toISOString())))
      return;
  } catch (e) {
    logger.error(
      `[cotizaciones-rc] ${codigo}: correo de la póliza sin reclamar: ${e instanceof Error ? e.message : String(e)}`,
    );
    return;
  }
  const intentadoEn = new Date().toISOString();
  let a: string | null = null;
  try {
    const fila = await repo.porCodigo(codigo);
    const pagado = fila && pagadoDe(fila);
    const polizas = fila ? polizasDe(fila.poliza) : [];
    if (!fila || !pagado || !polizas.length)
      throw new Error('La cotización no tiene póliza pagada.');
    if (!correoValido(fila.tomadorCorreo))
      throw new Error('La cotización no tiene un correo válido del tomador.');
    a = String(fila.tomadorCorreo).trim().toLowerCase();

    let anexos: { nombre: string; pdf: Buffer } | null = null;
    try {
      anexos = (await repo.anexosDe(codigo, pagado.opcion)) ?? null;
    } catch (e) {
      logger.warn(
        `[cotizaciones-rc] ${codigo}: no se leyeron los anexos: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Recibo solo si quedó cobrado: collection/activate devuelve el enlace del ingreso de caja.
    const urlRecibo = (p: PolizaCotizacion): string =>
      reciboCobrado(p) && p.cobro?.ingresoCaja
        ? String(p.cobro.ingresoCaja)
        : '';
    const bajar = (url: string) =>
      url ? nest.descargarPdf(url, MAX_ADJUNTOS_BYTES) : null;
    const [pdfPolizas, pdfRecibos] = await Promise.all([
      Promise.all(polizas.map((p) => bajar(p.urlpoliza))),
      Promise.all(polizas.map((p) => bajar(urlRecibo(p)))),
    ]);
    const { adjuntos, sinPdfPoliza, total } = adjuntosQueCaben({
      polizas: polizas.map((p, i) => {
        const pdf = pdfPolizas[i];
        return pdf ? { nombre: nombrePdfPoliza(p.cnpoliza), pdf } : null;
      }),
      recibos: polizas.map((p, i) => {
        const pdf = pdfRecibos[i];
        return pdf
          ? { nombre: `Recibo_${p.cnrecibo || p.cnpoliza}.pdf`, pdf }
          : null;
      }),
      anexos,
      esperadas: polizas.length,
    });
    const numeros = polizas.map((p) => p.cnpoliza).join(' y ');
    let prima: number | null = null;
    try {
      prima = alternativaDe(fila.datos, pagado.opcion).prima;
    } catch {
      prima = null;
    }
    const peso = (b: Uint8Array | null | undefined, sin: string) =>
      b ? kb(b.length) : sin;
    logger.info(
      `[cotizaciones-rc] ${codigo}: enviando correo de la póliza ${numeros} ` +
        `poliza=${pdfPolizas.map((b) => peso(b, 'sin PDF')).join('+')} recibo=${polizas.map((p, i) => peso(pdfRecibos[i], urlRecibo(p) ? 'sin PDF' : 'no')).join('+')} ` +
        `anexos=${peso(anexos?.pdf, 'no')} adjuntos=${adjuntos.length} (${adjuntos.map((x) => x.nombre).join(', ') || 'solo enlace'}) total=${kb(total)}`,
    );
    const r = await nest.enviarCorreo(
      armarCorreoPoliza(
        fila,
        polizas,
        prima,
        adjuntos,
        !!anexos && adjuntos.includes(anexos),
      ),
    );
    if (!r.sent) throw new Error(r.error || 'nest-api no envió el correo.');
    await repo.guardarCorreoPoliza(codigo, {
      enviadoEn: new Date().toISOString(),
      a,
      adjuntos: adjuntos.map((x) => x.nombre),
      ...(sinPdfPoliza ? { sinPdfPoliza: true } : {}),
    });
    logger.info(
      `[cotizaciones-rc] ${codigo}: correo de la póliza ${numeros} enviado`,
    );
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    logger.error(
      `[cotizaciones-rc] ${codigo}: correo de la póliza falló: ${error}`,
    );
    try {
      await repo.guardarCorreoPoliza(codigo, { error, intentadoEn, a });
    } catch {
      // Sin BD no queda registro; el log ya lo tiene.
    }
  }
}

/** Emite una póliza en nest-api; con unidad (ramo 28), si ya hay una vigente prueba la siguiente. */
async function emitirUna(
  codigo: string,
  emision: Obj,
): Promise<nest.PolizaEmitida> {
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
    `[cotizaciones-rc] ${codigo}: emitida ${poliza.cnpoliza} recibo ${poliza.cnrecibo} (ramo ${String(emision.cramo)})`,
  );
  return poliza;
}

/**
 * Emite en nest-api la cotización pagada y cobra los recibos. Solo corre con la cotización reclamada.
 * Una póliza por body de emisión de la opción (RCP + RCE: dos). Con varias, cada póliza se guarda al salir
 * (crc_poliza.parcial): si la siguiente falla, la cotización queda pagada con el error y el reintento emite solo la
 * que falta. El pago se reparte entre los recibos en proporción a la prima de cada póliza.
 */
export async function emitirPagada(codigo: string): Promise<void> {
  if (!(await repo.reclamarEmision(codigo))) return;
  let emitida = false;
  try {
    const fila = await repo.porCodigo(codigo);
    const pagado = fila && pagadoDe(fila);
    if (!fila || !pagado)
      throw new Error('La cotización no tiene un pago confirmado.');
    const alt = alternativaDe(fila.datos, pagado.opcion);
    const emisiones = emisionesDeOpcion(fila.datos, alt);
    const varias = emisiones.length > 1;
    const primas = emisiones.map((e) => redondear(Number(e.prima_total)));
    const partes = repartirPago(pagado.pago.monto, primas);
    // Pólizas que salieron en un intento anterior: no se vuelven a emitir.
    const previas = polizaParcial(fila.poliza) ? polizasDe(fila.poliza) : [];
    const polizas: PolizaCotizacion[] = [];
    const guardarAvance = async () => {
      if (varias)
        await repo.guardarPolizaParcial(
          codigo,
          armarPolizaGuardada(polizas, true),
        );
    };

    for (const [i, e] of emisiones.entries()) {
      const cramo = Number(e.cramo);
      let p = previas.find((x) => x.cramo === cramo);
      if (p) {
        logger.info(
          `[cotizaciones-rc] ${codigo}: la póliza del ramo ${cramo} ya estaba emitida (${p.cnpoliza}); no se reemite`,
        );
      } else {
        const nueva = await emitirUna(codigo, { ...e, ncotizacion: codigo });
        p = {
          ...(varias
            ? { cramo, cotizador: String(e.cotizador ?? ''), prima: primas[i] }
            : {}),
          ...nueva,
          emitidaEn: new Date().toISOString(),
        };
      }
      polizas.push(p);
      await guardarAvance();
      if (!reciboCobrado(p)) {
        p.cobro = await cobrar(
          codigo,
          p,
          pagado.pago,
          varias
            ? {
                mpago: partes[i],
                adicional: polizas.some((o) => o !== p && reciboCobrado(o)),
              }
            : {},
        );
        await guardarAvance();
      }
    }
    await repo.guardarPoliza(
      codigo,
      varias ? armarPolizaGuardada(polizas) : polizas[0],
    );
    emitida = true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.error(`[cotizaciones-rc] ${codigo}: emisión pagada falló: ${error}`);
    await repo.guardarError(codigo, error);
  }
  // Fuera del try: el correo nunca convierte una póliza emitida en un error de emisión.
  if (emitida) await enviarCorreoPoliza(codigo);
}

const cobrando = new Set<string>();

/**
 * Admin: reintenta la emisión de una pagada sin póliza (o con una de sus dos pólizas sin emitir), el cobro de una
 * emitida con algún recibo pendiente y el correo de la póliza si no se llegó a enviar (ya enviado no se repite).
 */
export async function reintentar(codigoRaw: unknown): Promise<FilaCotizacion> {
  const fila = await obtener(codigoRaw);
  const pagado = pagadoDe(fila);
  if (!pagado)
    throw new AppError(
      `La cotización ${fila.codigo} no tiene un pago confirmado.`,
      409,
    );
  const polizas = polizasDe(fila.poliza);
  const emitidas = fila.estado === 'emitida' && polizas.length > 0;
  if (
    fila.estado === 'pagada' &&
    (!fila.poliza || polizaParcial(fila.poliza))
  ) {
    // Sin póliza o con la emisión a medias (RCP + RCE): emite solo lo que falta.
    await emitirPagada(fila.codigo);
  } else if (
    emitidas &&
    polizas.every(reciboCobrado) &&
    !correoPolizaEnviado(fila.correoPoliza)
  ) {
    await enviarCorreoPoliza(fila.codigo);
  } else if (emitidas && !polizas.every(reciboCobrado)) {
    if (cobrando.has(fila.codigo))
      throw new AppError('El cobro de esta cotización ya está en curso.', 409);
    cobrando.add(fila.codigo);
    try {
      const varias = polizas.length > 1;
      const partes = repartirPago(
        pagado.pago.monto,
        polizas.map((p) => p.prima ?? 1),
      );
      // Solo los recibos que quedaron sin cobrar; cada uno por su parte del pago.
      for (const [i, p] of polizas.entries()) {
        if (reciboCobrado(p)) continue;
        p.cobro = await cobrar(
          fila.codigo,
          p,
          pagado.pago,
          varias
            ? {
                mpago: partes[i],
                adicional: polizas.some((o) => o !== p && reciboCobrado(o)),
              }
            : {},
        );
      }
      await repo.guardarPoliza(
        fila.codigo,
        varias
          ? { ...(fila.poliza as Obj), ...armarPolizaGuardada(polizas) }
          : { ...(fila.poliza as Obj), cobro: polizas[0].cobro },
      );
    } finally {
      cobrando.delete(fila.codigo);
    }
    await enviarCorreoPoliza(fila.codigo);
  } else {
    throw new AppError(
      `La cotización ${fila.codigo} no tiene nada pendiente (${fila.estado}).`,
      409,
    );
  }
  return obtener(fila.codigo);
}
