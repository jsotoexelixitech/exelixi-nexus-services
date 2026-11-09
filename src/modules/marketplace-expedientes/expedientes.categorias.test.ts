import { describe, expect, it } from 'vitest';
import {
  CATEGORIAS_INCOMPLETO,
  categoriaIncompleto,
  desgloseIncompletos,
  RequisitoCategoria,
} from './expedientes.categorias';
import {
  calcularEstadoDocumental,
  DEFAULT_CONFIG,
  ExpedientesConfig,
  requisitosAplicables,
} from './expedientes.domain';

const AUTO: ExpedientesConfig = { ...DEFAULT_CONFIG, validacion: 'automatica' };
const MANUAL: ExpedientesConfig = { ...DEFAULT_CONFIG, validacion: 'manual' };
const RCV = { producto: 'rcv', estadoDocumental: 'incompleto' };

const faltante = (tipo: string): RequisitoCategoria => ({
  tipo,
  estado: 'faltante',
});
const validado = (tipo: string): RequisitoCategoria => ({
  tipo,
  estado: 'validado',
  ref: `ref-${tipo}`,
});
/** Recibido con archivo; `diag` = resultado del diagnóstico vigente de la IA. */
const recibido = (
  tipo: string,
  diag?: string,
  over: Partial<RequisitoCategoria> = {},
): RequisitoCategoria => ({
  tipo,
  estado: 'recibido',
  ref: `ref-${tipo}`,
  ...(diag ? conDiag(tipo, diag) : {}),
  ...over,
});
const observado = (tipo: string, diag?: string): RequisitoCategoria => ({
  tipo,
  estado: 'observado',
  ref: `ref-${tipo}`,
  ...(diag ? conDiag(tipo, diag) : {}),
});
function conDiag(tipo: string, resultado: string) {
  return {
    analisisRef: `ref-${tipo}`,
    diagnostico: {
      version: 1,
      tipo,
      analizadoEn: '2026-01-10T12:00:00.000Z',
      resultado,
      resumen: 'x',
      campos: [],
    },
  };
}

describe('categoriaIncompleto: una sola categoría por prioridad', () => {
  it('solo los incompletos tienen categoría', () => {
    const reqs = [
      validado('cedula'),
      validado('licencia'),
      validado('certificado'),
    ];
    expect(
      categoriaIncompleto({ ...RCV, estadoDocumental: 'completo' }, reqs, AUTO),
    ).toBeNull();
    expect(
      categoriaIncompleto(
        { ...RCV, estadoDocumental: 'sin_informacion' },
        [],
        AUTO,
      ),
    ).toBeNull();
  });

  it('faltanDocumentos: solo le faltan documentos por enviar', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [validado('cedula'), faltante('licencia'), faltante('certificado')],
        AUTO,
      ),
    ).toBe('faltanDocumentos');
    // El requisito aplicable sin fila cuenta como faltante (como calcularEstadoDocumental).
    expect(categoriaIncompleto(RCV, [validado('cedula')], AUTO)).toBe(
      'faltanDocumentos',
    );
  });

  it('conErrores gana a todo lo demás (caso mixto)', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [
          observado('cedula', 'no_coincide'),
          observado('licencia', 'datos_modificados'),
          recibido('certificado', 'error_tecnico'),
        ],
        AUTO,
      ),
    ).toBe('conErrores');
    // Observado a mano, sin diagnóstico de la IA: también es error.
    expect(
      categoriaIncompleto(
        RCV,
        [observado('cedula'), faltante('licencia')],
        AUTO,
      ),
    ).toBe('conErrores');
  });

  it('datosCambiados: observado solo por datos cambiados en el formulario', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [
          observado('cedula', 'datos_modificados'),
          recibido('licencia', 'error_tecnico'),
          faltante('certificado'),
        ],
        AUTO,
      ),
    ).toBe('datosCambiados');
  });

  it('noLeidos: error técnico vigente gana a analizando y a faltantes', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [
          recibido('cedula', 'error_tecnico'),
          recibido('licencia'),
          faltante('certificado'),
        ],
        AUTO,
      ),
    ).toBe('noLeidos');
    // Error técnico de OTRO archivo: ya no es vigente, la IA lo vuelve a analizar.
    expect(
      categoriaIncompleto(
        RCV,
        [recibido('cedula', 'error_tecnico', { analisisRef: 'viejo' })],
        AUTO,
      ),
    ).toBe('analizando');
  });

  it('analizando: recibido con archivo que la IA revisa', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [recibido('cedula'), faltante('licencia'), validado('certificado')],
        AUTO,
      ),
    ).toBe('analizando');
  });

  it('porValidar en automática: recibido sin archivo o con decisión manual', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [recibido('cedula', undefined, { ref: null })],
        AUTO,
      ),
    ).toBe('porValidar');
    expect(
      categoriaIncompleto(
        RCV,
        [
          recibido('cedula', 'error_tecnico', { decision: 'manual' }),
          recibido('licencia'),
        ],
        AUTO,
      ),
    ).toBe('porValidar');
  });

  it('validación manual: todo lo recibido es porValidar (sin noLeidos ni analizando)', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [recibido('cedula', 'error_tecnico'), recibido('licencia')],
        MANUAL,
      ),
    ).toBe('porValidar');
    expect(
      categoriaIncompleto(
        RCV,
        [observado('cedula', 'no_coincide'), recibido('licencia')],
        MANUAL,
      ),
    ).toBe('conErrores');
  });

  it('solo cuentan los requisitos aplicables al producto', () => {
    expect(
      categoriaIncompleto(
        { producto: 'personas', estadoDocumental: 'incompleto' },
        [faltante('cedula'), observado('licencia', 'no_coincide')],
        AUTO,
      ),
    ).toBe('faltanDocumentos');
  });

  it('otros: estado guardado desactualizado (todo validado pero incompleto)', () => {
    expect(
      categoriaIncompleto(
        RCV,
        [validado('cedula'), validado('licencia'), validado('certificado')],
        AUTO,
      ),
    ).toBe('otros');
  });
});

