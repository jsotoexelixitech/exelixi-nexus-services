import prisma from '../../config/prisma';

const SSO_TARGET_PORT: Record<string, string> = {
  ocr: '5181',
  formulario: '5182',
  emision: '5183',
  pagos: '5184',
};

const SSO_TARGET_HOST: Record<string, string> = {
  ocr: 'ocr.exelixitech.com',
  formulario: 'formulario.exelixitech.com',
  emision: 'emision.exelixitech.com',
  pagos: 'pagos.exelixitech.com',
};

const SSO_TARGET_NAME: Record<string, string> = {
  ocr: 'OCR Documentos',
  formulario: 'Formulario',
  emision: 'Emisi?n',
  pagos: 'Pagos',
};

function isFuneralSubHint(
  url?: string | null,
  nombre?: string | null,
  moduloNombre?: string | null,
) {
  const blob =
    `${url ?? ''} ${nombre ?? ''} ${moduloNombre ?? ''}`.toLowerCase();
  return blob.includes('funerar') || blob.includes('product=funerario');
}

function isPatrimonialSubHint(
  url?: string | null,
  nombre?: string | null,
  moduloNombre?: string | null,
) {
  const blob =
    `${url ?? ''} ${nombre ?? ''} ${moduloNombre ?? ''}`.toLowerCase();
  return blob.includes('patrimonial') || blob.includes('product=patrimoniales');
}

function ssoSubHintScore(
  product: 'rcv' | 'funerario' | 'patrimoniales',
  url?: string | null,
  nombre?: string | null,
  moduloNombre?: string | null,
) {
  const fun = isFuneralSubHint(url, nombre, moduloNombre);
  const pat = isPatrimonialSubHint(url, nombre, moduloNombre);
  if (product === 'funerario') return fun ? 2 : pat ? -1 : 0;
  if (product === 'patrimoniales') return pat ? 2 : fun ? -1 : 0;
  return fun || pat ? 0 : 1;
}

/** Misma resolución que sso-delegate (submódulo activo + empresa). */
export async function findSubmoduloForSsoTarget(
  target: string,
  opts?: {
    empresaId?: number;
    product?: 'rcv' | 'funerario' | 'patrimoniales';
  },
) {
  const key = target in SSO_TARGET_PORT ? target : 'ocr';
  const puerto = SSO_TARGET_PORT[key];
  const nameHint = SSO_TARGET_NAME[key] ?? SSO_TARGET_NAME.ocr;
  const hostHint = SSO_TARGET_HOST[key];
  const product =
    opts?.product === 'funerario' || opts?.product === 'patrimoniales'
      ? opts.product
      : 'rcv';

  const orFilters = [
    { url: { contains: puerto } },
    { nombre: { contains: nameHint, mode: 'insensitive' as const } },
    ...(hostHint ? [{ url: { contains: hostHint } }] : []),
    ...(key === 'ocr' ? [{ url: { contains: '/ocr' } }] : []),
    ...(key === 'formulario' ? [{ url: { contains: '/formulario' } }] : []),
    ...(key === 'emision' ? [{ url: { contains: '/emision' } }] : []),
    ...(key === 'pagos' ? [{ url: { contains: '/pagos' } }] : []),
  ];

  const rows = await prisma.submodulo.findMany({
    where: {
      activo: true,
      url: { not: null },
      OR: orFilters,
    },
    select: {
      id: true,
      url: true,
      nombre: true,
      modulo: { select: { nombre: true } },
    },
    orderBy: { id: 'asc' },
  });

  if (rows.length === 0) return null;

  let pool = rows;
  if (opts?.empresaId) {
    const links = await prisma.empresaSubmodulo.findMany({
      where: {
        empresaId: opts.empresaId,
        activo: true,
        submoduloId: { in: rows.map((r) => r.id) },
      },
      select: { submoduloId: true },
    });
    const assigned = new Set(links.map((l) => l.submoduloId));
    const onlyAssigned = rows.filter((r) => assigned.has(r.id));
    if (onlyAssigned.length > 0) pool = onlyAssigned;
  }

  const ranked = [...pool].sort((a, b) => {
    const aScore = ssoSubHintScore(product, a.url, a.nombre, a.modulo?.nombre);
    const bScore = ssoSubHintScore(product, b.url, b.nombre, b.modulo?.nombre);
    return bScore - aScore;
  });

  const hit = ranked[0];
  return hit
    ? {
        id: hit.id,
        url: hit.url,
        nombre: hit.nombre,
        moduloNombre: hit.modulo?.nombre,
      }
    : null;
}
