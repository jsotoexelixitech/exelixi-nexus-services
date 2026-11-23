/**
 * Excel adjunto del «Control documental diario» (versión simple): hojas «Incompletos»
 * (quién no ha cargado sus documentos), «Completados» y «Resumen». Sin correo ni teléfono del
 * asegurado. Encabezados en negrita, filtros, primera fila fija y anchos legibles.
 * Tope de tamaño: si pasa de MAX_BYTES_EXCEL se quitan primero completados y luego las
 * incompletas más antiguas, y el correo avisa cuántas filas no van.
 */
import ExcelJS from 'exceljs';
import { caracasParts } from './expedientes.domain';
import type {
  CifrasControl,
  FilaCompletado,
  FilaEmisor,
  FilaIncompleto,
  ReporteSimple,
} from './expedientes.reporte';
import {
  lineaCuadre,
  textoCifraPct,
  textoNotaCuadre,
} from './expedientes.cuadre';
import {
  ETIQUETA_ORIGEN,
  type CifrasHistorico,
  type OrigenHistorico,
  type ResumenHistorico,
} from './expedientes.historico';

export const MAX_BYTES_EXCEL = 5 * 1024 * 1024;
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Columna<T> = {
  header: string;
  width: number;
  valor: (f: T) => string | number | Date | null;
  fecha?: boolean;
  /** Formato numérico de la columna (p. ej. '0.0%'). */
  numFmt?: string;
};

/** Día de Caracas como fecha sin hora (Excel no maneja zonas: se escribe a medianoche UTC). */
function diaCaracas(d: Date | null): Date | null {
  if (!d) return null;
  const [y, m, dd] = caracasParts(d).fecha.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd));
}

const COMUNES = [
  {
    header: 'Póliza',
    width: 18,
    valor: (f: FilaCompletado | FilaIncompleto) => f.poliza,
  },
  {
    header: 'Asegurado',
    width: 32,
    valor: (f: FilaCompletado | FilaIncompleto) => f.asegurado,
  },
  {
    header: 'Documento',
    width: 16,
    valor: (f: FilaCompletado | FilaIncompleto) => f.documento,
  },
  {
    header: 'Producto',
    width: 24,
    valor: (f: FilaCompletado | FilaIncompleto) => f.producto,
  },
  {
    header: 'Área',
    width: 13,
    valor: (f: FilaCompletado | FilaIncompleto) => f.area,
  },
  {
    header: 'Canal o productor',
    width: 32,
    valor: (f: FilaCompletado | FilaIncompleto) => f.canalOProductor,
  },
  {
    header: 'Emitida el',
    width: 13,
    fecha: true,
    valor: (f: FilaCompletado | FilaIncompleto) => diaCaracas(f.emitidaEn),
  },
];

export const COLUMNAS_INCOMPLETOS: Columna<FilaIncompleto>[] = [
  ...COMUNES,
  { header: 'Días', width: 8, valor: (f) => f.dias },
  { header: 'Qué falta / Observación', width: 48, valor: (f) => f.observacion },
  { header: 'Intentos de correo', width: 12, valor: (f) => f.intentos },
  { header: 'Último correo', width: 28, valor: (f) => f.ultimoCorreo },
  {
    header: 'No enviar correos',
    width: 12,
    valor: (f) => (f.noEnviar ? 'Sí' : 'No'),
  },
];

export const COLUMNAS_COMPLETADOS: Columna<FilaCompletado>[] = [
  ...COMUNES,
  {
    header: 'Completado el',
    width: 14,
    fecha: true,
    valor: (f) => diaCaracas(f.completadoEn),
  },
];