describe('desgloseIncompletos: la suma es siempre el número de incompletos', () => {
  /** Todos los estados posibles de un requisito, incluidos los raros. */
  const variantes = (tipo: string): (RequisitoCategoria | null)[] => [
    null, // sin fila
    faltante(tipo),
    { tipo, estado: 'sin_informacion' },
    validado(tipo),
    recibido(tipo),
    recibido(tipo, 'error_tecnico'),
    recibido(tipo, 'error_tecnico', { analisisRef: 'viejo' }),
    recibido(tipo, 'error_tecnico', { decision: 'manual' }),
    recibido(tipo, undefined, { ref: null }),
    recibido(tipo, 'coincide'),
    observado(tipo),
    observado(tipo, 'no_coincide'),
    observado(tipo, 'ilegible'),
    observado(tipo, 'sin_certeza'),
    observado(tipo, 'datos_modificados'),
  ];

  /** Todas las combinaciones de los 3 requisitos de RCV (15³) más personas (15). */
  function todas() {
    const out: { id: number; producto: string; reqs: RequisitoCategoria[] }[] =
      [];
    const quitarNulos = (xs: (RequisitoCategoria | null)[]) =>
      xs.filter((x): x is RequisitoCategoria => !!x);
    for (const a of variantes('cedula'))
      for (const b of variantes('licencia'))
        for (const c of variantes('certificado'))
          out.push({
            id: out.length + 1,
            producto: 'rcv',
            reqs: quitarNulos([a, b, c]),
          });
    for (const a of variantes('cedula'))
      out.push({
        id: out.length + 1,
        producto: 'personas',
        reqs: quitarNulos([a]),
      });
    return out;
  }

  for (const config of [AUTO, MANUAL]) {
    it(`validación ${config.validacion}: cada incompleto en una sola categoría, nunca «otros»`, () => {
      const exps = todas().map((x) => ({
        ...x,
        estadoDocumental: calcularEstadoDocumental(
          requisitosAplicables(x.producto, config),
          x.reqs,
        ),
      }));
      const incompletos = exps.filter(
        (e) => e.estadoDocumental === 'incompleto',
      );
      const completos = exps.filter((e) => e.estadoDocumental === 'completo');
      const sinInfo = exps.filter(
        (e) => e.estadoDocumental === 'sin_informacion',
      );
      expect(completos.length + incompletos.length + sinInfo.length).toBe(
        exps.length,
      );

      const d = desgloseIncompletos(exps, (e) => e.reqs, config);
      expect(Object.keys(d)).toEqual([...CATEGORIAS_INCOMPLETO]);
      const suma = Object.values(d).reduce((a, n) => a + n, 0);
      expect(suma).toBe(incompletos.length);
      // Con el estado recién calculado no queda ningún caso sin explicar.
      expect(d.otros).toBe(0);
      if (config.validacion === 'manual') {
        expect(d.noLeidos).toBe(0);
        expect(d.analizando).toBe(0);
      } else {
        expect(d.noLeidos).toBeGreaterThan(0);
        expect(d.analizando).toBeGreaterThan(0);
      }
      expect(d.conErrores).toBeGreaterThan(0);
      expect(d.datosCambiados).toBeGreaterThan(0);
      expect(d.porValidar).toBeGreaterThan(0);
      expect(d.faltanDocumentos).toBeGreaterThan(0);
    });
  }

  it('con estados guardados desactualizados la suma sigue cuadrando (van a «otros»)', () => {
    const exps = todas().map((x) => ({ ...x, estadoDocumental: 'incompleto' }));
    const d = desgloseIncompletos(exps, (e) => e.reqs, AUTO);
    expect(Object.values(d).reduce((a, n) => a + n, 0)).toBe(exps.length);
    expect(d.otros).toBeGreaterThan(0);
  });
});
