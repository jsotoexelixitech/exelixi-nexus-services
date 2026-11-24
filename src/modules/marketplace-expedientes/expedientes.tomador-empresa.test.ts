/**
 * v11 (23-nov): falsa alarma de prod en la póliza 7-7-7000003208 (Salud). Tomador SUPERMERCADO RIO
 * VIDA CA (J-50058503-9), titular RAMON PEREZ GARCIA (V-17671805). En el espacio del tomador se
 * subió un PDF con el RIF (página 1) y la cédula del titular (página 2); el OCR leyó la cédula
 * («JHON») y el monitor marcó «Errado» comparando con el asegurado. En personas, con tomador J/G/C
 * el documento del tomador (`cedula`) se compara solo con el tomador: RIF y razón social. Con
 * tomador persona natural no cambia nada (v4).
 */
import { describe, expect, it } from 'vitest';

import {
  contextoPoliza,
  diagnosticar,
  estadoPorDiagnostico,
  leyoRifDelTomador,
  motivoAnalisis,
  separarLecturas,
  tokensRazonSocial,
  VERSION_COMPARADOR,
} from './expedientes.ia';

/** Póliza 7-7-7000003208: tomador empresa y titular persona natural. */
const SNAP_EMPRESA = {
  tomador: {
    nombre: 'SUPERMERCADO RIO VIDA CA',
    identificacion: 'J-50058503-9',
  },
  asegurado: {
    tipoDoc: 'V',
    documento: '17671805',
    nombre: 'RAMON',
    apellido: 'PEREZ GARCIA',
  },
  planNombre: 'SALUD INDIVIDUAL',
};

const ctxEmpresa = () =>
  contextoPoliza({
    producto: 'personas',
    snapshot: SNAP_EMPRESA,
    aseguradoTipoDoc: 'V',
    aseguradoDocumento: '17671805',
    aseguradoNombre: 'RAMON',
    aseguradoApellido: 'PEREZ GARCIA',
  });

const lectura = (extraido: Record<string, unknown>) => ({
  extraido,
  confianza: 1,
  proveedor: 'gemini',
});

const RIF_EMPRESA = {
  documentoTipo: 'rif',
  tipoDoc: 'J',
  rif: 'J500585039',
  identificacion: '500585039',
  nombre: 'SUPERMERCADO RIO VIDA C.A',
  razonSocial: 'SUPERMERCADO RIO VIDA C.A',
};

const CEDULA_TITULAR = {
  documentoTipo: 'cedula',
  tipoDoc: 'V',
  identificacion: '17671805',
  nombre: 'JHON',
  apellido: 'PEREZ GARCIA',
};

