/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * v12 (24-nov-2026): documentos por persona en personas y documentos sobrescritos.
 *
 * Caso real de prod (anonimizado): tomador empresa SUPERMERCADO EJEMPLO CA (J-50000001-1) con
 * empleados asegurados en Salud, pólizas pendientes de pago. Antes del arreglo del OCR (45577da)
 * `{empresa}/{RIF}/pendiente/cedula.pdf` tenía nombre fijo: cada emisión pisaba el archivo de la
 * anterior y 4 requisitos quedaron apuntando al mismo archivo (misma huella), que es la cédula del
 * empleado A:
 *   - A, pólizas 7-7 y 9-7: el archivo SÍ es su cédula (falta el RIF de la empresa).
 *   - B: su documento se perdió (la lectura es la cédula de A, que no es de nadie de su póliza).
 *   - C: «recibido» con el mismo archivo (otro caso perdido).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/prisma', async () => {
  const { createFakePrisma } = await import('./test-utils/fake-prisma');
  return { default: createFakePrisma() };
});
vi.mock('../../utils/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import prisma from '../../config/prisma';
import {
  expedientesService as svc,
  MOTIVO_SOBRESCRITO,
  claveArchivo,
} from './expedientes.service';
import {
  calcularEstadoDocumental,
  DEFAULT_CONFIG,
  estadoSinFila,
  exigenciaRequisito,
  mergeConfig,
  MOTIVO_NO_APLICA_PREVIO,
  requisitoLabelDe,
  requisitosAplicables,
} from './expedientes.domain';
import {
  archivoEsDeLaPoliza,
  contextoPoliza,
  lecturasDelArchivo,
  motivoAnalisis,
  VERSION_COMPARADOR,
} from './expedientes.ia';
import { observacionCorta } from './expedientes.reporte';
import { categoriaIncompleto } from './expedientes.categorias';

const db = prisma as any;

/** Datos anonimizados del caso de prod. */
const TOMADOR_J = {
  tipoDoc: 'J',
  documento: '500000011',
  nombre: 'SUPERMERCADO EJEMPLO CA',
};
const EMPLEADO_A = {
  tipoDoc: 'V',
  documento: '17000001',
  nombre: 'PEDRO',
  apellido: 'PEREZ',
};
const EMPLEADO_B = {
  tipoDoc: 'V',
  documento: '17000002',
  nombre: 'LUISA',
  apellido: 'GOMEZ',
};
const EMPLEADO_C = {
  tipoDoc: 'V',
  documento: '17000003',
  nombre: 'MARIO',
  apellido: 'DIAZ',
};
/** El mismo archivo pisado para los 4 requisitos (URL de pendiente/ y huella iguales). */
const REF_PENDIENTE =
  '/files/La%20Mundial%20de%20Seguros/500000011/pendiente/cedula.pdf';
const HUELLA =
  'ca3f80721a92de30aa11bb22cc33dd44ee55ff6600112233445566778899aabb';
/** Lo que el OCR leyó de ese archivo: la cédula del empleado A. */
const CEDULA_A = {
  documentoTipo: 'cedula',
  tipoDoc: 'V',
  identificacion: '17000001',
  nombre: 'PEDRO',
  apellido: 'PEREZ',
};
const RIF_J = {
  documentoTipo: 'rif',
  tipoDoc: 'J',
  rif: 'J500000011',
  identificacion: '500000011',
  razonSocial: 'SUPERMERCADO EJEMPLO C.A.',
};

let fetchMock: ReturnType<typeof vi.fn>;
const ocr = new Map<string, any>();

function respuesta(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function llamadasAnalizar() {
  return fetchMock.mock.calls.filter(([url]: any[]) =>
    String(url).endsWith('/api/internal/expedientes/analizar'),
  );
}

function llamadasCorreo() {
  return fetchMock.mock.calls.filter(
    ([url]: any[]) =>
      !String(url).endsWith('/api/internal/expedientes/analizar'),
  );
}

function req(id: number, tipo: string) {
  return db.mktExpedienteRequisito
    ._rows()
    .find((x: any) => x.expedienteId === id && x.tipo === tipo);
}

function exp(id: number) {
  return db.mktExpediente._rows().find((x: any) => x.id === id);
}

/** Expediente de personas registrado por la emisión (snapshot con tomador y titular). */
async function registrar(
  poliza: string,
  titular: any,
  documentos: Record<string, any> = {},
  tomador: any = TOMADOR_J,
) {
  const r = await svc.registrarDesdeEmision(
    {
      id: Number(poliza.replace(/\D/g, '')) || 1,
      empresaId: 7,
      polizaNumero: poliza,
      jsonData: { producto: 'personas' },
    },
    {
      expediente: {
        centidad: 'C',
        ccanalalt: '900',
        producto: 'personas',
        estadoPago: 'pendiente',
        asegurado: { ...titular, email: 'cliente@test.com' },
        snapshot: { tomador, asegurado: titular, planNombre: 'SALUD' },
        documentos,
      },
    },
  );
  await svc.esperarAnalisisPendientes();
  return r!.id;
}

/**
 * Expediente como quedó en prod antes de v12: solo el requisito `cedula` (sin la fila de la cédula
 * del titular), apuntando al archivo pisado de pendiente/.
 */
async function expedienteAnterior(
  poliza: string,
  titular: any,
  cedula: Record<string, unknown>,
) {
  const id = await registrar(poliza, titular);
  const filas = db.mktExpedienteRequisito._rows();
  const i = filas.findIndex(
    (x: any) => x.expedienteId === id && x.tipo === 'cedula_titular',
  );
  if (i >= 0) filas.splice(i, 1);
  Object.assign(req(id, 'cedula'), {
    ref: REF_PENDIENTE,
    archivoHash: HUELLA,
    origen: 'emision',
    recibidoEn: new Date('2026-11-20T12:00:00Z'),
    ...cedula,
  });
  return id;
}

/** Observado por la IA con el comparador 11 (lo que mostraba prod el 23-nov). */
const OBSERVADO_V11 = {
  estado: 'observado',
  decision: 'ia',
  validadoPor: 'ia',
  analisisRef: REF_PENDIENTE,
  ocrDatos: CEDULA_A,
  ocrConfianza: 1,
  huellaPoliza: 'vieja',
  motivo:
    'Revisar: El tomador es una persona jurídica (J-****0011) y en el archivo no se leyó su RIF…',
  diagnostico: {
    version: 1,
    tipo: 'cedula',
    resultado: 'sin_certeza',
    comparador: 11,
    resumen:
      'El tomador es una persona jurídica (J-****0011) y en el archivo no se leyó su RIF…',
    campos: [],
  },
};

beforeEach(() => {
  db.$reset();
  ocr.clear();
  process.env.EXPEDIENTES_ENABLED = 'true';
  process.env.OCR_INTERNAL_URL = 'http://ocr.local';
  process.env.EXPEDIENTE_INTERNAL_KEY = 'clave-interna';
  process.env.EXPEDIENTES_PUBLIC_URL = 'https://portal.test/portal-lm';
  delete process.env.EXPEDIENTES_MAIL_WHITELIST;
  delete process.env.EXPEDIENTES_ENTORNO;
  delete process.env.EXPEDIENTES_JOBS_ENABLED;
  fetchMock = vi.fn(async (url: string, init: any) => {
    if (String(url).endsWith('/api/internal/expedientes/analizar')) {
      const { ref } = JSON.parse(init.body);
      const extraido = ocr.get(ref);
      if (!extraido)
        return respuesta(404, { ok: false, code: 'ARCHIVO_NO_ENCONTRADO' });
      return respuesta(200, {
        ok: true,
        ref,
        hash: `h-${ref}`,
        ocr: { extraido, confianza: 1, proveedor: 'gemini' },
      });
    }
    return respuesta(200, { status: true, data: { sent: true } });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await svc.esperarAnalisisPendientes();
  vi.unstubAllGlobals();
});

describe('v12: requisitos por persona (reglas puras)', () => {
  const persona = (snapshot: any, extra: any = {}) => ({
    producto: 'personas',
    snapshot,
    ...extra,
  });

  it('la versión del comparador es 12', () => {
    expect(VERSION_COMPARADOR).toBeGreaterThanOrEqual(12);
  });

  it('personas pide el documento del tomador y la cédula del titular; RCV no cambia', () => {
    expect(requisitosAplicables('personas', DEFAULT_CONFIG)).toEqual([
      'cedula',
      'cedula_titular',
    ]);
    expect(requisitosAplicables('rcv', DEFAULT_CONFIG)).toEqual([
      'cedula',
      'licencia',
      'certificado',
    ]);
  });

  it('la configuración guardada antes de v12 (personas = cédula) suma la cédula del titular', () => {
    const cfg = mergeConfig({
      requisitosPorProducto: {
        rcv: ['cedula', 'licencia', 'certificado'],
        personas: ['cedula'],
      },
    });
    expect(cfg.requisitosPorProducto.personas).toEqual([
      'cedula',
      'cedula_titular',
    ]);
    expect(cfg.requisitosPorProducto.rcv).toEqual([
      'cedula',
      'licencia',
      'certificado',
    ]);
  });

  it('la cédula del titular se exige solo si el titular es otra persona', () => {
    // Tomador empresa y empleado titular.
    expect(
      exigenciaRequisito(
        'cedula_titular',
        persona({ tomador: TOMADOR_J, asegurado: EMPLEADO_A }),
      ).exigido,
    ).toBe(true);
    // Titular = tomador (también con el RIF personal del tomador).
    expect(
      exigenciaRequisito(
        'cedula_titular',
        persona({ tomador: EMPLEADO_A, asegurado: EMPLEADO_A }),
      ),
    ).toMatchObject({ exigido: false });
    expect(
      exigenciaRequisito(
        'cedula_titular',
        persona({
          tomador: { ...EMPLEADO_A, documento: '170000019' },
          asegurado: EMPLEADO_A,
        }),
      ).exigido,
    ).toBe(false);
    // Viajero: opcional, como en el OCR.
    expect(
      exigenciaRequisito(
        'cedula_titular',
        persona({ tomador: TOMADOR_J, asegurado: EMPLEADO_A, cproducto: '25' }),
      ).exigido,
    ).toBe(false);
    // Sin tomador en Nexus no se sabe: un solo documento.
    expect(
      exigenciaRequisito('cedula_titular', persona({ asegurado: EMPLEADO_A }))
        .exigido,
    ).toBe(false);
    // RCV y el documento del tomador: siempre.
    expect(
      exigenciaRequisito('cedula', persona({ tomador: TOMADOR_J })).exigido,
    ).toBe(true);
  });

  it('no_aplica no cuenta: ni falta ni completa; sin fila, el condicional no aplica', () => {
    const ap = ['cedula', 'cedula_titular'];
    expect(estadoSinFila('cedula_titular')).toBe('no_aplica');
    expect(estadoSinFila('cedula')).toBe('faltante');
    expect(
      calcularEstadoDocumental(ap, [{ tipo: 'cedula', estado: 'validado' }]),
    ).toBe('completo');
    expect(
      calcularEstadoDocumental(ap, [
        { tipo: 'cedula', estado: 'validado' },
        { tipo: 'cedula_titular', estado: 'no_aplica' },
      ]),
    ).toBe('completo');
    expect(
      calcularEstadoDocumental(ap, [
        { tipo: 'cedula', estado: 'validado' },
        { tipo: 'cedula_titular', estado: 'faltante' },
      ]),
    ).toBe('incompleto');
    expect(
      calcularEstadoDocumental(ap, [
        { tipo: 'cedula', estado: 'sobrescrito' },
        { tipo: 'cedula_titular', estado: 'validado' },
      ]),
    ).toBe('incompleto');
  });

  it('rótulos: RIF del tomador / Cédula del tomador / Cédula del titular; RCV igual que antes', () => {
    const j = persona({ tomador: TOMADOR_J, asegurado: EMPLEADO_A });
    const v = persona({ tomador: EMPLEADO_A, asegurado: EMPLEADO_B });
    expect(requisitoLabelDe('cedula', j)).toBe('RIF del tomador');
    expect(requisitoLabelDe('cedula', v)).toBe('Cédula del tomador');
    expect(requisitoLabelDe('cedula_titular', v)).toBe('Cédula del titular');
    expect(
      requisitoLabelDe('cedula', {
        producto: 'rcv',
        snapshot: { tomador: TOMADOR_J },
      }),
    ).toBe('Cédula de identidad');
  });

  it('un archivo con varios documentos se separa en lecturas; se sabe si es de la póliza', () => {
    const pdf = { ...RIF_J, documentosAdicionales: [CEDULA_A] };
    expect(lecturasDelArchivo(pdf)).toHaveLength(2);
    const ctxA = contextoPoliza(
      persona({ tomador: TOMADOR_J, asegurado: EMPLEADO_A }),
    );
    const ctxB = contextoPoliza(
      persona({ tomador: TOMADOR_J, asegurado: EMPLEADO_B }),
    );
    expect(archivoEsDeLaPoliza(CEDULA_A, ctxA)).toBe(true);
    expect(archivoEsDeLaPoliza(CEDULA_A, ctxB)).toBe(false);
    // El RIF del tomador sí es de la póliza de B (mismo tomador).
    expect(archivoEsDeLaPoliza(RIF_J, ctxB)).toBe(true);
    expect(archivoEsDeLaPoliza({ nombre: 'X' }, ctxB)).toBeNull();
  });

  it('el sobrescrito nunca se vuelve a analizar', () => {
    expect(
      motivoAnalisis(
        {
          estado: 'sobrescrito',
          ref: REF_PENDIENTE,
          decision: 'ia',
          diagnostico: OBSERVADO_V11.diagnostico,
          analisisRef: REF_PENDIENTE,
          huellaPoliza: 'x',
          proximoAnalisis: null,
        },
        'y',
        new Date(),
      ),
    ).toBeNull();
  });

  it('ruta comparable del archivo (URL, /ocr, codificación)', () => {
    expect(claveArchivo(REF_PENDIENTE)).toBe(
      'la mundial de seguros/500000011/pendiente/cedula.pdf',
    );
    expect(
      claveArchivo(
        'https://host/ocr/files/La%20Mundial%20de%20Seguros/500000011/pendiente/cedula.pdf',
      ),
    ).toBe('la mundial de seguros/500000011/pendiente/cedula.pdf');
  });
});

describe('v12: expedientes nuevos (documento de cada persona)', () => {
  const REF_TOM =
    'La Mundial de Seguros/17000001/5-7-26-11-7000009001/cedula.pdf';
  const REF_TIT =
    'La Mundial de Seguros/17000001/5-7-26-11-7000009001/cedula_titular.pdf';

  it('tomador empresa: RIF en el documento del tomador y la cédula del titular aparte → completo', async () => {
    ocr.set(REF_TOM, RIF_J);
    ocr.set(REF_TIT, CEDULA_A);
    const id = await registrar('7-7-7000009001', EMPLEADO_A, {
      cedula: { recibido: true, ref: REF_TOM },
      cedula_titular: { recibido: true, ref: REF_TIT },
    });
    expect(req(id, 'cedula')).toMatchObject({ estado: 'validado' });
    expect(req(id, 'cedula_titular')).toMatchObject({ estado: 'validado' });
    expect(req(id, 'cedula_titular').diagnostico.comparadoCon).toBe(
      'asegurado',
    );
    expect(exp(id).estadoDocumental).toBe('completo');
  });

  it('PDF con el RIF y la cédula del titular (documentosAdicionales): cubre los dos con una sola lectura', async () => {
    ocr.set(REF_TOM, { ...RIF_J, documentosAdicionales: [CEDULA_A] });
    const id = await registrar('7-7-7000009002', EMPLEADO_A, {
      cedula: { recibido: true, ref: REF_TOM },
    });
    expect(llamadasAnalizar()).toHaveLength(1);
    expect(req(id, 'cedula')).toMatchObject({ estado: 'validado' });
    expect(req(id, 'cedula_titular')).toMatchObject({
      estado: 'validado',
      decision: 'ia',
      ref: REF_TOM,
    });
    expect(req(id, 'cedula_titular').diagnostico.resumen).toMatch(
      /Tomado del mismo archivo que rif del tomador\.$/,
    );
    expect(exp(id).estadoDocumental).toBe('completo');
  });

  it('tomador empresa y solo la cédula del titular en su espacio → Revisar con texto simple; el titular queda cubierto', async () => {
    ocr.set(REF_TOM, CEDULA_A);
    const id = await registrar('7-7-7000009003', EMPLEADO_A, {
      cedula: { recibido: true, ref: REF_TOM },
    });
    expect(req(id, 'cedula').estado).toBe('observado');
    expect(req(id, 'cedula').motivo).toBe(
      'Revisar: Falta el RIF de la empresa tomadora. El archivo cargado es la cédula del titular (V-****0001).',
    );
    expect(req(id, 'cedula_titular').estado).toBe('validado');
  });

  it('nuevo sin la cédula del titular: se pide (faltante)', async () => {
    ocr.set(REF_TOM, RIF_J);
    const id = await registrar('7-7-7000009004', EMPLEADO_B, {
      cedula: { recibido: true, ref: REF_TOM },
    });
    expect(req(id, 'cedula').estado).toBe('validado');
    expect(req(id, 'cedula_titular').estado).toBe('faltante');
    expect(exp(id).estadoDocumental).toBe('incompleto');
  });

  it('titular = tomador: un solo requisito (la cédula del titular no aplica)', async () => {
    const REF = 'La Mundial de Seguros/17000001/1-1-26-11-1/cedula.pdf';
    ocr.set(REF, CEDULA_A);
    const id = await registrar(
      '7-7-7000009005',
      EMPLEADO_A,
      { cedula: { recibido: true, ref: REF } },
      EMPLEADO_A,
    );
    expect(req(id, 'cedula').estado).toBe('validado');
    expect(req(id, 'cedula_titular')).toMatchObject({
      estado: 'no_aplica',
      motivo: 'El titular es el mismo tomador: vale el documento del tomador.',
    });
    expect(exp(id).estadoDocumental).toBe('completo');
    const det = await svc.detalle(id);
    expect(det.requisitos.map((r: any) => [r.label, r.estado])).toEqual([
      ['Cédula del tomador', 'validado'],
      ['Cédula del titular', 'no_aplica'],
    ]);
  });
});

describe('v12: caso real tomador empresa (4 pólizas con el mismo archivo de pendiente/)', () => {
  async function prepararCaso() {
    const a1 = await expedienteAnterior(
      '7-7-7000001001',
      EMPLEADO_A,
      OBSERVADO_V11,
    );
    const a2 = await expedienteAnterior(
      '9-7-7000001002',
      EMPLEADO_A,
      OBSERVADO_V11,
    );
    const b = await expedienteAnterior(
      '7-7-7000001003',
      EMPLEADO_B,
      OBSERVADO_V11,
    );
    // C: recibido con el mismo archivo y sin lectura propia.
    const c = await expedienteAnterior('9-7-7000001004', EMPLEADO_C, {
      estado: 'recibido',
      decision: null,
      diagnostico: null,
      ocrDatos: null,
    });
    return { a1, a2, b, c };
  }

  it('sin llamadas al OCR ni correos: A queda «Falta el RIF» con el titular validado; B y C, documento sobrescrito', async () => {
    const { a1, a2, b, c } = await prepararCaso();
    const antesCorreos = llamadasCorreo().length;
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.sobrescritos).toBe(2);
    expect(llamadasAnalizar()).toHaveLength(0);
    expect(llamadasCorreo()).toHaveLength(antesCorreos);
    expect(db.mktExpedienteNotificacion._rows()).toHaveLength(0);

    for (const id of [a1, a2]) {
      // El archivo es la cédula de A: falta el RIF de la empresa (texto simple).
      expect(req(id, 'cedula')).toMatchObject({
        estado: 'observado',
        motivo:
          'Revisar: Falta el RIF de la empresa tomadora. El archivo cargado es la cédula del titular (V-****0001).',
      });
      expect(req(id, 'cedula').diagnostico.comparador).toBe(VERSION_COMPARADOR);
      // La cédula del titular (requisito nuevo) se cubre con el mismo archivo.
      expect(req(id, 'cedula_titular')).toMatchObject({
        estado: 'validado',
        decision: 'ia',
        ref: REF_PENDIENTE,
      });
      expect(exp(id).estadoDocumental).toBe('incompleto');
    }

    for (const id of [b, c]) {
      const fila = req(id, 'cedula');
      expect(fila.estado).toBe('sobrescrito');
      expect(fila.motivo.startsWith(MOTIVO_SOBRESCRITO)).toBe(true);
      expect(fila.motivo).toContain('V-****0001');
      // El requisito nuevo no se pide en expedientes anteriores (sin correos).
      expect(req(id, 'cedula_titular')).toMatchObject({
        estado: 'no_aplica',
        motivo: MOTIVO_NO_APLICA_PREVIO,
      });
      expect(exp(id).estadoDocumental).toBe('incompleto');
    }

    // Una segunda pasada no toca nada ni llama al OCR.
    const r2 = await svc.revisarConIa({ modo: 'completo' });
    expect(r2.motivos).toEqual({});
    expect(r2.sobrescritos).toBeUndefined();
    expect(llamadasAnalizar()).toHaveLength(0);
  });

  it('se puede filtrar y contar en el monitor; en el Excel dice «pedirlo de nuevo»', async () => {
    const { b, c } = await prepararCaso();
    await svc.revisarConIa({ modo: 'completo' });
    const lista = await svc.listar({ sobrescritos: true } as any);
    expect(lista.items.map((i: any) => i.id).sort()).toEqual([b, c].sort());
    expect(
      lista.items[0].requisitos.find((x: any) => x.tipo === 'cedula'),
    ).toMatchObject({ label: 'RIF del tomador', estado: 'sobrescrito' });
    const conErrores = await svc.listar({ conErrores: true } as any);
    expect(conErrores.total).toBe(4);
    const ind = await svc.indicadores({});
    expect(ind.sobrescritos).toBe(2);

    const config = await svc.getConfig();
    const reqsB = db.mktExpedienteRequisito
      ._rows()
      .filter((x: any) => x.expedienteId === b);
    expect(categoriaIncompleto(exp(b), reqsB, config)).toBe('conErrores');
    expect(observacionCorta(exp(b), reqsB, config)).toBe(
      'Cédula: documento sobrescrito, pedirlo de nuevo',
    );
  });

  it('el analista lo pide de nuevo (observar a mano) y el asegurado puede cargarlo en la página pública', async () => {
    const { b } = await prepararCaso();
    await svc.revisarConIa({ modo: 'completo' });
    const out = await svc.validarManual(
      b,
      'cedula',
      'observar',
      'analista@test',
      'Envíe de nuevo su cédula',
    );
    expect(out.estado).toBe('observado');
    expect(req(b, 'cedula')).toMatchObject({
      estado: 'observado',
      decision: 'manual',
    });
  });

  it('la página pública muestra el sobrescrito como por enviar y no muestra lo que no aplica', async () => {
    const { b } = await prepararCaso();
    await svc.revisarConIa({ modo: 'completo' });
    const { token } = await svc.crearEnlace('V17000002', [b]);
    const vista = await svc.vistaPublica(token);
    expect(vista.requisitos).toEqual([
      expect.objectContaining({
        tipo: 'cedula',
        label: 'RIF del tomador',
        estado: 'faltante',
        diagnostico: null,
      }),
    ]);
    expect(vista.pendientes).toEqual(['cedula']);
  });

  it('una decisión manual no se marca como sobrescrita', async () => {
    const { b } = await prepararCaso();
    Object.assign(req(b, 'cedula'), { decision: 'manual' });
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.sobrescritos).toBe(1);
    expect(req(b, 'cedula').estado).toBe('observado');
  });

  it('el mismo archivo para pólizas del mismo titular (sus 7-7 y 9-7) no es sobrescrito', async () => {
    await expedienteAnterior('7-7-7000001001', EMPLEADO_A, OBSERVADO_V11);
    await expedienteAnterior('9-7-7000001002', EMPLEADO_A, OBSERVADO_V11);
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.sobrescritos).toBeUndefined();
    expect(
      db.mktExpedienteRequisito
        ._rows()
        .filter((x: any) => x.estado === 'sobrescrito'),
    ).toHaveLength(0);
  });

  it('el RIF de la empresa compartido por todos sus empleados (misma huella) no es sobrescrito', async () => {
    const RIF = { ...OBSERVADO_V11, estado: 'validado', ocrDatos: RIF_J };
    await expedienteAnterior('7-7-7000001001', EMPLEADO_A, RIF);
    await expedienteAnterior('7-7-7000001003', EMPLEADO_B, {
      ...RIF,
      estado: 'observado',
    });
    const r = await svc.revisarConIa({ modo: 'completo' });
    expect(r.sobrescritos).toBeUndefined();
  });
});

describe('v12: relectura única del documento del tomador empresa', () => {
  const REF = 'La Mundial de Seguros/17000001/5-7-26-11-7000009010/cedula.pdf';

  it('lectura vieja sin RIF ni documentos adicionales (archivo propio): se vuelve a leer UNA vez', async () => {
    const id = await expedienteAnterior('7-7-7000009010', EMPLEADO_A, {
      ...OBSERVADO_V11,
      ref: REF,
      analisisRef: REF,
      archivoHash: 'propio',
    });
    ocr.set(REF, { ...RIF_J, documentosAdicionales: [CEDULA_A] });
    await svc.revisarConIa({ modo: 'completo' });
    expect(llamadasAnalizar()).toHaveLength(1);
    expect(req(id, 'cedula').estado).toBe('validado');
    expect(req(id, 'cedula_titular').estado).toBe('validado');
    await svc.revisarConIa({ modo: 'completo' });
    expect(llamadasAnalizar()).toHaveLength(1);
  });

  it('archivo compartido de pendiente/: no se gasta IA en releerlo', async () => {
    await expedienteAnterior('7-7-7000001001', EMPLEADO_A, OBSERVADO_V11);
    await expedienteAnterior('9-7-7000001002', EMPLEADO_A, OBSERVADO_V11);
    await svc.revisarConIa({ modo: 'completo' });
    expect(llamadasAnalizar()).toHaveLength(0);
  });
});
