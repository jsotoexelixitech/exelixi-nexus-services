# Revisión Apache — cierrelmds.exelixitech.com (srv001)

**Para:** equipo de infraestructura / servidores  
**De:** desarrollo Exélixi (jsoto)  
**Fecha:** 2026-08-04  
**Servidor:** srv001 · `192.168.8.120` · usuario PM2: `jsoto`  
**Dominio:** `https://cierrelmds.exelixitech.com`

---

## 1. Resumen del problema actual

Los backends (PM2) responden **200 OK** en local. El fallo está en **Apache :443**.

| URL HTTPS       | Apache                                                          | Local PM2 (sin Apache)                 |
| --------------- | --------------------------------------------------------------- | -------------------------------------- |
| `/ocr/`         | **302** → `Location: /ocr/` (bucle)                             | `http://127.0.0.1:5181/ocr/` → **200** |
| `/formulario/`  | **302** → `Location: /formulario/` (bucle)                      | `:5182/formulario/` → **200**          |
| `/pagos/`       | **302** → `Location: /pagos/` (bucle)                           | `:5184/pagos/` → **200**               |
| `/emision/`     | **200 OK**                                                      | `:5183/emision/` → **200**             |
| `/ocr/exelixi/` | **302** → `/ocr/?flow=exelixi-catalog` (luego bucle en `/ocr/`) | `:5181/ocr/exelixi/` → **200**         |

**Interpretación técnica:**

1. **`/emision/` funciona** → el ProxyPass de emisión está bien (conserva el prefijo hacia el backend).
2. **`/ocr/`, `/formulario/`, `/pagos/`** → bucle 302 a sí mismos → suele indicar **ProxyPass con strip del prefijo** (Apache envía `/` al backend en lugar de `/ocr/`, Vite redirige a `/ocr/`, Apache repite).
3. **`/ocr/exelixi/`** → 302 a `/ocr/?flow=exelixi-catalog` → el backend recibe **`/exelixi/`** (prefijo `/ocr/` eliminado); el fallback SPA de Vite redirige al path correcto, pero Apache vuelve a entrar en bucle.

**Config incorrecta (ejemplo):**

```apache
# ❌ MAL — quita /ocr/ antes de enviar a :5181
ProxyPass /ocr/ http://127.0.0.1:5181/
```

**Config correcta:**

```apache
# ✅ BIEN — el backend Vite espera recibir /ocr/ en la URL
ProxyPass /ocr/ http://127.0.0.1:5181/ocr/
ProxyPassReverse /ocr/ http://127.0.0.1:5181/ocr/
```

---

## 2. Mapa completo de servicios en srv001

### 2.1 Módulos La Mundial / Exélixi (flujo OCR → Pagos)

| Prefijo público HTTPS | Puerto web PM2 | Proceso PM2   | Puerto API | Proceso API   | Carpeta en servidor                         |
| --------------------- | -------------- | ------------- | ---------- | ------------- | ------------------------------------------- |
| `/ocr/`               | **5181**       | `ocr-web`     | **4001**   | `ocr-api`     | `/home/jsoto/exelixi/ocr-documentos-modulo` |
| `/formulario/`        | **5182**       | `form-web`    | **4002**   | `form-api`    | `/home/jsoto/exelixi/Formulario-modulo`     |
| `/emision/`           | **5183**       | `emision-web` | **4004**   | `emision-api` | `/home/jsoto/exelixi/Emision-Plan-modulo`   |
| `/pagos/`             | **5184**       | `pagos-web`   | **4003**   | `pagos-api`   | `/home/jsoto/exelixi/Pagos-Poliza-modulo`   |

Las APIs `:4001`–`:4004` **no** se publican por HTTPS. Solo los frontends `:518x` van detrás de Apache.

### 2.2 Nexus, catálogo y nest-api

| Prefijo público HTTPS    | Puerto   | Proceso PM2            | Strip prefijo en Apache           | Carpeta                        |
| ------------------------ | -------- | ---------------------- | --------------------------------- | ------------------------------ |
| `/admin/`                | **5200** | `nexus-admin`          | **NO** — backend recibe `/admin/` | `/home/jsoto/nexus-admin`      |
| `/nexus-api/`            | **3092** | `nexus-api`            | **SÍ** — backend recibe `/`       | `/home/jsoto/nexus-api`        |
| `/producto-builder/`     | **5215** | `producto-builder-web` | **NO**                            | `/home/jsoto/producto-builder` |
| `/producto-builder-api/` | **3015** | `producto-builder-api` | **NO**                            | `/home/jsoto/producto-builder` |
| `/nest-api-docs/`        | **3002** | `sysip-nest-api`       | **SÍ** — backend recibe `/`       | `/home/jsoto/server-api-sys`   |

