/**
 * Reglas puras del monitor de expedientes (sin BD): estados, alcance,
 * cadencia, enmascarado y comparación OCR vs snapshot.
 */

export const ESTADOS_REQUISITO = [
  'faltante',
  'recibido',
  'observado',
  'validado',
  /** La emisión no informó documentos (registro viejo o personas sin wizard). No es faltante. */
  'sin_informacion',
  /**
   * v12: el requisito no se exige en esta póliza (personas: titular que es el mismo tomador,
   * Viajero, o expediente registrado antes de separar los documentos por persona). No es faltante
   * ni pendiente y no genera correos; si llega el archivo, pasa a recibido y se revisa.
   */
  'no_aplica',
  /**
   * v12: el archivo guardado es de otra persona (antes del arreglo del OCR del 23-nov, `pendiente/`
   * usaba nombres fijos y una emisión pisaba el documento de otra). Hay que pedirlo de nuevo: no se
   * vuelve a analizar ese archivo ni se envían correos automáticos por él.
   */
  'sobrescrito',
] as const;
export type EstadoRequisito = (typeof ESTADOS_REQUISITO)[number];

/**
 * sin_informacion: no hay datos para saber si falta algo; no es incompleto ni recibe recordatorios.
 * descartada: póliza registrada sin datos del expediente que no pasó por el OCR (conciliación):
 * no se muestra ni cuenta en la bandeja, indicadores, KPI, recordatorios ni resumen. La fila se conserva.
 */
export type EstadoDocumental =
  | 'completo'
  | 'incompleto'
  | 'sin_informacion'
  | 'descartada';

/** Estado documental de las pólizas descartadas por la conciliación con el OCR. */
export const ESTADO_DESCARTADA = 'descartada';
export type EstadoPago = 'pagada' | 'pendiente';
export type ProductoExpediente = 'rcv' | 'personas' | 'patrimonial';
export type AreaExpediente = 'canal' | 'gestor' | 'productor' | 'desconocida';

export interface AlcanceConfig {
  canales: boolean;
  gestores: boolean;
  productores: boolean;
  /** Pólizas sin metadata de vendedor (registros viejos). */
  desconocida: boolean;
}

export interface ExpedientesConfig {
  alcance: AlcanceConfig;
  validacion: 'manual' | 'automatica';
  cadenciaDias: number[];
  destinatariosResumen: string[];
  horaDiaria: string;
  horaResumen: string;
  requisitosPorProducto: Record<string, string[]>;
}

export const DEFAULT_CONFIG: ExpedientesConfig = {
  alcance: {
    canales: true,
    gestores: true,
    productores: false,
    desconocida: true,
  },
  // Automática por defecto: la IA valida cada documento contra la póliza; lo manual es la excepción.
  validacion: 'automatica',
  cadenciaDias: [0, 3, 7, 14],
  destinatariosResumen: [],
  horaDiaria: '08:00',
  horaResumen: '23:00',
  requisitosPorProducto: {
    rcv: ['cedula', 'licencia', 'certificado'],
    // v12: documento del tomador (cédula o RIF) y cédula del titular por separado, como los pide el
    // OCR al emitir. La del titular depende de la póliza (ver `exigenciaRequisito`). La del
    // beneficiario no se pide: la emisión no manda los beneficiarios a Nexus.
    personas: ['cedula', 'cedula_titular'],
    patrimonial: ['cedula'],
  },
};

/** Las 8 claves de documento de la mesa técnica. */
export const REQUISITO_LABELS: Record<string, string> = {
  cedula: 'Cédula de identidad',
  cedula_titular: 'Cédula del titular',
  cedula_beneficiario: 'Cédula del beneficiario',
  licencia: 'Licencia de conducir',
  certificado: 'Certificado de circulación',
  rif: 'RIF',
  pasaporte: 'Pasaporte',
  factura: 'Factura',
};

export function requisitoLabel(tipo: string): string {
  return REQUISITO_LABELS[tipo] ?? tipo;
}

// ─── v12: documentos por persona (personas) ─────────────────────────────────

