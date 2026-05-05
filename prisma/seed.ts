import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 Iniciando Seed de Staging - Exelixi Nexus...');

  // 1. Limpiar datos existentes
  await prisma.permission.deleteMany();
  await prisma.usuario.deleteMany();
  await prisma.role.deleteMany();
  await prisma.empresaModulo.deleteMany();
  await prisma.submodulo.deleteMany();
  await prisma.modulo.deleteMany();
  await prisma.empresa.deleteMany();

  console.log('🧹 Base de datos limpia.');

  // 2. Crear Módulos y Submódulos del Sistema
  const modulosData = [
    {
      nombre: 'Ventas',
      submodulos: ['Cotizaciones', 'Facturación', 'Clientes', 'Reportes'],
    },
    {
      nombre: 'Inventario',
      submodulos: ['Productos', 'Almacenes', 'Movimientos', 'Stock'],
    },
    {
      nombre: 'RRHH',
      submodulos: ['Empleados', 'Nómina', 'Asistencia'],
    },
    {
      nombre: 'Contabilidad',
      submodulos: ['Libro Mayor', 'Balances', 'Impuestos'],
    },
  ];

  const modulosMap = new Map();
  for (const m of modulosData) {
    const createdModulo = await prisma.modulo.create({
      data: {
        nombre: m.nombre,
        activo: true,
        submodulos: {
          create: m.submodulos.map((s) => ({ nombre: s, activo: true })),
        },
      },
    });
    modulosMap.set(m.nombre, createdModulo);
    console.log(`✅ Módulo '${m.nombre}' creado.`);
  }

  const hashedPassword = await bcrypt.hash('password123', 10);

  // 3. Crear Empresa Maestra (Exelixi Nexus) para el Admin del Sistema
  const exelixi = await prisma.empresa.create({
    data: {
      nombre: 'Exelixi Nexus S.A.',
      rif: 'J-00000000-0',
      tipo: 'SaaS Provider',
      activo: true,
    },
  });

  const superAdminRole = await prisma.role.create({
    data: {
      nombre: 'SuperAdmin',
      empresaId: exelixi.id,
      activo: true,
    },
  });

  // El SuperAdmin tiene acceso a todos los módulos en la empresa maestra
  for (const m of modulosMap.values()) {
    const em = await prisma.empresaModulo.create({
      data: {
        empresaId: exelixi.id,
        moduloId: m.id,
        token: `nexus-master-${m.nombre.toLowerCase()}`,
        activo: true,
      },
    });

    await prisma.permission.create({
      data: {
        roleId: superAdminRole.id,
        empresaModuloId: em.id,
        activo: true,
      },
    });
  }

  // USUARIO ADMIN DEL SISTEMA
  const systemAdmin = await prisma.usuario.create({
    data: {
      email: 'admin@exelixi.com',
      password: hashedPassword,
      nombre: 'Administrador Nexus',
      empresaId: exelixi.id,
      roleId: superAdminRole.id,
      activo: true,
    },
  });

  console.log('👑 Usuario Admin del Sistema creado: admin@exelixi.com');

  // 4. Crear Empresa de Cliente (Tecnologías Globales)
  const techGlobal = await prisma.empresa.create({
    data: {
      nombre: 'Tecnologías Globales S.A.',
      rif: 'J-11111111-1',
      tipo: 'Enterprise',
      activo: true,
    },
  });

  const ownerRole = await prisma.role.create({
    data: {
      nombre: 'Owner',
      empresaId: techGlobal.id,
      activo: true,
    },
  });

  // Activar algunos módulos para esta empresa
  const activeModules = ['Ventas', 'Inventario', 'RRHH'];
  for (const modName of activeModules) {
    const m = modulosMap.get(modName);
    const em = await prisma.empresaModulo.create({
      data: {
        empresaId: techGlobal.id,
        moduloId: m.id,
        token: `tk-tech-${modName.toLowerCase()}`,
        activo: true,
      },
    });

    await prisma.permission.create({
      data: {
        roleId: ownerRole.id,
        empresaModuloId: em.id,
        activo: true,
      },
    });
  }

  // USUARIO DUEÑO DE EMPRESA
  const companyOwner = await prisma.usuario.create({
    data: {
      email: 'owner@techglobal.com',
      password: hashedPassword,
      nombre: 'Dueño de Empresa Tech',
      empresaId: techGlobal.id,
      roleId: ownerRole.id,
      activo: true,
    },
  });

  console.log('💼 Usuario Dueño de Empresa creado: owner@techglobal.com');

  // USUARIO ACME (Original) para compatibilidad
  const acme = await prisma.empresa.create({
    data: {
      nombre: 'ACME Corp',
      rif: 'J-12345678-9',
      tipo: 'SaaS',
      activo: true,
    },
  });

  const acmeRole = await prisma.role.create({
    data: {
      nombre: 'SuperAdmin',
      empresaId: acme.id,
      activo: true,
    },
  });

  const ventasMod = modulosMap.get('Ventas');
  const acmeEM = await prisma.empresaModulo.create({
    data: {
      empresaId: acme.id,
      moduloId: ventasMod.id,
      token: 'acme-ventas-token',
      activo: true,
    },
  });

  await prisma.permission.create({
    data: {
      roleId: acmeRole.id,
      empresaModuloId: acmeEM.id,
      activo: true,
    },
  });

  await prisma.usuario.create({
    data: {
      email: 'admin@acme.com',
      password: hashedPassword,
      nombre: 'Admin ACME',
      empresaId: acme.id,
      roleId: acmeRole.id,
      activo: true,
    },
  });

  console.log('✅ Usuario admin@acme.com creado (Compatibilidad).');

  // 5. Crear una empresa adicional para pruebas de multi-tenant
  const retailCo = await prisma.empresa.create({
    data: {
      nombre: 'Distribuidora Retail C.A.',
      rif: 'J-22222222-2',
      tipo: 'Retail',
      activo: true,
    },
  });

  console.log('🏢 Empresa adicional creada: Distribuidora Retail C.A.');

  console.log('\n✨ Seed de Staging completado con éxito.');
  console.log('--------------------------------------------------');
  console.log('USUARIOS DE PRUEBA:');
  console.log('1. Admin Sistema: admin@exelixi.com / password123');
  console.log('2. Dueño Empresa: owner@techglobal.com / password123');
  console.log('--------------------------------------------------');
}

main()
  .catch((e) => {
    console.error('❌ Error durante el seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
