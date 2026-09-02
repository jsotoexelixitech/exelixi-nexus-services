export type FlowProduct = 'rcv' | 'funerario';

const LM_PRODUCTS = new Set<string>(['rcv', 'funerario']);

/**
 * Infiere el producto del flujo desde URL del submódulo o nombres (módulo/submódulo).
 * Funerario solo si `?product=funerario` o el nombre contiene "funerar".
 * Nunca infiere funerario desde una URL RCV (mismo path `/ocr/` sin query).
 */
/** Prioridad: metadata SSO `product` → URL/nombre del submódulo. */
export function resolveSsoFlowProduct(
  metadata?: { product?: unknown } | null,
  hints?: {
    submoduloUrl?: string | null;
    submoduloNombre?: string | null;
    moduloNombre?: string | null;
  },
): FlowProduct {
  const raw =
    metadata && typeof metadata === 'object'
      ? String(metadata.product ?? '').trim()
      : '';
  if (raw === 'funerario' || raw === 'rcv') return raw;
  return resolveFlowProduct(hints ?? {});
}

export function resolveFlowProduct(hints: {
  submoduloUrl?: string | null;
  submoduloNombre?: string | null;
  moduloNombre?: string | null;
}): FlowProduct {
  if (hints.submoduloUrl) {
    try {
      const fromUrl = new URL(
        hints.submoduloUrl,
        'https://cierrelmds.exelixitech.com',
      ).searchParams.get('product');
      if (fromUrl === 'funerario' || fromUrl === 'rcv') return fromUrl;
    } catch {
      /* ignore */
    }
  }
  const label =
    `${hints.submoduloNombre ?? ''} ${hints.moduloNombre ?? ''}`.toLowerCase();
  if (label.includes('funerar')) return 'funerario';
  return 'rcv';
}

/**
 * Clave de cadena OCR: origen + path + producto.
 * `/ocr/?product=funerario` y `/ocr/?product=rcv` no son la misma entrada.
 */
export function flowChainKey(
  url: string | null | undefined,
  nombre?: string | null,
): string {
  if (!url) return '';
  const product = resolveFlowProduct({
    submoduloUrl: url,
    submoduloNombre: nombre,
  });
  try {
    const u = new URL(url, 'https://cierrelmds.exelixitech.com');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin.toLowerCase()}${path.toLowerCase()}#${product}`;
  } catch {
    return `${url.trim().toLowerCase().replace(/\/+$/, '')}#${product}`;
  }
}

function isLaMundialProduct(
  product?: FlowProduct | string | null,
): product is FlowProduct {
  return product === 'rcv' || product === 'funerario';
}

/**
 * Funerario: fuerza `?product=funerario` (pisa un `rcv` erróneo).
 * RCV: no añade query; si la URL trae `funerario`, lo quita.
 */
export function appendProductToUrl(url: string, product: FlowProduct): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    const current = u.searchParams.get('product');
    if (product === 'funerario') {
      if (current === 'funerario') return url;
      u.searchParams.set('product', 'funerario');
      return u.toString();
    }
    if (current === 'funerario') {
      u.searchParams.delete('product');
      return u.toString();
    }
    return url;
  } catch {
    if (product === 'funerario') {
      if (url.includes('product=funerario')) return url;
      const stripped = url
        .replace(/([?&])product=[^&]*/g, '$1')
        .replace(/[?&]$/, '');
      const sep = stripped.includes('?') ? '&' : '?';
      return `${stripped}${sep}product=funerario`;
    }
    return url.replace(/([?&])product=funerario(&)?/g, (_, q, amp) =>
      amp ? String(q) : '',
    );
  }
}

/**
 * Propaga `?flow=exelixi-catalog` solo en el flujo catálogo.
 * Nunca en RCV ni funerario La Mundial (aunque el flag venga sucio en sesión).
 */
export function appendExelixiFlowToUrl(
  url: string,
  exelixiCatalogFlow?: boolean,
  sessionProduct?: FlowProduct | string | null,
): string {
  if (!url || !exelixiCatalogFlow) return url;
  if (isLaMundialProduct(sessionProduct)) return url;
  try {
    const u = new URL(url, 'https://cierrelmds.exelixitech.com');
    const product = u.searchParams.get('product');
    if (LM_PRODUCTS.has(product ?? '')) return url;
    if (!u.searchParams.has('flow')) {
      u.searchParams.set('flow', 'exelixi-catalog');
    }
    return u.toString();
  } catch {
    if (url.includes('flow=exelixi-catalog')) return url;
    if (/[?&]product=(rcv|funerario)(&|$)/.test(url)) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}flow=exelixi-catalog`;
  }
}
