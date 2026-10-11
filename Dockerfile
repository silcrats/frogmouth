FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js config.yaml ./
COPY lib ./lib
COPY public ./public

ENV PORT=3000
# @marsaud/smb2 needs MD4 for NTLM auth, which Node 20's OpenSSL 3
# disables by default -- without this, any SMB download crashes the process.
ENV NODE_OPTIONS=--openssl-legacy-provider
EXPOSE 3000

CMD ["node", "server.js"]
