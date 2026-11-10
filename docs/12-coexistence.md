# Conexión de WhatsApp por coexistence (PAVP-4)

Permite que un negocio conecte su número **sin dejar de usar la app WhatsApp Business del celular**: Proshop atiende por la API y el dueño puede seguir contestando desde el teléfono. Todo el código está listo y probado con Meta simulada; **falta cargar los datos de la app de Meta y probar con un número real**.

## Qué hace el sistema (ya construido)

1. **Pantalla** (`/panel/whatsapp`): tarjeta "Conectar tu WhatsApp Business" con el botón "Conectar con Meta". Si faltan variables, lo dice y deja la conexión manual de siempre.
2. **Navegador** (`public/js/whatsapp-coexistence.js`): carga el SDK de Meta y abre Embedded Signup con `featureType: 'whatsapp_business_app_onboarding'`. Recibe el `code` y el evento `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (con el id de la cuenta de WhatsApp Business) y se los manda al servidor.
3. **Servidor** (`lib/services/metaCoexistence.js › conectar`), en este orden: canjea el `code` por el token → lista los números de la cuenta → elige el número → verifica que no esté en otra cuenta de Proshop → **suscribe nuestra app a la cuenta** (`POST /{waba}/subscribed_apps`) → **pide la sincronización** de contactos (`smb_app_state_sync`) e historial (`history`) con `POST /{phone}/smb_app_data` (una sola vez, dentro de las 24 h) → guarda el número con el token **cifrado**. Es idempotente: repetirla no vuelve a pedir la sincronización.
4. **Webhook**: lo que el dueño escribe desde el celular llega como `smb_message_echoes`: se guarda como mensaje del equipo ("App de WhatsApp"), y el chat pasa a manos de una persona (la IA deja de contestarle encima; se devuelve con "Devolver al agente"). Los reenvíos de Meta no duplican y un eco igual a lo que el agente acaba de mandar por la API se ignora. `smb_app_state_sync` e `history` por ahora solo dejan constancia en el log.
5. **Seguridad**: en conexiones por coexistence se exige la firma `X-Hub-Signature-256` del webhook (con `META_APP_SECRET`). Las conexiones manuales siguen como antes (usan la app de cada cliente, otro secreto).
6. Se guarda en `conexiones_whatsapp`: `modo` (MANUAL | COEXISTENCE), `estadoSync` y `conectadoAt`. Queda en la auditoría ("WhatsApp conectado").

## Lo que tenés que hacer vos (Meta)

1. En **developers.facebook.com** tené una app de tipo *Business* con el producto **WhatsApp** y ser **Tech Provider** (o estar en el proceso): coexistence se ofrece por Embedded Signup.
2. Creá la **configuración de Embedded Signup** (Facebook Login for Business) con el producto WhatsApp Embedded Signup y los permisos `whatsapp_business_management` y `whatsapp_business_messaging`. Anotá su **ID de configuración**.
3. En la app, **Webhooks → WhatsApp Business Account**: callback `https://agentes.proshop.lat/webhooks/whatsapp`, token de verificación = `WHATSAPP_VERIFY_TOKEN` del servidor, y **suscribí estos campos**: `messages`, `smb_message_echoes`, `smb_app_state_sync`, `history`.
4. Agregá `agentes.proshop.lat` a los dominios permitidos de la app (Login → Settings: *Allowed domains* / *Valid OAuth redirect URIs*).
5. Cargá en el servidor (Coolify) y redesplegá:

```
META_APP_ID=…                       # ID de la app
META_APP_SECRET=…                   # secreto de la app (no se expone al navegador)
META_EMBEDDED_SIGNUP_CONFIG_ID=…    # ID de la configuración de Embedded Signup
```

## Requisitos de Meta para el cliente (avisarle)

- El número tiene que estar **en uso en la app WhatsApp Business** (no la común); algunos proveedores piden 7 días de uso activo.
- Meta puede no ofrecer coexistence en todos los países; con Bolivia hay que confirmarlo en la primera prueba.
- La sincronización de contactos e historial se pide **una sola vez y dentro de las 24 h** de conectar.
- Para desconectar un número en coexistence se hace desde los ajustes de la app del celular (la API de baja no sirve para estos números).

## A VERIFICAR en la primera conexión real (no se pudo probar sin credenciales)

- Que el evento de fin traiga `waba_id` (y si trae o no `phone_number_id`): el código funciona en ambos casos.
- Que la ruta `POST /{phone_number_id}/smb_app_data` con `sync_type` = `smb_app_state_sync` / `history` sea la vigente en la versión de Graph usada (`WHATSAPP_GRAPH_VERSION`, hoy v21.0).
- Si Meta devuelve como "eco" también lo que manda el agente por la API (el código ya lo ignora, pero conviene verlo).
- Qué payload exacto traen `smb_app_state_sync` y `history` (hoy solo se registran en el log) para decidir si se importan los contactos y el historial al panel.
- Si el token que devuelve el canje es de larga duración o necesita renovarse.

Referencias: documentación de Meta "Onboard WhatsApp Business app users" (developers.facebook.com › WhatsApp › Embedded Signup) y las guías de coexistence de proveedores (360dialog, Gupshup, Telnyx).
