FROM node:22-alpine

WORKDIR /app

COPY package.json crypto.ts handler.ts server.ts ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

CMD ["node", "--experimental-strip-types", "server.ts"]
