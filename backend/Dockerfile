FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Everything, not a list.
#
# This used to name eight files. Every backend module written after that line was added -- eleven of
# them by 2026-09-05, including passwordHash.js and sessionSecret.js -- was simply absent from the
# image, and the container died on its first `require` with MODULE_NOT_FOUND. Railway saw the health
# check fail, kept the previous image, and reported the *deployment* as successful, because the build
# had in fact succeeded.
#
# The shop's cloud sat on code from 2026-07-12 for nearly two months because of this. Every release
# in between appeared to deploy and none of it ever ran. It surfaced only as things that "should
# work" not working, most of a day was spent looking for the reason in the app, and the answer was
# eight filenames in a Dockerfile that nobody had reason to look at.
#
# A copy list that has to be updated by hand is a deployment that breaks silently every time someone
# splits a file out -- which is exactly what a large `server.js` invites people to do.
# `.dockerignore` decides what stays out; adding a module is not a deployment decision.
COPY --chown=node:node . ./
RUN mkdir -p /app/backups && chown -R node:node /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["npm", "start"]