### 2.3 Auto Casa RCV (aislado — NO en vhost cierrelmds módulos)

| Proceso PM2 | Puerto   | Notas                        |
| ----------- | -------- | ---------------------------- |
| `rcv-api`   | **3001** | No reutilizar para pagos-api |
| `rcv-web`   | **5180** | No reutilizar para pagos-web |

---

## 3. Prefijo OCR (detalle para revisión)

### Build del frontend OCR

Archivo en repo: `ocr-documentos-modulo/frontend/.env.production`

```env
VITE_APP_BASE=/ocr/
VITE_NEXUS_API_URL=https://cierrelmds.exelixitech.com/nexus-api
VITE_FORMULARIO_CONTINUE_BASE=/formulario
```

- Vite compila assets con **base path `/ocr/`** (todas las rutas JS/CSS son `/ocr/assets/...`).
- El servidor de preview en producción escucha en **`:5181`** y espera peticiones con prefijo **`/ocr/`** en la URL.
- Ruta Exélixi catálogo: **`/ocr/exelixi/`** (también `?flow=exelixi-catalog`).

### ProxyPass OCR requerido

```apache
ProxyPass        /ocr/         http://127.0.0.1:5181/ocr/
ProxyPassReverse /ocr/         http://127.0.0.1:5181/ocr/
```

### Verificación OCR

```bash
# Debe ser HTTP/1.1 200 — sin Location
curl -sI https://cierrelmds.exelixitech.com/ocr/ | grep -iE '^HTTP|^Location'
curl -sI https://cierrelmds.exelixitech.com/ocr/exelixi/ | grep -iE '^HTTP|^Location'

# Referencia local (ya OK en srv001):
curl -sI http://127.0.0.1:5181/ocr/ | head -1
curl -sI http://127.0.0.1:5181/ocr/exelixi/ | head -1
```

---

## 4. Prefijos de los demás módulos (build Vite)

| Módulo           | `VITE_APP_BASE` (build)                        | ProxyPass requerido (sin strip)           |
| ---------------- | ---------------------------------------------- | ----------------------------------------- |
| OCR              | `/ocr/`                                        | `http://127.0.0.1:5181/ocr/`              |
| Formulario       | `/formulario/`                                 | `http://127.0.0.1:5182/formulario/`       |
| Emisión          | `/emision/` (o relativo `./` bajo `/emision/`) | `http://127.0.0.1:5183/emision/`          |
| Pagos            | `/pagos/`                                      | `http://127.0.0.1:5184/pagos/`            |
| Nexus Admin      | `/admin/`                                      | `http://127.0.0.1:5200/admin/`            |
| Producto builder | `/producto-builder/`                           | `http://127.0.0.1:5215/producto-builder/` |

**Regla:** frontends Vite con `VITE_APP_BASE=/xxx/` → Apache debe reenviar **`/xxx/`** al backend, **no** quitar el prefijo.

**Excepción (strip permitido):** solo APIs REST puras: `/nexus-api/` → `:3092/`, `/nest-api-docs/` → `:3002/`.

---

## 5. Fragmento Apache canónico completo

Archivo de referencia en repo:  
`exelixi-nexus-services/deploy/apache-cierrelmds-modulos.conf`

Insertar **dentro** del VirtualHost SSL `:443` de `cierrelmds.exelixitech.com`.  
**Orden:** rutas más específicas primero; `producto-builder` no debe capturar `/ocr/`.

