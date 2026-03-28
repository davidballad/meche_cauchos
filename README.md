# MZCauchos — Catálogo de repuestos

Sitio de una sola página (HTML, CSS y JavaScript sin frameworks ni herramientas de build) para gestionar el inventario de **MZCauchos**. El backend es [Supabase](https://supabase.com/) (plan gratuito).

## Requisitos previos

- Cuenta en [Supabase](https://supabase.com/)
- Cuenta en [GitHub](https://github.com/) (para alojamiento gratuito con GitHub Pages)

## 1. Crear el proyecto en Supabase y la tabla `parts`

1. Entra en [Supabase Dashboard](https://supabase.com/dashboard) y crea un **nuevo proyecto**.
2. Cuando el proyecto esté listo, abre el menú **SQL Editor**.
3. Crea una nueva consulta, pega el contenido completo de [`supabase_setup.sql`](./supabase_setup.sql) y pulsa **Run**.

Esto crea la tabla `parts` con las columnas indicadas, índices y políticas RLS que permiten al cliente web (clave **anon**) leer e insertar/actualizar/borrar. **En producción** deberías sustituir esto por políticas más restrictivas (por ejemplo, solo usuarios autenticados).

## 2. Obtener URL y clave anónima

1. En tu proyecto Supabase: **Project Settings** (engranaje) → **API**.
2. Copia **Project URL** y la clave **anon public** (`anon`).

## 3. Configurar `config.js` en local

1. Copia el archivo de ejemplo:
   - `config.example.js` → `config.js`
2. Abre `config.js` y sustituye los valores:

```js
export const supabaseUrl = 'https://xxxxx.supabase.co';
export const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

El archivo **`config.js` está en `.gitignore`** para que no se suba al repositorio por defecto.

Para probar el sitio en tu ordenador, abre `index.html` con un **servidor HTTP local** (los módulos ES no suelen funcionar abriendo el archivo directamente con `file://`):

```bash
# Ejemplo con Python 3
python -m http.server 8080
```

Luego visita `http://localhost:8080`.

## 4. Subir el código a GitHub

1. Crea un repositorio nuevo en GitHub (puede ser público o privado).
2. En la carpeta del proyecto:

```bash
git init
git add .
git commit -m "Catálogo MZCauchos con Supabase"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

**Nota:** `config.js` no se incluirá en el commit por el `.gitignore`. El sitio clonado desde GitHub **no tendrá** `config.js` hasta que uses una de las opciones del siguiente apartado.

## 5. Publicar en GitHub Pages

Tienes dos enfoques habituales:

### Opción A — Flujo recomendado: secretos + GitHub Actions

El repositorio incluye [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml), que en cada push a `main` (o `master`):

1. Genera `config.js` en el runner usando secretos del repositorio.
2. Publica los archivos estáticos en la rama **`gh-pages`**.

Pasos:

1. En GitHub: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. Crea dos secretos:
   - `SUPABASE_URL` — tu Project URL.
   - `SUPABASE_ANON_KEY` — tu clave anon public.
3. Haz push a `main` para que se ejecute el workflow.
4. **Settings** → **Pages** → **Build and deployment** → **Source**: elige **Deploy from a branch**, rama **`gh-pages`**, carpeta **`/` (root)**.
5. Tras unos minutos, el sitio estará en `https://TU_USUARIO.github.io/TU_REPO/`.

Si no configuras los secretos, el job fallará hasta que los añadas.

### Opción B — Sin Actions: incluir `config.js` en el repo

La clave **anon** de Supabase está pensada para usarse en el navegador; la seguridad real depende de **RLS**. Si aceptas versionarla (por ejemplo en un repo privado), puedes quitar `config.js` del `.gitignore`, crear el archivo con tus valores y hacer commit. Entonces puedes activar GitHub Pages desde la rama **`main`** y la carpeta **root** sin usar el workflow.

---

## Uso de la aplicación

- **Panel:** total de repuestos, valor estimado del inventario (precio × stock) y lista de piezas con stock en o por debajo del umbral.
- **Catálogo:** rejilla de tarjetas con datos principales; **Editar** / **Eliminar** (con confirmación antes de borrar).
- **Añadir / Editar:** formulario alineado con las columnas de `parts`.
- **Buscar:** filtrado en tiempo real por texto (nombre, número de parte, marca) y desplegables de categoría y marca.

Durante las peticiones a Supabase verás un **spinner** global; tras guardar o eliminar aparecen **notificaciones** (éxito o error).

## Archivos principales

| Archivo | Descripción |
|--------|-------------|
| `index.html` | Página única con todas las secciones |
| `styles.css` | Estilos (rojo `#8B0000`, blanco, grises) |
| `app.js` | Lógica y cliente Supabase (CDN ESM) |
| `config.js` | Credenciales (local, no versionado) |
| `config.example.js` | Plantilla para copiar |
| `supabase_setup.sql` | SQL para crear la tabla y políticas |

## Licencia

Uso interno para MZCauchos; adapta la licencia según tu negocio.
