FROM node:20-alpine

WORKDIR /app

# Fuentes del sistema. La imagen de alpine viene SIN ninguna, y sharp (que usa
# librsvg para rasterizar SVG) necesita al menos una para dibujar texto: sin
# esto no falla, dibuja cuadraditos vacios. Se noto en las fotos generadas por
# scripts/seed-catalogo-demo.js, que llegaron al chat del cliente con el nombre
# del producto en ▯▯▯.
RUN apk add --no-cache ttf-dejavu fontconfig && fc-cache -f

# npm ci respeta package-lock.json: dos deploys del mismo commit instalan
# exactamente las mismas versiones (npm install podia traer versiones nuevas).
#
# NO usar --omit=dev: el CLI de Prisma vive en devDependencies y hace falta en
# tiempo de EJECUCION, no solo al construir (el CMD de abajo corre
# "npx prisma migrate deploy" en cada arranque). Sin el instalado, npx intenta
# descargarlo de internet en cada boot: lento y, si la descarga falla, el
# contenedor nunca llega a escuchar y el proxy devuelve 502 Bad Gateway.
COPY package*.json ./
RUN npm ci || npm install

COPY . .

RUN npx prisma generate

EXPOSE 3000

ENV NODE_ENV=production

# Las fotos de producto que suben los clientes se guardan en disco, no en la
# base. Sin un volumen persistente montado ACA, cada redeploy levanta un
# contenedor nuevo y se pierden todas: el bot queda mandando URLs rotas.
# En Coolify hay que mapear un volumen a /app/public/uploads (Storages ->
# Add -> Volume Mount). Esta linea declara la intencion y evita que el dato
# quede solo en la capa de escritura de la imagen.
VOLUME ["/app/public/uploads"]

CMD ["sh", "-c", "npx prisma migrate deploy && npm run seed && npm start"]