function recD(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function txtD(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s || null;
}

/** Tipo (V/E/J/G/P/C) y número sin ceros a la izquierda de una persona del snapshot. */
function identPersona(v: unknown): { tipo: string | null; numero: string } {
  const r = recD(v);
  const raw =
    txtD(r.documento) ??
    txtD(r.identificacion) ??
    txtD(r.cedula) ??
    txtD(r.rif);
  const id = separarIdentificacion(raw);
  const tipo =
    txtD(r.tipoDoc ?? r.tipo_doc)
      ?.toUpperCase()
      .slice(0, 1) ??
    id.tipoDoc ??
    null;
  return { tipo, numero: (id.documento ?? '').replace(/^0+(?=.)/, '') };
}

const TIPOS_JURIDICOS = new Set(['J', 'G', 'C']);

/** Expediente con lo necesario para saber qué documentos de personas se exigen. */
export interface ExpedienteRequisitos {
  producto: string;
  snapshot?: unknown;
  aseguradoTipoDoc?: string | null;
  aseguradoDocumento?: string | null;
}

/** v12: el tomador de la póliza es persona jurídica (J/G/C), según el snapshot del expediente. */
export function tomadorEsJuridico(e: ExpedienteRequisitos): boolean {
  const tom = identPersona(recD(e.snapshot).tomador);
  return !!tom.tipo && TIPOS_JURIDICOS.has(tom.tipo);
}

/** v12: Viajero (cproducto 25/26, como el OCR, o plan Viajero): la cédula del titular es opcional. */
export function esViajero(e: ExpedienteRequisitos): boolean {
  const snap = recD(e.snapshot);
  const cprod = txtD(snap.cproducto);
  if (cprod === '25' || cprod === '26') return true;
  return [snap.plan, snap.planNombre].some((p) => /VIAJ/i.test(txtD(p) ?? ''));
}

/** Requisitos que dependen de la póliza (solo personas). */
export const REQUISITOS_CONDICIONALES = new Set(['cedula_titular']);

export const MOTIVO_NO_APLICA_TITULAR_TOMADOR =
  'El titular es el mismo tomador: vale el documento del tomador.';
export const MOTIVO_NO_APLICA_SIN_DATOS =
  'La póliza no trae en Nexus un titular distinto del tomador: vale el documento del tomador.';
export const MOTIVO_NO_APLICA_VIAJERO =
  'Viajero: la cédula del titular es opcional.';
/** Expediente registrado antes de separar los documentos por persona: no se pide el requisito nuevo. */
export const MOTIVO_NO_APLICA_PREVIO =
  'Requisito agregado después de registrar la póliza: no se pide (si llega el documento, se revisa).';

/**
 * v12: ¿se exige este requisito en la póliza? En personas, la cédula del titular no se exige si el
 * titular es el mismo tomador (misma cédula: un solo documento) ni en Viajero (opcional en el OCR).
 * Sin titular distinto del tomador en el expediente, tampoco. Lo demás se exige siempre.
 */
export function exigenciaRequisito(
  tipo: string,
  e: ExpedienteRequisitos,
): { exigido: boolean; motivo: string | null } {
  if (e.producto !== 'personas' || !REQUISITOS_CONDICIONALES.has(tipo))
    return { exigido: true, motivo: null };
  if (esViajero(e)) return { exigido: false, motivo: MOTIVO_NO_APLICA_VIAJERO };
  const snap = recD(e.snapshot);
  const tom = identPersona(snap.tomador);
  const delSnap = identPersona(snap.titular ?? snap.asegurado);
  const tit = delSnap.numero
    ? delSnap
    : identPersona({
        tipoDoc: e.aseguradoTipoDoc,
        documento: e.aseguradoDocumento,
      });
  // RIF personal del tomador natural (cédula + dígito verificador) = la misma persona.
  const mismaPersona =
    !!tom.numero &&
    !TIPOS_JURIDICOS.has(tom.tipo ?? '') &&
    (tom.numero === tit.numero ||
      (tom.numero.length === tit.numero.length + 1 &&
        tom.numero.startsWith(tit.numero)) ||
      (tit.numero.length === tom.numero.length + 1 &&
        tit.numero.startsWith(tom.numero)));
  if (mismaPersona)
    return { exigido: false, motivo: MOTIVO_NO_APLICA_TITULAR_TOMADOR };
  // Sin el tomador o sin el titular en Nexus no se sabe si son personas distintas: un solo documento.
  if (!tom.numero || !tit.numero)
    return { exigido: false, motivo: MOTIVO_NO_APLICA_SIN_DATOS };
  return { exigido: true, motivo: null };
}

/**
 * Estado de un requisito aplicable que aún no tiene fila: faltante (o sin_informacion si la emisión
 * no informó documentos). v12: un condicional sin fila es de un expediente anterior → no_aplica.
 */
export function estadoSinFila(tipo: string, infoDocumental = true): string {
  if (REQUISITOS_CONDICIONALES.has(tipo)) return 'no_aplica';
  return infoDocumental ? 'faltante' : 'sin_informacion';
}

/**
 * v12: rótulo del requisito en la póliza. En personas, `cedula` es el documento del tomador: «RIF
 * del tomador» si es persona jurídica, «Cédula del tomador» si es natural. RCV y patrimoniales igual.
 */
export function requisitoLabelDe(
  tipo: string,
  e: ExpedienteRequisitos,
): string {
  if (tipo === 'cedula' && e.producto === 'personas')
    return tomadorEsJuridico(e) ? 'RIF del tomador' : 'Cédula del tomador';
  return requisitoLabel(tipo);
}

/** Los gestores trabajan para los canales: su alcance es el de canales. */
function gestoresSiguenCanales(a: AlcanceConfig): AlcanceConfig {
  return { ...a, gestores: a.canales };
}

/** Área visible: gestor cuenta como canal (el dato guardado no cambia). */
export function areaVisible(area: string): string {
  return area === 'gestor' ? 'canal' : area;
}

export function mergeConfig(raw: unknown): ExpedientesConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<
    ExpedientesConfig & { alcance: Partial<AlcanceConfig> }
  >;
  return {
    alcance: gestoresSiguenCanales({
      ...DEFAULT_CONFIG.alcance,
      ...(r.alcance ?? {}),
    }),
    validacion:
      r.validacion === 'automatica' || r.validacion === 'manual'
        ? r.validacion
        : DEFAULT_CONFIG.validacion,
    cadenciaDias:
      Array.isArray(r.cadenciaDias) && r.cadenciaDias.length
        ? [...r.cadenciaDias].map(Number).sort((a, b) => a - b)
        : [...DEFAULT_CONFIG.cadenciaDias],
    destinatariosResumen: Array.isArray(r.destinatariosResumen)
      ? r.destinatariosResumen.map(String)
      : [],
    horaDiaria: r.horaDiaria || DEFAULT_CONFIG.horaDiaria,
    horaResumen: r.horaResumen || DEFAULT_CONFIG.horaResumen,
    requisitosPorProducto: conTitularEnPersonas({
      ...DEFAULT_CONFIG.requisitosPorProducto,
      ...(r.requisitosPorProducto ?? {}),
    }),
  };
}