/** Hoja «Por emisor»: quién emitió («Emitida por»), nunca un login ni correo. */
export const COLUMNAS_EMISOR: Columna<FilaEmisor>[] = [
  { header: 'Emitida por', width: 40, valor: (f) => f.emisor },
  { header: 'Canal/Productor', width: 18, valor: (f) => f.contexto ?? '' },
  { header: 'Emitidas', width: 11, valor: (f) => f.total },
  { header: 'Completas', width: 11, valor: (f) => f.completos },
  { header: 'Incompletas', width: 12, valor: (f) => f.incompletos },
  {
    header: '% incompletas',
    width: 13,
    numFmt: '0.0%',
    valor: (f) => f.pctIncompletos,
  },
];

/** Fila de la hoja «Histórico»: mes × origen, el total de cada mes y el total general. */
export interface FilaHistoricoExcel extends CifrasHistorico {
  mes: string;
  origen: string;
}

export const COLUMNAS_HISTORICO: Columna<FilaHistoricoExcel>[] = [
  { header: 'Mes', width: 10, valor: (f) => f.mes },
  { header: 'Origen', width: 34, valor: (f) => f.origen },
  { header: 'Pólizas', width: 11, valor: (f) => f.total },
  { header: 'Pasó por el OCR', width: 14, valor: (f) => f.pasoOcr },
  { header: 'No pasó por el OCR', width: 14, valor: (f) => f.noPasoOcr },
  { header: 'Pendientes', width: 12, valor: (f) => f.pendientes },
  { header: 'Errores', width: 10, valor: (f) => f.errores },
  {
    header: '% pasó por el OCR',
    width: 14,
    numFmt: '0.0%',
    valor: (f) => f.pctPasoOcr,
  },
];

/** Por mes: cada origen y luego «Todos»; al final el total general. Solo cifras. */
export function filasHistoricoExcel(r: ResumenHistorico): FilaHistoricoExcel[] {
  const out: FilaHistoricoExcel[] = [];
  for (const m of r.porMes) {
    for (const f of r.filas.filter((x) => x.mes === m.mes))
      out.push({
        ...f,
        origen: ETIQUETA_ORIGEN[f.origen as OrigenHistorico] ?? f.origen,
      });
    out.push({ ...m, origen: 'Todos' });
  }
  out.push({ ...r.totales, mes: 'Total', origen: 'Todos' });
  return out;
}

/** «Histórico 2026» (año del primer mes cargado). */
export function nombreHojaHistorico(r: ResumenHistorico): string {
  const anio = r.porMes[0]?.mes.slice(0, 4);
  return anio ? `Histórico ${anio}` : 'Histórico';
}

