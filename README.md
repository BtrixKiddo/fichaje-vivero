# Fichaje Vivero 🌱

App web (PWA) para fichar **entrada/salida** de los trabajadores con una **tarjeta NFC**.
Funciona **sin internet**, guarda todo **solo en el móvil** y cumple el registro horario
(art. 34.9 del Estatuto de los Trabajadores). Sin lectura para el trabajador: acerca la
tarjeta y ve su **foto + color** (verde = entrada, naranja = salida, rojo = tarjeta no válida).

---

## 1. Publicarla en internet (una sola vez, con HTTPS)

WebNFC **exige HTTPS y Chrome en Android**. La forma gratis más fácil es **GitHub Pages**:

1. Crea una cuenta en <https://github.com> (desde un ordenador).
2. Crea un repositorio nuevo, por ejemplo `fichaje-vivero`, y marca **Public**.
3. Sube **todos** estos archivos a la raíz del repositorio (botón *Add file → Upload files*):
   - `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`
   - `icon-192.png`, `icon-512.png`
4. En el repo: **Settings → Pages**. En *Branch* elige `main` y carpeta `/ (root)`. Guarda.
5. Espera 1-2 minutos. Te dará una dirección tipo:
   `https://TU-USUARIO.github.io/fichaje-vivero/`

Esa dirección (con `https://`) es la que abrirás en el móvil.

---

## 2. Instalarla en el Galaxy Note 10 Lite

1. Abre **Chrome** en el móvil y entra en la dirección de arriba.
2. Menú de Chrome (⋮) → **Añadir a pantalla de inicio** / **Instalar app**.
3. Se crea un icono 🌱 en el móvil. Ábrela desde ahí (se ve a pantalla completa).
4. La **primera vez con internet** deja que cargue entera; después ya funciona **offline**.
5. Activa el **NFC** del móvil (Ajustes → Conexiones → NFC).
6. La primera vez, la app pedirá permiso de NFC: acepta. Si aparece *"Toca la pantalla
   para activar"*, tócala una vez para arrancar la lectura.

> Consejo: en el móvil, pon la pantalla para que **no se apague** o tarde mucho, y déjalo
> enchufado. Así queda de "kiosco" siempre listo.

---

## 3. Probar la tarjeta (¡lo primero!)

Antes de nada, comprueba que el móvil **lee el número** de una tarjeta NTAG215:

1. Abre la app, entra en **Administrador** (engranaje ⚙️ arriba a la derecha).
2. PIN por defecto: **1234** (cámbialo luego, ver punto 6).
3. Pulsa **Alta tarjeta → 📶 Leer tarjeta** y acerca la tarjeta a la parte de atrás del móvil
   (cerca de la cámara). Debe aparecer el número (UID). Si no lo lee, prueba a moverla
   despacio por la zona de la cámara hasta que salga.

Solo usamos el **número de serie** de la tarjeta, nunca su memoria.

---

## 4. Dar de alta las 6 tarjetas

Para cada trabajador, en **Administrador → Alta tarjeta**:

1. **📶 Leer tarjeta** y acerca su tarjeta (o escribe el número a mano).
2. Escribe su **nombre**.
3. Pulsa el botón de **foto**: haz una foto con la cámara o elige una de la galería.
4. **Guardar**. Repite con las 6 tarjetas.

Para cambiar la foto o el nombre, vuelve a leer la misma tarjeta y guarda de nuevo.

---

## 5. Fichar (lo que hace el trabajador)

- La pantalla dice **"Acerca tu tarjeta"**.
- El trabajador **acerca su tarjeta** → aparece su **foto + nombre** en grande:
  - Fondo **verde**: *ENTRADA registrada ✓* + la hora.
  - Fondo **naranja**: *SALIDA registrada ✓* + la hora.
  - Fondo **rojo**: tarjeta no dada de alta.
