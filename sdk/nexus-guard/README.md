# NexusGuard SDK

Control de acceso Exélixi Nexus para cualquier framework frontend.

## Estructura del SDK

```
sdk/nexus-guard/
├── nexus-core.ts              ← núcleo puro TS (sin dependencias de framework)
├── useNexusAccess.ts          ← hook para React
├── NexusGuard.tsx             ← componente wrapper para React
└── frameworks/
    ├── svelte/NexusGuard.svelte
    ├── vue/NexusGuard.vue
    └── vanilla/nexus-guard.js  ← funciona en cualquier entorno JS
```

---

## React / React + Vite

**1.** Copia `nexus-core.ts`, `useNexusAccess.ts` y `NexusGuard.tsx` a `src/nexus/`

**2.** `.env`:
```
VITE_NEXUS_API_URL=http://192.168.8.120:3091
```

**3.** `main.tsx`:
```tsx
import { NexusGuard } from './nexus/NexusGuard'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <NexusGuard serviceName="RCV">
    <App />
  </NexusGuard>
)
```

**4.** Acceder a empresa en cualquier componente:
```tsx
import { useNexus } from './nexus/NexusGuard'
const { empresa } = useNexus()
// empresa.id, empresa.nombre, empresa.rif
```

---

## Svelte / SvelteKit

**1.** Copia `nexus-core.ts` y `frameworks/svelte/NexusGuard.svelte` a `src/nexus/`

**2.** `.env`:
```
VITE_NEXUS_API_URL=http://192.168.8.120:3091
```

**3.** `App.svelte` o `+layout.svelte`:
```svelte
<script>
  import NexusGuard from './nexus/NexusGuard.svelte'
</script>

<NexusGuard nexusApiUrl={import.meta.env.VITE_NEXUS_API_URL} serviceName="RCV">
  <slot />
</NexusGuard>
```

**4.** Acceder a empresa en componentes hijos:
```svelte
<script>
  import { nexusStore } from './nexus/NexusGuard.svelte'
</script>
<p>{$nexusStore.empresa?.nombre}</p>
```

---

## Vue 3

**1.** Copia `nexus-core.ts` y `frameworks/vue/NexusGuard.vue` a `src/nexus/`

**2.** `.env`:
```
VITE_NEXUS_API_URL=http://192.168.8.120:3091
```

**3.** `App.vue`:
```vue
<script setup>
import NexusGuard from './nexus/NexusGuard.vue'
</script>

<template>
  <NexusGuard :nexus-api-url="$env.VITE_NEXUS_API_URL" service-name="RCV">
    <RouterView />
  </NexusGuard>
</template>
```

**4.** Acceder a empresa en componentes hijos:
```vue
<script setup>
import { useNexus } from './nexus/NexusGuard.vue'
const { empresa } = useNexus()
</script>
```

---

## Angular

**1.** Copia `nexus-core.ts` a `src/nexus/`

**2.** `environment.ts`:
```typescript
export const environment = {
  nexusApiUrl: 'http://192.168.8.120:3091'
}
```

**3.** Crea `src/nexus/nexus.guard.ts`:
```typescript
import { Injectable } from '@angular/core'
import { CanActivate, Router } from '@angular/router'
import { verifyNexusAccess } from './nexus-core'
import { environment } from '../environments/environment'

@Injectable({ providedIn: 'root' })
export class NexusGuard implements CanActivate {
  constructor(private router: Router) {}

  async canActivate(): Promise<boolean> {
    const result = await verifyNexusAccess(environment.nexusApiUrl)
    if (!result.active) {
      this.router.navigate(['/blocked'])
      return false
    }
    localStorage.setItem('nexus_empresa', JSON.stringify(result.empresa))
    return true
  }
}
```

**4.** Aplica en `app-routing.module.ts`:
```typescript
{ path: '', canActivate: [NexusGuard], component: HomeComponent }
```

**5.** Acceder a empresa:
```typescript
const empresa = JSON.parse(localStorage.getItem('nexus_empresa') || '{}')
```

---

## Next.js (App Router)

**1.** Crea `src/nexus/nexus-core.ts` (mismo archivo)

**2.** `.env.local`:
```
NEXUS_API_URL=http://192.168.8.120:3091
```

**3.** `middleware.ts` (raíz del proyecto):
```typescript
import { NextRequest, NextResponse } from 'next/server'

export async function middleware(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('nexus_token')
              ?? req.cookies.get('nexus_token')?.value

  if (!token) return NextResponse.redirect(new URL('/blocked', req.url))

  const res = await fetch(`${process.env.NEXUS_API_URL}/api/access/verify`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store'
  }).then(r => r.json()).catch(() => ({ active: false }))

  if (!res.active) return NextResponse.redirect(new URL('/blocked', req.url))

  const response = NextResponse.next()
  response.cookies.set('nexus_token', token, { httpOnly: true, sameSite: 'strict' })
  response.cookies.set('nexus_empresa', JSON.stringify(res.empresa))
  return response
}

export const config = { matcher: ['/((?!blocked|_next|favicon).*)'] }
```

---

## Vanilla JS / HTML puro

**1.** Copia `frameworks/vanilla/nexus-guard.js` a tu proyecto

**2.** En tu HTML:
```html
<div id="app" style="display:none">
  <!-- tu app aquí -->
</div>

<script src="./nexus-guard.js"></script>
<script>
  NexusGuard.init({
    nexusApiUrl: 'http://192.168.8.120:3091',
    serviceName: 'RCV',
    onActive: function(empresa, submodulo) {
      document.getElementById('app').style.display = 'block'
      console.log('Empresa:', empresa.nombre)
      // Guarda empresa para usarla en tus fetch
      window.__empresa = empresa
    }
  })
</script>
```

---

## En todos los casos — guardar datos por empresa

El `empresa.id` que devuelve Nexus es el identificador de tenant. Inclúyelo en **todas** las llamadas al backend de tu servicio:

```javascript
// Listar datos de esa empresa
fetch(`/api/polizas?empresaId=${empresa.id}`)

// Guardar datos para esa empresa  
fetch('/api/polizas', {
  method: 'POST',
  body: JSON.stringify({ ...datos, empresaId: empresa.id })
})
```

El backend de tu servicio filtra siempre por `empresaId` — así cada empresa solo ve sus propios datos.