/**
 * v12: la configuración guardada antes del cambio trae personas = ['cedula'] (el portal no edita
 * los requisitos: se guardaba el valor por defecto de entonces). Se agrega la cédula del titular.
 */
function conTitularEnPersonas(
  req: Record<string, string[]>,
): Record<string, string[]> {
  const personas = Array.isArray(req.personas) ? req.personas : null;
  if (!personas?.includes('cedula') || personas.includes('cedula_titular'))
    return req;
  return { ...req, personas: [...personas, 'cedula_titular'] };
}

// ─── Producto, área y alcance ──────────────────────────────────────────────

export function normalizarProducto(
  producto?: string | null,
  hint?: string | null,
): ProductoExpediente {
  const h = String(hint ?? '')
    .trim()
    .toLowerCase();
  if (h === 'rcv' || h === 'personas' || h === 'patrimonial') return h;
  const p = String(producto ?? '').toLowerCase();
  if (p.includes('rcv')) return 'rcv';
  if (p.includes('patrimon')) return 'patrimonial';
  return 'personas';
}

/**
 * C = canal alterno, G = gestor, P = productor (P con cgestor = gestor). Desde el SSO y el feed
 * llegan C, G y P; cualquier otra entidad informada se toma como de canal. Sin datos: desconocida.
 */
