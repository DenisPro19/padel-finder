FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production
# PADEL_PASSPHRASE must be supplied by the host as a secret, never baked in.
EXPOSE 8123
CMD ["node", "server.js", "--no-open"]
