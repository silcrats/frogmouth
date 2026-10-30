FROM node:22-alpine

# smbget, for SMB downloads.
RUN apk add --no-cache samba-client

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js config.yaml ./
COPY lib ./lib
COPY public ./public

ENV PORT=3000
# Also stops Express putting stack traces in error responses.
ENV NODE_ENV=production
EXPOSE 3000

# Collections database (config.yaml collections:). Created here so a new
# volume mounted on it comes up owned by the node user.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "server.js"]