export function areaDesdeVendedor(v: {
  centidad?: string | null;
  cgestor?: string | null;
  ccanalalt?: string | null;
}): AreaExpediente {
  const c = String(v.centidad ?? '')
    .trim()
    .toUpperCase();
  if (c === 'C') return 'canal';
  if (c === 'G') return 'gestor';
  if (c === 'P') return v.cgestor ? 'gestor' : 'productor';
  if (v.cgestor) return 'gestor';
  if (v.ccanalalt) return 'canal';
  // Puntos de comercialización, subcanales u otra entidad de canal: cuentan en Canales.
  if (c) return 'canal';
  return 'desconocida';
}

/**
 * Solo hay dos áreas visibles: Canales y Productores. Los gestores trabajan para los canales:
 * sus pólizas (area = gestor, dato guardado sin cambios) cuentan como canal y siguen el alcance
 * de canales. `alcance.gestores` se ignora.
 */
export function areasEnAlcance(alcance: AlcanceConfig): AreaExpediente[] {
  const out: AreaExpediente[] = [];
  if (alcance.canales) out.push('canal', 'gestor');
  if (alcance.productores) out.push('productor');
  if (alcance.desconocida) out.push('desconocida');
  return out;
}

export function enAlcance(area: string, alcance: AlcanceConfig): boolean {
  return (areasEnAlcance(alcance) as string[]).includes(area);
}

// ─── Exclusiones «No enviar» ──────────────────────────────────────────────

/** Actores por los que se puede excluir en lote: ccanalalt, cgestor y cproductor. */
export const TIPOS_ACTOR = ['canal', 'gestor', 'intermediario'] as const;
export type TipoActor = (typeof TIPOS_ACTOR)[number];

/** Orden también de prioridad al explicar por qué una póliza no recibe correos. */
export const ALCANCES_EXCLUSION = [
  'poliza',
  'asegurado',
  ...TIPOS_ACTOR,
] as const;
export type AlcanceExclusion = (typeof ALCANCES_EXCLUSION)[number];

export function esTipoActor(v: string): v is TipoActor {
  return (TIPOS_ACTOR as readonly string[]).includes(v);
}

/** Código de canal/gestor/productor comparable: sin espacios y en mayúsculas. */
export function normalizarCodigoActor(v?: string | null): string | null {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  return s ? s.slice(0, 64) : null;
}

export interface VendedorActores {
  centidad?: string | null;
  citem?: string | null;
  cgestor?: string | null;
  ccanalalt?: string | null;
  cproductor?: string | null;
}

/**
 * Código del actor de la póliza. Si la emisión no trajo el código propio, se usa citem
 * cuando centidad coincide (C = canal, G = gestor, P = productor), como en los
 * registros anteriores a la columna cproductor.
 */
export function valorActor(e: VendedorActores, tipo: TipoActor): string | null {
  const c = String(e.centidad ?? '')
    .trim()
    .toUpperCase();
  const porEntidad = (letra: string) => (c === letra ? e.citem : null);
  if (tipo === 'canal')
    return normalizarCodigoActor(e.ccanalalt ?? porEntidad('C'));
  if (tipo === 'gestor')
    return normalizarCodigoActor(e.cgestor ?? porEntidad('G'));
  return normalizarCodigoActor(e.cproductor ?? porEntidad('P'));
}

// ─── «Emitida por» ───────────────────────────────────────────────────────────

/** Catálogos (opcionales) para nombrar a quien emitió. Claves normalizadas. */
export interface NombresActores {
  /** ccanalalt → nombre del canal. */
  canal?: Map<string, string> | null;
  /** cgestor → nombre del gestor (punto de comercialización). */
  gestor?: Map<string, string> | null;
  /** cgestor → ccanalalt del canal al que pertenece. */
  gestorCanal?: Map<string, string> | null;
}

/** «Nombre (canal N)» o «Canal N». */
export function textoCanal(
  cod: string,
  nombres?: NombresActores | null,
): string {
  const n = nombres?.canal?.get(normalizarCodigoActor(cod) ?? '') ?? null;
  return n ? `${n} (canal ${cod})` : `Canal ${cod}`;
}