function hoja<T>(
  wb: ExcelJS.Workbook,
  nombre: string,
  columnas: Columna<T>[],
  filas: T[],
) {
  const ws = wb.addWorksheet(nombre, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.columns = columnas.map((c) => ({
    header: c.header,
    width: c.width,
    ...(c.fecha
      ? { style: { numFmt: 'dd/mm/yyyy' } }
      : c.numFmt
        ? { style: { numFmt: c.numFmt } }
        : {}),
  }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
  for (const f of filas) ws.addRow(columnas.map((c) => c.valor(f)));
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columnas.length },
  };
  return ws;
}

/** Bloque del día anterior (pedido de La Mundial, 22/23-nov-2026), arriba del acumulado. */
export function filasDiaAnterior(c: CifrasControl): [string, number][] {
  const d = c.diaAnterior;
  if (!d) return [];
  return [
    [`Emitidas el ${d.fechaLocal} (día anterior)`, d.emitidas],
    ['· Completas', d.completas],
    ['· Incompletas', d.incompletas],
    ['· Sin información', d.sinInformacion],
  ];
}

export function filasResumen(c: CifrasControl): [string, string | number][] {
  return [
    ...filasDiaAnterior(c),
    ['Completados', c.completados],
    ['Incompletos', c.incompletos],
    [
      'De canales',
      `${c.canales.completos} completos / ${c.canales.incompletos} incompletos`,
    ],
    [
      'De productores',
      `${c.productores.completos} completos / ${c.productores.incompletos} incompletos`,
    ],
    ...(c.sinDatos
      ? ([
          [
            'Sin canal identificado',
            `${c.sinCanal.completos} completos / ${c.sinCanal.incompletos} incompletos`,
          ],
        ] as [string, string][])
      : []),
    ['Cuadre', lineaCuadre(c)],
    // Fuera del cuadre: también cuenta las sin información documental y las descartadas.
    ...(c.ocr
      ? ([
          ['Pasaron por el OCR', textoCifraPct(c.ocr.pasaron, c.ocr.pctPasaron)],
          [
            'No pasaron por el OCR',
            textoCifraPct(c.ocr.noPasaron, c.ocr.pctNoPasaron),
          ],
        ] as [string, string][])
      : []),
  ];
}

async function construir(
  r: ReporteSimple,
  incompletos: FilaIncompleto[],
  completados: FilaCompletado[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Marketplace La Mundial';
  wb.created = new Date(0);
  hoja(wb, 'Incompletos', COLUMNAS_INCOMPLETOS, incompletos);
  hoja(wb, 'Completados', COLUMNAS_COMPLETADOS, completados);
  if (r.porEmisor) hoja(wb, 'Por emisor', COLUMNAS_EMISOR, r.porEmisor);
  // Pocas filas (mes × origen): nunca se recorta por tamaño.
  if (r.historico)
    hoja(
      wb,
      nombreHojaHistorico(r.historico),
      COLUMNAS_HISTORICO,
      filasHistoricoExcel(r.historico),
    );
  const res = wb.addWorksheet('Resumen', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  res.columns = [
    { header: 'Cifra', width: 34 },
    { header: 'Valor', width: 36 },
  ];
  res.getRow(1).font = { bold: true };
  for (const fila of filasResumen(r.cifras)) res.addRow(fila);
  const nota = textoNotaCuadre(r.nota);
  if (nota) res.addRow(['Nota', nota]);
  res.addRow([]);
  // Solo el número de póliza: el equipo las corrige y el relleno de canal las completa.
  const pend = r.pendientesCanal ?? [];
  if (pend.length) {
    const ws = wb.addWorksheet(`Pendientes canal (${pend.length})`.slice(0, 31), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [{ header: 'Póliza (pendiente de identificar canal)', width: 40 }];
    ws.getRow(1).font = { bold: true };
    for (const p of pend) ws.addRow([p]);
  }
  res.addRow(['Control documental diario', r.fechaLocal]);
  res.addRow(['Corte (hora de Caracas)', r.corte]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface ExcelReporte {
  filename: string;
  buffer: Buffer;
  omitidas: { incompletos: number; completados: number };
}

export function nombreExcel(fecha: string): string {
  return `control-documental-${fecha}.xlsx`;
}

/** Arma el Excel; si pasa del tope quita completados y luego las incompletas más antiguas. */
export async function excelReporteSimple(
  r: ReporteSimple,
  maxBytes: number = MAX_BYTES_EXCEL,
): Promise<ExcelReporte> {
  let inc = r.incompletos;
  let comp = r.completados;
  let buffer = await construir(r, inc, comp);
  if (buffer.length > maxBytes && comp.length) {
    // Si ni sin completados cabe, se van todos y se recortan las incompletas más antiguas.
    const sinCompletados = await construir(r, inc, []);
    if (sinCompletados.length > maxBytes) {
      comp = [];
      buffer = sinCompletados;
    }
  }
  for (let i = 0; i < 20 && buffer.length > maxBytes; i++) {
    const factor = Math.min(0.9, (maxBytes / buffer.length) * 0.9);
    if (comp.length) comp = comp.slice(0, Math.floor(comp.length * factor));
    else if (inc.length) inc = inc.slice(0, Math.floor(inc.length * factor));
    else break;
    buffer = await construir(r, inc, comp);
  }
  return {
    filename: nombreExcel(r.fecha),
    buffer,
    omitidas: {
      incompletos: r.incompletos.length - inc.length,
      completados: r.completados.length - comp.length,
    },
  };
}