```apache
<IfModule mod_ssl.c>
    # ── Producto builder (catálogo admin Exélixi) ──
    ProxyPass        /producto-builder-api/  http://127.0.0.1:3015/producto-builder-api/
    ProxyPassReverse /producto-builder-api/  http://127.0.0.1:3015/producto-builder-api/
    ProxyPass        /producto-builder/      http://127.0.0.1:5215/producto-builder/
    ProxyPassReverse /producto-builder/      http://127.0.0.1:5215/producto-builder/

    # ── Módulos suscripción La Mundial (OCR → Form → Emisión → Pagos) ──
    ProxyPass        /ocr/         http://127.0.0.1:5181/ocr/
    ProxyPassReverse /ocr/         http://127.0.0.1:5181/ocr/

    ProxyPass        /formulario/  http://127.0.0.1:5182/formulario/
    ProxyPassReverse /formulario/  http://127.0.0.1:5182/formulario/

    ProxyPass        /emision/     http://127.0.0.1:5183/emision/
    ProxyPassReverse /emision/     http://127.0.0.1:5183/emision/

    ProxyPass        /pagos/       http://127.0.0.1:5184/pagos/
    ProxyPassReverse /pagos/       http://127.0.0.1:5184/pagos/

    # ── Nexus ──
    ProxyPass        /nexus-api/   http://127.0.0.1:3092/
    ProxyPassReverse /nexus-api/   http://127.0.0.1:3092/

    ProxyPass        /admin/       http://127.0.0.1:5200/admin/
    ProxyPassReverse /admin/       http://127.0.0.1:5200/admin/

    # ── nest-api La Mundial (Swagger/docs) ──
    ProxyPass        /nest-api-docs/  http://127.0.0.1:3002/
    ProxyPassReverse /nest-api-docs/  http://127.0.0.1:3002/
</IfModule>
```

---

## 6. Reglas a ELIMINAR si existen (causan el incidente)

```apache
Redirect /ocr /producto-builder/
RedirectMatch ^/ocr /producto-builder/
ProxyPass /ocr/ http://127.0.0.1:5215/...
ProxyPass /formulario/ http://127.0.0.1:5215/...
ProxyPass /ocr/ http://127.0.0.1:5181/          # ← sin /ocr/ al final (strip)
ProxyPass /formulario/ http://127.0.0.1:5182/   # ← sin /formulario/ al final
ProxyPass /pagos/ http://127.0.0.1:5184/        # ← sin /pagos/ al final
```

---

## 7. Comandos para infra (revisar config activa)

```bash
# Ver reglas actuales del vhost
sudo grep -nE 'ProxyPass|ProxyPassReverse|Redirect|RewriteRule|producto-builder|/ocr/|/formulario/|/emision/|/pagos/' \
  /etc/apache2/sites-enabled/*cierrelmds* 2>/dev/null

# Comparar con emision (referencia que SÍ funciona)
sudo grep -A1 'emision' /etc/apache2/sites-enabled/*cierrelmds*
sudo grep -A1 'ocr'     /etc/apache2/sites-enabled/*cierrelmds*

# Tras corrección
sudo apache2ctl configtest && sudo systemctl reload apache2

# Smoke test (los 4 deben dar 200, sin Location)
for p in /ocr/ /formulario/ /emision/ /pagos/; do
  echo -n "$p → "
  curl -skI "https://cierrelmds.exelixitech.com${p}" | head -1
done
```

---

## 8. Estado PM2 verificado (2026-08-04 — desarrollo)

Todos los procesos relevantes **online**; puertos locales responden 200.  
No es necesario cambiar puertos PM2 — solo corregir Apache.

| Proceso                    | Puerto      | Estado |
| -------------------------- | ----------- | ------ |
| ocr-web / ocr-api          | 5181 / 4001 | online |
| form-web / form-api        | 5182 / 4002 | online |
| emision-web / emision-api  | 5183 / 4004 | online |
| pagos-web / pagos-api      | 5184 / 4003 | online |
| nexus-api / nexus-admin    | 3092 / 5200 | online |
| producto-builder-api / web | 3015 / 5215 | online |
| sysip-nest-api             | 3002        | online |

---

## 9. Contacto / repos

| Servicio                | Repo GitHub                               |
| ----------------------- | ----------------------------------------- |
| OCR                     | `jsotoexelixitech/ocr-documentos-modulo`  |
| Formulario              | `jsotoexelixitech/Formulario-modulo`      |
| Emisión                 | `jsotoexelixitech/Emision-Plan-modulo`    |
| Pagos                   | `jsotoexelixitech/Pagos-Poliza-modulo`    |
| Nexus API + docs deploy | `jsotoexelixitech/exelixi-nexus-services` |

Documentación adicional en repo `exelixi-nexus-services`:

- `docs/SRV001-MAPA-PUERTOS.md`
- `docs/CIERRELMDS-HTTPS-PREFIJOS.md`
- `deploy/apache-cierrelmds-modulos.conf`
