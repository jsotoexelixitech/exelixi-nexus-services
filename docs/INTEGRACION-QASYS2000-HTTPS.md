# QASys2000 → Nexus API (HTTPS / Mixed Content)

## Problema

QASys2000 corre en **HTTPS** (`https://qasys2000.lamundialdeseguros.com`) pero el Angular llama a nexus-api en **HTTP** (`http://192.168.8.120:3092`).

El navegador **bloquea** esa petición (Mixed Content) antes de CORS. Por eso ves:

- `Mixed Content: ... requested an insecure XMLHttpRequest endpoint`
- `No 'Access-Control-Allow-Origin' header` (efecto secundario)

**CORS solo no basta:** aunque nexus-api permita el origen, el browser no deja HTTPS → HTTP.

## Solución — Nginx HTTPS hacia nexus-api

Exponer nexus-api por **HTTPS** (mismo certificado La Mundial o subdominio):

```nginx
server {
  listen 443 ssl;
  server_name nexus-api.lamundialdeseguros.com;

  ssl_certificate     /ruta/fullchain.pem;
  ssl_certificate_key /ruta/privkey.pem;

  location / {
    proxy_pass http://192.168.8.120:3092;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Angular usaría:

```typescript
// ❌ Bloqueado (mixed content)
'http://192.168.8.120:3092/api/auth/sso-delegate';

// ✅ HTTPS
'https://nexus-api.lamundialdeseguros.com/api/auth/sso-delegate';
```

CORS en nexus-api ya permite `*.lamundialdeseguros.com` (ver `src/config/cors.ts`).

## Deploy nexus-api (CORS)

```bash
cd ~/nexus-api && git pull origin main && npm run build && pm2 restart nexus-api
```

## Alternativa — Proxy en backend propio de QASys2000

Si QASys2000 tiene **otro** backend (no SysIP-backend), puede reenviar `sso-delegate` server-to-server. El browser llama HTTPS mismo origen; el backend llama HTTP a `192.168.8.120:3092`.

## Checklist

1. DNS + SSL para URL HTTPS de nexus-api
2. Deploy nexus-api con fix CORS
3. Cambiar URL en Angular de HTTP IP → HTTPS
4. Verificar que usuarios lleguen a `192.168.8.120` (VPN/red La Mundial) o que el proxy HTTPS sea público
