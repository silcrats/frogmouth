FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js config.yaml ./
COPY lib ./lib
COPY public ./public

ENV PORT=3000
# Also stops Express putting stack traces in error responses.
ENV NODE_ENV=production
# @marsaud/smb2 needs MD4 for NTLM auth, which Node's OpenSSL 3
# disables by default -- without this, any SMB download crashes the process.
ENV NODE_OPTIONS=--openssl-legacy-provider
EXPOSE 3000

# Collections database (config.yaml collections:). Created here so a new
# volume mounted on it comes up owned by the node user.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "server.js"]
