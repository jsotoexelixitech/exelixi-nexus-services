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
  FilaIncompleto,
  ReporteSimple,
} from './expedientes.reporte';

export const MAX_BYTES_EXCEL = 5 * 1024 * 1024;
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Columna<T> = {
  header: string;
  width: number;
  valor: (f: T) => string | number | Date | null;
  fecha?: boolean;
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
    ...(c.fecha ? { style: { numFmt: 'dd/mm/yyyy' } } : {}),
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

export function filasResumen(c: CifrasControl): [string, string | number][] {
  return [
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
      ? ([['Sin datos de canal o productor', c.sinDatos]] as [string, number][])
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
  const res = wb.addWorksheet('Resumen', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  res.columns = [
    { header: 'Cifra', width: 34 },
    { header: 'Valor', width: 36 },
  ];
  res.getRow(1).font = { bold: true };
  for (const fila of filasResumen(r.cifras)) res.addRow(fila);
  res.addRow([]);
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