/**
 * Código de gestor de Sis2000: número o compuesto productor-gestor («348-342»). Un login o
 * correo (el `cgestor_in` del SSO de SysIP, p. ej. «agonzale@lam…») no lo es.
 */
export function esCodigoGestor(v?: string | null): boolean {
  return /^\d+(-\d+)*$/.test(String(v ?? '').trim());
}

/** Número del gestor (último tramo de «348-342»). */
function numeroGestor(cod: string): string {
  const partes = cod.split('-');
  return partes[partes.length - 1];
}

export interface EmisorTexto {
  /**
   * Texto «emitida por». Nunca un login, correo ni cusuario (fix 12-nov-2026). Null: no se pudo
   * identificar canal ni productor (la póliza va a «Pendientes de identificar canal»).
   */
  texto: string | null;
  /** Sin canal ni productor resuelto: pendiente de identificar (lo corrige el relleno). */
  canalSinIdentificar: boolean;
  /** Canal resuelto (ccanalalt de la póliza o el del gestor en el catálogo). */
  canal: string | null;
  /** Grupo visible resuelto: canal, productor o null (pendiente de identificar canal). */
  grupo: 'canal' | 'productor' | null;
  /** Productor resuelto cuando el grupo es Productores (cproductor, citem P o prefijo del gestor). */
  productor?: string | null;
}

/** Prefijo de un gestor compuesto («80080-1219» → 80080) cuando no es un canal conocido. */
export function prefijoProductorDeGestor(
  gestor: string | null,
  nombres?: NombresActores | null,
): string | null {
  if (!gestor || !gestor.includes('-')) return null;
  const pre = gestor.split('-')[0];
  if (!pre || /^0+$/.test(pre) || nombres?.canal?.has(pre)) return null;
  return pre;
}

/**
 * Quién emitió, para «emitida por» (Monitor, reporte nocturno y Excel). Solo existen Canales y
 * Productores; nunca un login, correo ni usuario.
 * - Canal: «Nombre (canal 27)» o «Canal 27».
 * - Gestor con canal (ccanalalt de la póliza o magestor): «Nombre (canal 27-749)».
 * - Gestor sin canal pero con productor (cproductor, citem si centidad = P o el prefijo de un
 *   gestor compuesto «80080-1219»): Productores, «Nombre (productor 80080)», sin la palabra «gestor».
 * - Productor: «Productor N» / «Nombre (productor N)», con el canal delante si la póliza lo trae.
 * - Nada de lo anterior: texto null y `canalSinIdentificar` (pendiente de identificar canal).
 */
export function textoEmisor(
  e: VendedorActores & { area?: string | null },
  nombres?: NombresActores | null,
  nombresSnapshot: { canal?: string | null; productor?: string | null } = {},
): EmisorTexto {
  const c = String(e.centidad ?? '')
    .trim()
    .toUpperCase();
  const gestorRaw = valorActor(e, 'gestor');
  const esGestor = !!gestorRaw && (c === 'G' || !!e.cgestor);
  const gestor = esGestor && esCodigoGestor(gestorRaw) ? gestorRaw : null;
  const canalDirecto = valorActor(e, 'canal');
  const canalDelGestor = gestor
    ? (nombres?.gestorCanal?.get(gestor) ??
      nombres?.gestorCanal?.get(numeroGestor(gestor)))
    : undefined;
  const canal = canalDirecto ?? normalizarCodigoActor(canalDelGestor);
  const sufijo = gestor ? `-${numeroGestor(gestor)}` : '';
  const textoDeCanal = (() => {
    if (!canal) return null;
    const n =
      nombres?.canal?.get(canal) ??
      (canalDirecto ? (nombresSnapshot.canal ?? null) : null);
    return n ? `${n} (canal ${canal}${sufijo})` : `Canal ${canal}${sufijo}`;
  })();
  const productor = valorActor(e, 'intermediario');
  const grupo = e.area ? grupoArea(e.area) : 'desconocida';
  const textoProductor = (cod: string | null) =>
    cod
      ? nombresSnapshot.productor
        ? `${nombresSnapshot.productor} (productor ${cod})`
        : `Productor ${cod}`
      : (nombresSnapshot.productor ?? null);

  const deProductor =
    grupo === 'productor' ||
    (grupo !== 'canal' &&
      !esGestor &&
      c !== 'C' &&
      (!!nombresSnapshot.productor ||
        (!!productor && (c === 'P' || !!e.cproductor))));
  if (deProductor) {
    const p = textoProductor(productor);
    const texto =
      [canalDirecto ? textoDeCanal : null, p].filter(Boolean).join(' · ') ||
      null;
    return {
      texto,
      canalSinIdentificar: !texto,
      canal: canalDirecto,
      grupo: texto ? 'productor' : null,
      productor: texto ? productor : null,
    };
  }

  if (textoDeCanal)
    return {
      texto: textoDeCanal,
      canalSinIdentificar: false,
      canal,
      grupo: 'canal',
    };
  // Gestor (o login) sin canal: el productor de la póliza o el prefijo del gestor compuesto.
  const prodGestor =
    productor ?? (gestor ? prefijoProductorDeGestor(gestor, nombres) : null);
  if (prodGestor || nombresSnapshot.productor) {
    const p = textoProductor(prodGestor);
    return {
      texto: p,
      canalSinIdentificar: false,
      canal: null,
      grupo: 'productor',
      productor: prodGestor,
    };
  }
  return { texto: null, canalSinIdentificar: true, canal: null, grupo: null };
}