describe('v11: tomador persona jurídica — el documento del tomador es su RIF', () => {
  it('la versión del comparador es 12 (v12: documentos por persona; se recomparan los observados)', () => {
    expect(VERSION_COMPARADOR).toBe(12);
  });

  it('RIF que coincide (sin guiones ni dígito verificador; «C.A» frente a «CA») → validado', () => {
    const d = diagnosticar('cedula', lectura(RIF_EMPRESA), ctxEmpresa());
    expect(d.resultado).toBe('coincide');
    expect(d.comparadoCon).toBe('tomador');
    expect(d.campos.find((c) => c.campo === 'documento')).toMatchObject({
      etiqueta: 'Número de RIF',
      estado: 'coincide',
    });
    expect(d.campos.find((c) => c.campo === 'nombre')).toMatchObject({
      etiqueta: 'Razón social',
      estado: 'coincide',
    });
    expect(estadoPorDiagnostico(d).estado).toBe('validado');
  });

  it('RIF de 8 dígitos sin el verificador también coincide con J-50058503-9', () => {
    const d = diagnosticar(
      'cedula',
      lectura({
        ...RIF_EMPRESA,
        rif: 'J-50058503',
        identificacion: '50058503',
      }),
      ctxEmpresa(),
    );
    expect(d.resultado).toBe('coincide');
  });

  it('RIF de otra empresa → errado (no coincide)', () => {
    const d = diagnosticar(
      'cedula',
      lectura({
        ...RIF_EMPRESA,
        rif: 'J-40000001-2',
        identificacion: '400000012',
        nombre: 'INVERSIONES OTRA COSA CA',
        razonSocial: 'INVERSIONES OTRA COSA CA',
      }),
      ctxEmpresa(),
    );
    expect(d.resultado).toBe('no_coincide');
    expect(d.resumen).toMatch(/^El RIF del documento \(J-\*\*\*\*0012\)/);
    expect(estadoPorDiagnostico(d).estado).toBe('observado');
  });

  it('caso de prod: el OCR solo leyó la cédula del titular → Revisar (falta el RIF), nunca Errado ni contra el asegurado', () => {
    const d = diagnosticar('cedula', lectura(CEDULA_TITULAR), ctxEmpresa());
    expect(d.resultado).toBe('sin_certeza');
    expect(d.comparadoCon).toBe('tomador');
    // El documento del tomador se compara con el tomador: no se leyó su RIF.
    expect(d.campos.find((c) => c.campo === 'documento')).toMatchObject({
      etiqueta: 'Número de RIF',
      enPoliza: 'J-****5039',
      estado: 'sin_dato_documento',
    });
    expect(d.campos.some((c) => c.estado === 'no_coincide')).toBe(false);
    // La cédula leída es solo complementaria.
    expect(
      d.campos.find((c) => c.campo === 'adicionalDocumento'),
    ).toMatchObject({
      estado: 'coincide',
      enDocumento: 'V-****1805',
    });
    expect(d.campos.find((c) => c.campo === 'adicionalNombre')).toMatchObject({
      estado: 'difiere',
      enPoliza: 'RAMON PEREZ GARCIA',
      enDocumento: 'JHON PEREZ GARCIA',
    });
    // v12: texto simple (qué falta y de quién es el archivo cargado).
    expect(d.resumen).toBe(
      'Falta el RIF de la empresa tomadora. El archivo cargado es la cédula del titular (V-****1805). Difiere (informativo, no cuenta): nombre en la cédula adicional (titular).',
    );
    const e = estadoPorDiagnostico(d);
    expect(e.estado).toBe('observado');
    expect(e.motivo).toMatch(/^Revisar: /);
  });

  it('PDF de 2 páginas: RIF + cédula del titular (documentosAdicionales) → validado; la cédula es complementaria', () => {
    const d = diagnosticar(
      'cedula',
      lectura({ ...RIF_EMPRESA, documentosAdicionales: [CEDULA_TITULAR] }),
      ctxEmpresa(),
    );
    expect(d.resultado).toBe('coincide');
    expect(
      d.campos.find((c) => c.campo === 'adicionalDocumento'),
    ).toMatchObject({
      estado: 'coincide',
      etiqueta: 'Cédula adicional en el archivo (titular)',
    });
    expect(d.campos.find((c) => c.campo === 'adicionalNombre')).toMatchObject({
      estado: 'difiere',
      enDocumento: 'JHON PEREZ GARCIA',
    });
    expect(d.resumen).toContain('Difiere (informativo, no cuenta)');
    expect(estadoPorDiagnostico(d).estado).toBe('validado');
  });

  it('PDF de 2 páginas leído en una sola lectura (rif J + identificacion de la cédula) → validado', () => {
    const d = diagnosticar(
      'cedula',
      lectura({
        tipoDoc: 'V',
        rif: 'J-50058503-9',
        razonSocial: 'SUPERMERCADO RIO VIDA, C.A.',
        identificacion: '17671805',
        nombre: 'JHON',
        apellido: 'PEREZ GARCIA',
      }),
      ctxEmpresa(),
    );
    expect(d.resultado).toBe('coincide');
    expect(d.comparadoCon).toBe('tomador');
    expect(d.campos.find((c) => c.campo === 'adicionalDocumento')?.estado).toBe(
      'coincide',
    );
  });

  it('cédula complementaria que no es de nadie de la póliza: informativa, no hace fallar el RIF', () => {
    const d = diagnosticar(
      'cedula',
      lectura({
        ...RIF_EMPRESA,
        documentosAdicionales: [
          { tipoDoc: 'V', identificacion: '9999999', nombre: 'PEDRO' },
        ],
      }),
      ctxEmpresa(),
    );
    expect(d.resultado).toBe('coincide');
    expect(
      d.campos.find((c) => c.campo === 'adicionalDocumento'),
    ).toMatchObject({ estado: 'difiere', coincide: false });
  });

  it('separarLecturas y leyoRifDelTomador', () => {
    expect(leyoRifDelTomador(CEDULA_TITULAR)).toBe(false);
    expect(leyoRifDelTomador(RIF_EMPRESA)).toBe(true);
    expect(
      leyoRifDelTomador({
        ...CEDULA_TITULAR,
        documentosAdicionales: [RIF_EMPRESA],
      }),
    ).toBe(true);
    const s = separarLecturas({
      ...CEDULA_TITULAR,
      otrosDocumentos: [RIF_EMPRESA],
    });
    expect(s.principal).toMatchObject({ rif: 'J500585039' });
    expect(s.complementaria).toMatchObject({ identificacion: '17671805' });
    expect(separarLecturas(CEDULA_TITULAR).complementaria).toBeNull();
  });

  it('razón social sin forma societaria', () => {
    expect(tokensRazonSocial('Supermercado Río Vida, C.A.')).toEqual([
      'SUPERMERCADO',
      'RIO',
      'VIDA',
    ]);
    expect(tokensRazonSocial('SUPERMERCADO RIO VIDA CA')).toEqual([
      'SUPERMERCADO',
      'RIO',
      'VIDA',
    ]);
  });

  it('el observado con el comparador 10 se vuelve a evaluar; lo validado a mano no', () => {
    const base = {
      ref: 'exp/7-7-7000003208/cedula.pdf',
      analisisRef: 'exp/7-7-7000003208/cedula.pdf',
      huellaPoliza: 'h',
      proximoAnalisis: null,
    };
    const diag = { resultado: 'no_coincide', resumen: 'x', comparador: 10 };
    expect(
      motivoAnalisis(
        { ...base, estado: 'observado', decision: 'ia', diagnostico: diag },
        'h',
        new Date(),
      ),
    ).toBe('cambio_comparador');
    expect(
      motivoAnalisis(
        { ...base, estado: 'validado', decision: 'manual', diagnostico: diag },
        'h',
        new Date(),
      ),
    ).toBeNull();
  });
});