- A los ~3-4 segundos vuelve solo a la pantalla de reposo.
- El sistema decide solo si es entrada o salida (alterna según el último fichaje del día).
- En reposo se ve la **hora y la fecha** grandes.

### Cuántas veces fichar según el horario

El sistema alterna entrada/salida solo, así que basta con **acercar la tarjeta en cada momento**:

- **Verano (julio y agosto)** — jornada seguida 6:00 a 14:00. Se ficha **2 veces**:
  1. Al **entrar** (6:00) → verde.
  2. Al **salir** (14:00) → naranja.
- **Resto del año (desde septiembre)** — jornada partida 7:30–13:00 y 13:30–16:00, con media
  hora para comer. Se ficha **4 veces**:
  1. Al **entrar** (7:30) → verde.
  2. Al **irse a comer** (13:00) → naranja.
  3. Al **volver de comer** (13:30) → verde.
  4. Al **salir** (16:00) → naranja.

La media hora de la comida **no cuenta** como trabajada (el sistema resta el hueco entre la
salida y la siguiente entrada). Si alguien se olvida de fichar alguna de las 4, ese día sale
marcado como **incompleto** y se arregla en *Corrección*.

---

## 6. Administrador (protegido con PIN)

Engranaje ⚙️ → PIN (por defecto **1234**). Menú:

- **Alta tarjeta**: dar de alta trabajadores y **editar** el nombre o la foto de los que ya
  existen (botón *Editar* en la lista).
- **Corrección**: NO borra ni edita el original. Añade un registro de corrección con
  **motivo** (añadir un fichaje olvidado, anular uno erróneo o cambiar la hora). Las horas
  puestas a mano por el administrador se marcan con un **\*** en los listados. Queda todo en
  el log de auditoría.
- **Horas**: horas por día y **totales** por trabajador y periodo (*Esta semana* / *Este mes*
  / rango de fechas). Los días **incompletos** (falta entrada o salida) salen en **rojo**.
- **Consulta**: ver los fichajes de un trabajador concreto.
- **Exportar**: genera el archivo (ver punto 7).
- **Integridad**: comprueba que **nadie ha manipulado** los fichajes (cadena de hashes).
- **Ajustes**: cambiar el **PIN** (cámbialo el primer día, el 1234 es solo inicial) y
  **Borrar todos los datos** (para empezar de cero con las tarjetas reales; pide confirmación
  y no se puede deshacer).

---

## 7. Exportar los datos a un USB

En **Administrador → Exportar**:

- **Exportar CSV**: crea un archivo `fichajes_AAAA-MM-DD.csv` con **todos los fichajes + el
  log de auditoría + el resumen de horas**. Se abre con Excel (usa `;` como separador).
- **Exportar PDF**: abre la vista de impresión → elige **"Guardar como PDF"**.

El archivo queda en la carpeta **Descargas** del móvil. Para pasarlo al USB:

1. Conecta el USB al móvil con un adaptador **USB-C (OTG)**.
2. Abre **Mis archivos** → **Descargas**, mantén pulsado el archivo → **Copiar/Mover** → elige el USB.

Guarda estas copias: el registro debe conservarse **4 años**.

---

## Notas de cumplimiento

- Todos los datos (nombres, fotos, fichajes) se guardan **solo en el móvil**. No se envía
  nada a internet ni a ningún servidor.
- Registro **append-only**: nunca se borra ni se edita un fichaje; las correcciones se
  añaden aparte, con motivo, fecha y hora.
- Cada fichaje lleva un **hash encadenado** con el anterior (tipo blockchain simple): si
  alguien manipula un registro, *Integridad* lo detecta.
- Haz **copias periódicas** (exporta a USB cada semana/mes). Si el móvil se pierde o se
  rompe, los datos que no estén exportados se pierden: están solo en ese teléfono.

## Probar sin tarjeta (solo para pruebas)

En el ordenador, con la app abierta, en la consola del navegador:
`simulateCard('04:aa:bb:cc')` simula acercar esa tarjeta.
