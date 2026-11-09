# Punto de venta: impresora térmica y lector de códigos de barras

Cómo dejar el mostrador funcionando. No hace falta instalar nada en el servidor: todo se resuelve en el navegador del mostrador.

## Lector de códigos de barras (USB o Bluetooth)

- Cualquier lector que se comporte como **teclado** sirve (casi todos): al escanear escribe el código y manda **Enter**.
- En el punto de venta el buscador siempre está enfocado: **escaneá y listo**, el producto entra al carrito. No hay que configurar nada en Proshop.
- Si el lector no manda Enter solo, configurá en el lector el sufijo "Enter" (el manual trae el código de barras de configuración).
- Cada producto (o cada talla/color) puede tener su **código de barras** en la ficha del producto. También se encuentra por **SKU exacto**. Un código no se puede repetir dentro del negocio.
- Si se escanea un producto que tiene tallas/colores y el código es el del producto (no el de una talla), se abre la lista para elegir la opción.
- **Cámara del celular o tablet**: si el navegador lo soporta (Chrome en Android), aparece un botón 📷 para escanear con la cámara.
- Atajos: **F2** enfoca el buscador, **F4** cobra, **Esc** cierra, **Enter** en "Venta cobrada" empieza otra.

## Impresora térmica de 80 mm

El recibo (`/recibo/…`) está maquetado para **ticket de 80 mm** (y también para hoja A4, con el botón "Hoja A4"). Se imprime con el diálogo normal del navegador, así que sirve cualquier impresora térmica con **driver instalado** en la computadora del mostrador (Epson TM, Xprinter, etc.).

1. Instalá el driver de la impresora y dejala como **impresora predeterminada** de Windows.
2. En el diálogo de impresión de Chrome elegí: **Más ajustes → Márgenes: ninguno** y **Escala: 100 %** (el recibo ya fija el tamaño de página en 80 mm).
3. Marcá en el punto de venta **"Imprimir el recibo al cobrar"** (se recuerda en ese equipo).

### Imprimir sin que pregunte (recomendado para el mostrador)

Chrome pregunta cada vez, salvo que se abra en modo de impresión silenciosa. Creá un acceso directo del navegador con:

```
chrome.exe --kiosk-printing --app=https://TU-DOMINIO/panel/pos
```

Así al cobrar el ticket sale **directo a la impresora predeterminada**, sin diálogo.

### Reimprimir

En **Ventas → (la venta) → Reimprimir** se vuelve a imprimir el mismo recibo, también el de una venta anulada (sale con la marca "ANULADA").

## Lo que NO hace (a propósito)

- **No es una factura**: el recibo dice "Nota de venta. No es una factura". La facturación fiscal queda fuera.
- **No abre el cajón de dinero** por la impresora (hay cajones que lo hacen con un pulso ESC/POS). Si lo necesitan, se agrega aparte.
- La impresión directa por USB sin driver (WebUSB / ESC-POS crudo) no está incluida: con el driver instalado funciona sin vueltas.

## Antes de venderlo: probarlo con la impresora real

El recibo y la impresión silenciosa se probaron en el navegador, no con una impresora física. Antes de entregarlo a un cliente hay que probar **un ticket real** en su impresora (ancho, corte y márgenes cambian de un modelo a otro).
