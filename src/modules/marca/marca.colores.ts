/**
 * Colores de la marca de una empresa: validación y contraste.
 * Nexus guarda solo los 3 colores y el logo; cada aplicación arma su paleta (tonos claros,
 * oscuros, degradados) a partir de ellos, porque cada una tiene sus propios estilos.
 */

/** Contraste mínimo contra blanco: los botones llevan texto blanco y los títulos van sobre fondo blanco. */
export const CONTRASTE_MINIMO = 3;

export type ColoresMarca = {
  colorPrincipal: string | null;
  colorSecundario: string | null;
  colorTerciario: string | null;
};

const NOMBRES: Record<keyof ColoresMarca, string> = {
  colorPrincipal: 'principal',
  colorSecundario: 'secundario',
  colorTerciario: 'de acento',
};

/** '#abc', 'abc', '#AABBCC' → '#AABBCC'; null si no es un color válido. */
export function normalizarHex(valor: unknown): string | null {
  const crudo = String(valor ?? '')
    .trim()
    .replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(crudo)) {
    return `#${crudo
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()}`;
  }
  return /^[0-9a-f]{6}$/i.test(crudo) ? `#${crudo.toUpperCase()}` : null;
}

function luminancia(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * lin((n >> 16) & 255) +
    0.7152 * lin((n >> 8) & 255) +
    0.0722 * lin(n & 255)
  );
}

/** Relación de contraste WCAG entre dos colores #RRGGBB (1 a 21). */
export function contraste(a: string, b: string): number {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * Normaliza los colores recibidos. Vacío = sin color propio (la aplicación usa el suyo).
 * Lanza el motivo si alguno no es válido o es tan claro que el texto blanco no se leería.
 */
export function coloresValidos(entrada: Record<string, unknown>): ColoresMarca {
  const salida = {} as ColoresMarca;
  for (const clave of Object.keys(NOMBRES) as (keyof ColoresMarca)[]) {
    const crudo = entrada?.[clave];
    if (crudo === null || crudo === undefined || String(crudo).trim() === '') {
      salida[clave] = null;
      continue;
    }
    const hex = normalizarHex(crudo);
    if (!hex) {
      throw new Error(
        `El color ${NOMBRES[clave]} no es válido. Usa el formato #RRGGBB.`,
      );
    }
    if (contraste(hex, '#FFFFFF') < CONTRASTE_MINIMO) {
      throw new Error(
        `El color ${NOMBRES[clave]} (${hex}) es muy claro: el texto blanco de los botones no se leería. Elige un tono más oscuro.`,
      );
    }
    salida[clave] = hex;
  }
  return salida;
}
