import { describe, expect, it } from 'vitest';
import {
  appendExelixiFlowToUrl,
  appendProductToUrl,
  flowChainKey,
  resolveFlowProduct,
} from './flow-product';

describe('flowChainKey — rcv y funerario no son la misma entrada OCR', () => {
  const origin = 'https://nexusqa.exelixitech.com/ocr/';

  it('distingue product=funerario de product=rcv en el mismo path', () => {
    expect(flowChainKey(`${origin}?product=funerario`)).not.toBe(
      flowChainKey(`${origin}?product=rcv`),
    );
  });

  it('RCV sin query y RCV con product=rcv son la misma cadena', () => {
    expect(flowChainKey(origin)).toBe(flowChainKey(`${origin}?product=rcv`));
  });

  it('nombre Funerario fuerza producto aunque la URL no tenga query', () => {
    expect(flowChainKey(origin, 'OCR Funerario')).toContain('#funerario');
    expect(flowChainKey(origin, 'OCR Documentos')).toContain('#rcv');
  });
});

describe('appendProductToUrl', () => {
  const form = 'https://nexusqa.exelixitech.com/formulario/?sid=1';

  it('funerario pisa un product=rcv erróneo', () => {
    const mixed = `${form}&product=rcv`;
    expect(appendProductToUrl(mixed, 'funerario')).toContain(
      'product=funerario',
    );
    expect(appendProductToUrl(mixed, 'funerario')).not.toContain('product=rcv');
  });

  it('RCV no añade query y quita product=funerario', () => {
    expect(appendProductToUrl(form, 'rcv')).toBe(form);
    expect(
      appendProductToUrl(`${form}&product=funerario`, 'rcv'),
    ).not.toContain('funerario');
  });
});

describe('appendExelixiFlowToUrl', () => {
  const rcv = 'https://ocr.exelixitech.com/?sid=1';

  it('nunca añade catálogo si la sesión es funerario', () => {
    expect(appendExelixiFlowToUrl(rcv, true, 'funerario')).toBe(rcv);
  });

  it('nunca añade catálogo si la URL ya es RCV/funerario', () => {
    expect(appendExelixiFlowToUrl(`${rcv}&product=rcv`, true)).not.toContain(
      'exelixi-catalog',
    );
  });
});

describe('resolveFlowProduct', () => {
  it('no infiere funerario solo por path /ocr/', () => {
    expect(
      resolveFlowProduct({
        submoduloUrl: 'https://nexusqa.exelixitech.com/ocr/',
      }),
    ).toBe('rcv');
  });
});
