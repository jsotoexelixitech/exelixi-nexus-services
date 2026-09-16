export type FlowProduct = 'rcv' | 'funerario' | 'patrimoniales';

const LM_PRODUCTS = new Set<string>(['rcv', 'funerario', 'patrimoniales']);

function isFlowProduct(value: string): value is FlowProduct {
  return value === 'rcv' || value === 'funerario' || value === 'patrimoniales';
}

/**
 * Infiere el producto del flujo desde URL del submódulo o nombres (módulo/submódulo).
 * Funerario solo si `?product=funerario` o el nombre contiene "funerar".
 * Patrimoniales si `?product=patrimoniales` o el nombre contiene "patrimonial".
 * Nunca infiere funerario/patrimoniales desde una URL RCV (mismo path `/ocr/` sin query).
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
  if (isFlowProduct(raw)) return raw;
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
      if (fromUrl && isFlowProduct(fromUrl)) return fromUrl;
    } catch {
      /* ignore */
    }
  }
  const label =
    `${hints.submoduloNombre ?? ''} ${hints.moduloNombre ?? ''}`.toLowerCase();
  if (label.includes('funerar')) return 'funerario';
  if (label.includes('patrimonial')) return 'patrimoniales';
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
  return isFlowProduct(String(product ?? ''));
}

function stripLmProductQuery(url: string): string {
  return url
    .replace(
      /([?&])product=(funerario|patrimoniales)(&)?/g,
      (_m, q, _p, amp) => (amp ? String(q) : ''),
    )
    .replace(/[?&]$/, '');
}

/**
 * Funerario / patrimoniales: fuerza `?product=` (pisa un `rcv` erróneo).
 * RCV: no añade query; si la URL trae funerario o patrimoniales, lo quita.
 */
export function appendProductToUrl(url: string, product: FlowProduct): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    const current = u.searchParams.get('product');
    if (product === 'funerario' || product === 'patrimoniales') {
      if (current === product) return url;
      u.searchParams.set('product', product);
      return u.toString();
    }
    if (current === 'funerario' || current === 'patrimoniales') {
      u.searchParams.delete('product');
      return u.toString();
    }
    return url;
  } catch {
    if (product === 'funerario' || product === 'patrimoniales') {
      if (url.includes(`product=${product}`)) return url;
      const stripped = stripLmProductQuery(url)
        .replace(/([?&])product=[^&]*/g, '$1')
        .replace(/[?&]$/, '');
      const sep = stripped.includes('?') ? '&' : '?';
      return `${stripped}${sep}product=${product}`;
    }
    return stripLmProductQuery(url);
  }
}

/**
 * Propaga `?flow=exelixi-catalog` solo en el flujo catálogo.
 * Nunca en RCV, funerario ni patrimoniales La Mundial.
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
    if (/[?&]product=(rcv|funerario|patrimoniales)(&|$)/.test(url)) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}flow=exelixi-catalog`;
  }
}
