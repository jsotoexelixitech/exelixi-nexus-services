/**
 * Cuadre del «Control documental diario» (12-nov-2026): una línea visible «Total = Canales +
 * Productores + Sin canal identificado» y la nota de por qué el Monitor puede mostrar otro total.
 * Sin dependencias: lo usan el reporte, el correo y el Excel.
 */
interface PorArea {
  completos: number;
  incompletos: number;
}
interface Cifras {
  total: number;
  canales: PorArea;
  productores: PorArea;
  sinDatos: number;
}
interface Nota {
  sinInformacion: number;
  fueraDeAlcance: number;
}

const sumaArea = (x: PorArea) =>
  x.completos + x.incompletos;

/** «Total 465 = Canales 442 + Productores 0 + Sin canal identificado 23». */
export function lineaCuadre(c: Cifras): string {
  const partes = [
    `Canales ${sumaArea(c.canales)}`,
    `Productores ${sumaArea(c.productores)}`,
    ...(c.sinDatos ? [`Sin canal identificado ${c.sinDatos}`] : []),
  ];
  return `Total ${c.total} = ${partes.join(' + ')}`;
}

/** Nota corta de por qué el Monitor puede mostrar otro total. */
export function textoNotaCuadre(n?: Nota | null): string {
  if (!n || (!n.sinInformacion && !n.fueraDeAlcance)) return '';
  const partes = [
    n.sinInformacion
      ? `${n.sinInformacion} sin información documental (no son completas ni incompletas)`
      : '',
    n.fueraDeAlcance ? `${n.fueraDeAlcance} fuera del alcance configurado` : '',
  ].filter(Boolean);
  return `El Monitor puede mostrar otro total: este reporte es la foto al corte y no incluye ${partes.join(' ni ')}; lo emitido después del corte entra en el reporte siguiente.`;
}
