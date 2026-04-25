import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Iniciando seed adaptado a la base de datos existente...');

  // 1. Crear módulos base
  const moduloVentas = await prisma.modulo.create({
    data: {
      nombre: 'Ventas',
      activo: true
    }
  });

  const moduloInventario = await prisma.modulo.create({
    data: {
      nombre: 'Inventario',
      activo: true
    }
  });

  console.log('Módulos creados.');

  // 1.1 Crear Submódulos para Ventas
  await prisma.submodulo.createMany({
    data: [
      { nombre: 'Cotizaciones', moduloId: moduloVentas.id, activo: true },
      { nombre: 'Facturación', moduloId: moduloVentas.id, activo: true },
      { nombre: 'Clientes', moduloId: moduloVentas.id, activo: true }
    ]
  });

  console.log('Submódulos de ventas creados.');

  // 2. Crear Empresa
  const empresa = await prisma.empresa.create({
    data: {
      nombre: 'ACME Corp',
      rif: 'J-12345678-9',
      tipo: 'SaaS',
      activo: true
    }
  });

  console.log(`Empresa '${empresa.nombre}' creada.`);

  // 3. Activar módulo para empresa
  const empresaModulo = await prisma.empresaModulo.create({
    data: {
      empresaId: empresa.id,
      moduloId: moduloVentas.id,
      token: 'token-ventas-123',
      activo: true
    }
  });

  console.log('Módulo de ventas activado para la empresa.');

  // 4. Crear Rol
  const role = await prisma.role.create({
    data: {
      nombre: 'Vendedor',
      empresaId: empresa.id,
      activo: true
    }
  });

  // 5. Asignar permiso (relacionado con EmpresaModulo en este esquema)
  await prisma.permission.create({
    data: {
      roleId: role.id,
      empresaModuloId: empresaModulo.id,
      activo: true
    }
  });

  console.log('Permisos asignados.');

  // 6. Crear Usuario
  const hashedPassword = await bcrypt.hash('admin123', 10);
  await prisma.usuario.create({
    data: {
      email: 'admin@acme.com',
      password: hashedPassword,
      nombre: 'Admin ACME',
      empresaId: empresa.id,
      roleId: role.id,
      activo: true
    }
  });

  console.log('Usuario admin@acme.com creado (password: admin123).');
}

main()
  .catch((e) => {
    console.error('Error durante el seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
