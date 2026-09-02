FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY LICENSE README.md CHANGELOG.md ./

EXPOSE 8080

ENTRYPOINT ["node", "/app/bin/proxyboi.js"]