/** Grupo visible resuelto: canal, productor o null (pendiente de identificar canal). */
export function grupoEmisor(
  e: VendedorActores & { area?: string | null },
  nombres?: NombresActores | null,
  nombresSnapshot: { canal?: string | null; productor?: string | null } = {},
): 'canal' | 'productor' | null {
  return textoEmisor(e, nombres, nombresSnapshot).grupo;
}

// ─── Áreas visibles: Canales y Productores ──────────────────────────────────

/** Código del grupo «Canal sin identificar» / «Productor sin identificar». */
export const SIN_IDENTIFICAR = 'SIN_IDENTIFICAR';

/** Grupo visible del área guardada: gestor → canal. */
export function grupoArea(area: string): 'canal' | 'productor' | 'desconocida' {
  if (area === 'canal' || area === 'gestor') return 'canal';
  if (area === 'productor') return 'productor';
  return 'desconocida';
}

/**
 * Canal al que pertenece una póliza de área canal o gestor: ccanalalt (o citem si centidad = C);
 * si es de un gestor sin ccanalalt, el canal del gestor en el catálogo de nest-api. Si no se
 * puede resolver: SIN_IDENTIFICAR (nunca se descarta).
 */
export function canalDeExpediente(
  e: VendedorActores,
  gestorCanal?: Map<string, string> | null,
): string {
  const directo = valorActor(e, 'canal');
  if (directo) return directo;
  const gestor = valorActor(e, 'gestor');
  const delCatalogo = gestor ? gestorCanal?.get(gestor) : undefined;
  return normalizarCodigoActor(delCatalogo) ?? SIN_IDENTIFICAR;
}

/** Productor (intermediario) de una póliza de área productor, o SIN_IDENTIFICAR. */
export function productorDeExpediente(e: VendedorActores): string {
  return valorActor(e, 'intermediario') ?? SIN_IDENTIFICAR;
}

// ─── Estados ────────────────────────────────────────────────────────────────

export function requisitosAplicables(
  producto: string,
  config: ExpedientesConfig,
): string[] {
  const list = config.requisitosPorProducto[producto] ??
    DEFAULT_CONFIG.requisitosPorProducto[producto] ?? ['cedula'];
  return Array.from(new Set(list));
}

/**
 * Completo SOLO si todos los requisitos aplicables están validados.
 * Si lo único no validado es "sin_informacion", el expediente es sin_informacion
 * (no se sabe si falta algo: no cuenta como incompleto).
 */
export function calcularEstadoDocumental(
  aplicables: string[],
  requisitos: { tipo: string; estado: string }[],
): EstadoDocumental {
  if (!aplicables.length) return 'incompleto';
  const porTipo = new Map(requisitos.map((r) => [r.tipo, r.estado]));
  // v12: lo que no se exige en la póliza (no_aplica) no cuenta: ni falta ni completa.
  const estados = aplicables
    .map((t) => porTipo.get(t) ?? estadoSinFila(t))
    .filter((e) => e !== 'no_aplica');
  if (!estados.length) return 'incompleto';
  if (estados.every((e) => e === 'validado')) return 'completo';
  if (estados.every((e) => e === 'validado' || e === 'sin_informacion'))
    return 'sin_informacion';
  return 'incompleto';
}