describe('v12: tomador persona natural con un titular distinto — el documento del tomador es el suyo', () => {
  const ctxNatural = () =>
    contextoPoliza({
      producto: 'personas',
      snapshot: {
        tomador: {
          tipoDoc: 'V',
          documento: '11225322',
          nombre: 'CARLOS',
          apellido: 'RUIZ',
        },
        asegurado: SNAP_EMPRESA.asegurado,
      },
    });

  it('cédula del tomador → validado', () => {
    const d = diagnosticar(
      'cedula',
      lectura({
        tipoDoc: 'V',
        identificacion: '11225322',
        nombre: 'CARLOS',
        apellido: 'RUIZ',
      }),
      ctxNatural(),
    );
    expect(d.resultado).toBe('coincide');
  });

  it('cédula del tomador con otro nombre → no coincide', () => {
    const d = diagnosticar(
      'cedula',
      lectura({
        tipoDoc: 'V',
        identificacion: '11225322',
        nombre: 'PEDRO',
        apellido: 'GOMEZ',
      }),
      ctxNatural(),
    );
    expect(d.resultado).toBe('no_coincide');
    expect(d.comparadoCon).toBe('tomador');
  });

  it('cédula del titular en el espacio del tomador → Revisar: falta la cédula del tomador (nunca Errado)', () => {
    const d = diagnosticar(
      'cedula',
      lectura({ ...CEDULA_TITULAR, nombre: 'RAMON' }),
      ctxNatural(),
    );
    expect(d.resultado).toBe('sin_certeza');
    expect(d.resumen).toBe(
      'Falta la cédula del tomador. El archivo cargado es la cédula del titular (V-****1805).',
    );
    // La misma cédula, en el requisito del titular, coincide.
    expect(
      diagnosticar(
        'cedula_titular',
        lectura({ ...CEDULA_TITULAR, nombre: 'RAMON' }),
        ctxNatural(),
      ),
    ).toMatchObject({ resultado: 'coincide', comparadoCon: 'asegurado' });
  });

  it('cédula del tomador en el espacio del titular → Revisar: falta la cédula del titular', () => {
    const d = diagnosticar(
      'cedula_titular',
      lectura({
        tipoDoc: 'V',
        identificacion: '11225322',
        nombre: 'CARLOS',
        apellido: 'RUIZ',
      }),
      ctxNatural(),
    );
    expect(d.resultado).toBe('sin_certeza');
    expect(d.resumen).toBe(
      'Falta la cédula del titular. El archivo cargado es la cédula del tomador (V-****5322).',
    );
  });

  it('número del titular con otro nombre → sigue siendo no coincide (v4)', () => {
    const d = diagnosticar('cedula', lectura(CEDULA_TITULAR), ctxNatural());
    expect(d.resultado).toBe('no_coincide');
  });

  it('cédula de alguien que no es de la póliza → no coincide', () => {
    const d = diagnosticar(
      'cedula',
      lectura({
        tipoDoc: 'V',
        identificacion: '9999999',
        nombre: 'PEDRO',
        apellido: 'GOMEZ',
      }),
      ctxNatural(),
    );
    expect(d.resultado).toBe('no_coincide');
  });

  it('sin titular aparte en la póliza (un solo documento): vale la de cualquier persona natural (v4)', () => {
    const ctx = contextoPoliza({
      producto: 'personas',
      snapshot: { tomador: SNAP_EMPRESA.asegurado },
      aseguradoTipoDoc: 'V',
      aseguradoDocumento: '17671805',
    });
    const d = diagnosticar(
      'cedula',
      lectura({ ...CEDULA_TITULAR, nombre: 'RAMON' }),
      ctx,
    );
    expect(d.resultado).toBe('coincide');
  });

  it('la póliza no trae al tomador: se compara con las personas que sí trae (como antes)', () => {
    const ctx = contextoPoliza({
      producto: 'personas',
      snapshot: { asegurado: SNAP_EMPRESA.asegurado },
    });
    const d = diagnosticar(
      'cedula',
      lectura({ ...CEDULA_TITULAR, nombre: 'RAMON' }),
      ctx,
    );
    expect(d.resultado).toBe('coincide');
  });
});
