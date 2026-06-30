# QASys2000 → Nexus API (HTTPS / Mixed Content)

> **Producción La Mundial:** usar prefijos en  
> **`https://cierrelmds.exelixitech.com`** — ver [CIERRELMDS-HTTPS-PREFIJOS.md](./CIERRELMDS-HTTPS-PREFIJOS.md).

## Problema

QASys2000 corre en **HTTPS** (`https://qasys2000.lamundialdeseguros.com`) pero el Angular llama a nexus-api en **HTTP** (`http://192.168.8.120:3092`).

El navegador **bloquea** esa petición (Mixed Content) antes de CORS.

## Solución activa — Caddy + sslip.io (srv001)

Sin DNS La Mundial: dominios wildcard públicos que apuntan a la IP del servidor.

| Servicio      | URL HTTPS                                                    |
| ------------- | ------------------------------------------------------------ |
| Nexus API     | `https://nexus-api.200-75-131-138.sslip.io`                  |
| Nexus Admin   | `https://nexus-admin.200-75-131-138.sslip.io`                |
| OCR web / api | `https://ocr.200-75-131-138.sslip.io` / `ocr-api...`         |
| Formulario    | `https://form.200-75-131-138.sslip.io` / `form-api...`       |
| Pagos         | `https://pagos.200-75-131-138.sslip.io` / `pagos-api...`     |
| Emisión       | `https://emision.200-75-131-138.sslip.io` / `emision-api...` |
| RCV           | `https://rcv.200-75-131-138.sslip.io` / `rcv-api...`         |

IP pública srv001: **200.75.131.138**

### Aplicar en srv001

```bash
# Copiar Caddyfile (desde repo o pegar contenido de docs/srv001-caddy-sslip.Caddyfile)
sudo cp ~/nexus-api/docs/srv001-caddy-sslip.Caddyfile /etc/caddy/Caddyfile
# o si no está en el servidor, scp desde PC local

sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
sleep 20

# Verificar DNS + HTTPS
dig +short nexus-api.200-75-131-138.sslip.io @8.8.8.8
curl -sI https://nexus-api.200-75-131-138.sslip.io/api/health | head -8
```

### Angular QASys2000

```typescript
// ❌ Bloqueado (mixed content)
'http://192.168.8.120:3092/api/auth/sso-delegate';

// ✅ HTTPS (sslip.io)
'https://nexus-api.200-75-131-138.sslip.io/api/auth/sso-delegate';
```

CORS: origen `qasys2000.lamundialdeseguros.com` ya permitido; frontends en `*.200-75-131-138.sslip.io` vía `TRUSTED_HOST_SUFFIXES` en `src/config/cors.ts`.

### Nexus Admin build

```bash
export VITE_NEXUS_API_URL=https://nexus-api.200-75-131-138.sslip.io
cd ~/nexus-admin && npm run build && pm2 restart nexus-admin
```

### Deploy nexus-api (CORS sslip.io)

```bash
cd ~/nexus-api && git pull && npm run build && pm2 restart nexus-api
```

## Futuro — DNS La Mundial

Cuando infra cree registros A, migrar a:

- `https://nexus-api.lamundialdeseguros.com`
- `https://nexus-admin.lamundialdeseguros.com`

## Checklist

1. Apache detenido (puerto 80 libre para Caddy)
2. Caddyfile sslip.io aplicado y `systemctl status caddy` active
3. `dig` resuelve `200.75.131.138`
4. Deploy nexus-api con CORS sslip.io
5. Angular: URL HTTPS sslip.io
6. Puertos 80/443 abiertos en firewall hacia srv001