export function esPendiente(estado: string): boolean {
  return estado === 'faltante' || estado === 'observado';
}

export function normalizarEstadoPago(...vals: unknown[]): EstadoPago {
  for (const v of vals) {
    const s = String(v ?? '')
      .trim()
      .toLowerCase();
    if (s === 'pendiente' || s === 'pendiente_pago') return 'pendiente';
    if (s === 'pagada' || s === 'pagado') return 'pagada';
  }
  return 'pagada';
}

// ─── Asegurado y datos personales ──────────────────────────────────────────

export function soloDigitos(v?: string | null): string {
  return String(v ?? '').replace(/\D/g, '');
}

/** "V-12.345.678" → { tipoDoc: 'V', documento: '12345678' } */
export function separarIdentificacion(v?: string | null): {
  tipoDoc?: string;
  documento?: string;
} {
  const s = String(v ?? '')
    .trim()
    .toUpperCase();
  if (!s) return {};
  const m = s.match(/^([VEJGPC])\s*-?\s*(.+)$/);
  if (m) return { tipoDoc: m[1], documento: soloDigitos(m[2]) || undefined };
  return { documento: soloDigitos(s) || undefined };
}

export function aseguradoKey(a: {
  tipoDoc?: string | null;
  documento?: string | null;
  email?: string | null;
}): string | null {
  const doc = soloDigitos(a.documento);
  if (doc) return `${String(a.tipoDoc ?? 'V').toUpperCase()}${doc}`;
  const email = String(a.email ?? '')
    .trim()
    .toLowerCase();
  return email ? `mail:${email}` : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailValido(v?: string | null): boolean {
  const s = String(v ?? '').trim();
  return s.length <= 200 && EMAIL_RE.test(s);
}

export function maskEmail(v?: string | null): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const [user, domain] = s.split('@');
  if (!domain) return '***';
  const u = user.length <= 2 ? `${user[0] ?? ''}*` : `${user.slice(0, 2)}***`;
  return `${u}@${domain}`;
}

/**
 * Destinatarios enmascarados («ab***@x.com, cd***@y.com») recortados a `max` caracteres para
 * mnot_destinatario (VARCHAR(200)): deja los que caben y agrega «+N más».
 */
export function recortarDestinatarios(
  v?: string | null,
  max = 200,
): string | null {
  if (v == null) return null;
  if (v.length <= max) return v;
  const partes = v.split(', ');
  let out = '';
  for (let i = 0; i < partes.length; i++) {
    const cand = out ? `${out}, ${partes[i]}` : partes[i];
    const resto = partes.length - i - 1;
    if ((cand + (resto ? ` +${resto} más` : '')).length > max) {
      return `${out} +${partes.length - i} más`.trim().slice(0, max);
    }
    out = cand;
  }
  return out.slice(0, max);
}

export function maskPoliza(v?: string | null): string {
  const s = String(v ?? '').trim();
  if (s.length <= 4) return '****';
  return `${'*'.repeat(Math.max(4, s.length - 4))}${s.slice(-4)}`;
}

