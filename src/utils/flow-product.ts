export type FlowProduct = 'rcv' | 'funerario';

/**
 * Infiere el producto del flujo desde URL del submódulo o nombres (módulo/submódulo).
 * @param hints
 * @returns {FlowProduct}
 */
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
 * Añade ?product=funerario a URLs de navegación solo cuando el flujo es funerario.
 * RCV no se modifica (comportamiento previo sin query param).
 * @param url
 * @param product
 * @returns {string}
 */
export function appendProductToUrl(url: string, product: FlowProduct): string {
  if (!url || product !== 'funerario') return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('product')) {
      u.searchParams.set('product', product);
      return u.toString();
    }
    return url;
  } catch {
    if (url.includes('product=')) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}product=${product}`;
  }
}