/** Iniciales del asegurado («María José Pérez» → «M. P.»): primer nombre y primer apellido. */
export function inicialesNombre(
  nombre?: string | null,
  apellido?: string | null,
): string {
  const palabras = (v?: string | null) =>
    String(v ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const n = palabras(nombre);
  const a = palabras(apellido);
  const usar = a.length ? [n[0], a[0]] : n.slice(0, 2);
  return usar
    .map((p) => p?.match(/\p{L}/u)?.[0]?.toUpperCase())
    .filter(Boolean)
    .map((l) => `${l}.`)
    .join(' ');
}

/** Documento parcial: «V-12345678» → «V-12•••678». Nunca el número completo. */
export function maskDocumento(
  tipoDoc?: string | null,
  documento?: string | null,
): string {
  const d = soloDigitos(documento);
  if (!d) return '';
  const parcial =
    d.length >= 6
      ? `${d.slice(0, 2)}•••${d.slice(-3)}`
      : d.length >= 3
        ? `${d[0]}•••${d.slice(-1)}`
        : '•••';
  const tipo = String(tipoDoc ?? '')
    .trim()
    .toUpperCase();
  return tipo ? `${tipo}-${parcial}` : parcial;
}

/** Asegurado para reportes: «M. P. · V-12•••678» (sin correo ni teléfono). */
export function aseguradoProtegido(e: {
  aseguradoNombre?: string | null;
  aseguradoApellido?: string | null;
  aseguradoTipoDoc?: string | null;
  aseguradoDocumento?: string | null;
}): string {
  return (
    [
      inicialesNombre(e.aseguradoNombre, e.aseguradoApellido),
      maskDocumento(e.aseguradoTipoDoc, e.aseguradoDocumento),
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

/** Lista blanca fuera de producción: vacía = no se envía nada. */
export function whitelistPermite(
  to: string,
  esProduccion: boolean,
  whitelist: string[],
): boolean {
  if (esProduccion) return true;
  if (!whitelist.length) return false;
  return whitelist.includes(to.trim().toLowerCase());
}

// ─── Hora Caracas (UTC-4 fijo, sin horario de verano) ──────────────────────

const CARACAS_OFFSET_MS = -4 * 60 * 60 * 1000;

export function caracasParts(d: Date = new Date()): {
  fecha: string;
  hora: string;
} {
  const c = new Date(d.getTime() + CARACAS_OFFSET_MS);
  const fecha = c.toISOString().slice(0, 10);
  const hora = c.toISOString().slice(11, 16);
  return { fecha, hora };
}

/** Inicio del día Caracas (fecha YYYY-MM-DD) en UTC. */
export function caracasInicioDia(fecha: string): Date {
  return new Date(`${fecha}T04:00:00.000Z`);
}

export function diasCaracasEntre(desde: Date, hasta: Date): number {
  const a = caracasInicioDia(caracasParts(desde).fecha).getTime();
  const b = caracasInicioDia(caracasParts(hasta).fecha).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function horaValida(h: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(h);
}

// ─── Cadencia ───────────────────────────────────────────────────────────────

/** Días de tolerancia para la última etapa (si la tarea no corrió ese día). */
export const VENTANA_ULTIMA_ETAPA = 3;

/**
 * Etapa que toca hoy, o null. Solo la etapa de la ventana actual y nunca una
 * etapa ya enviada: así un reinicio o una conciliación tardía no repiten ni
 * disparan correos de pólizas viejas.
 */
export function etapaDebida(
  diasDesdeEmision: number,
  cadencia: number[],
  etapaEnviada: number,
): number | null {
  if (diasDesdeEmision < 0 || !cadencia.length) return null;
  let idx = -1;
  for (let i = 0; i < cadencia.length; i++) {
    if (cadencia[i] <= diasDesdeEmision) idx = i;
  }
  if (idx < 0 || idx <= etapaEnviada) return null;
  const last = cadencia.length - 1;
  if (idx === last && diasDesdeEmision >= cadencia[last] + VENTANA_ULTIMA_ETAPA)
    return null;
  return idx;
}

export function cadenciaVencida(
  diasDesdeEmision: number,
  cadencia: number[],
): boolean {
  if (!cadencia.length) return true;
  return (
    diasDesdeEmision >= cadencia[cadencia.length - 1] + VENTANA_ULTIMA_ETAPA
  );
}

export function proximoEnvio(
  emitidaEn: Date,
  cadencia: number[],
  etapaEnviada: number,
  horaDiaria: string,
): Date | null {
  const next = etapaEnviada + 1;
  if (next >= cadencia.length) return null;
  const base = caracasInicioDia(caracasParts(emitidaEn).fecha);
  const [hh, mm] = horaDiaria.split(':').map(Number);
  return new Date(
    base.getTime() + cadencia[next] * 86_400_000 + (hh * 60 + mm) * 60_000,
  );
}

// La validación automática (OCR vs póliza, diagnóstico campo por campo) vive en expedientes.ia.ts.
