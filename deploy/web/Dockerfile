# Static web client image — packages the apps/web client.
# Build context must be the repository root so both the client sources and
# the deployment-owned nginx configuration are available:
#   docker build -f deploy/web/Dockerfile .
ARG NGINX_IMAGE=nginx:1.29.5-alpine
# Build identity stamped into the served config so Diagnostics can show it
# (DIAG-001). CI passes the commit; local builds default to 'unknown' and
# the client displays an honest not-stamped label instead of guessing.
ARG VEYORA_BUILD_COMMIT=unknown
FROM ${NGINX_IMAGE}
COPY apps/web/index.html /usr/share/nginx/html/
COPY apps/web/sw.js /usr/share/nginx/html/
COPY apps/web/manifest.json /usr/share/nginx/html/
COPY apps/web/assets/ /usr/share/nginx/html/assets/
COPY apps/web/src/ /usr/share/nginx/html/src/
COPY apps/web/locales/ /usr/share/nginx/html/locales/
# The server config is staged as a read-only template; container start
# renders it into the tmpfs-mounted /etc/nginx/conf.d (empty in the image)
# so the root filesystem can stay read-only (DEP-006).
COPY deploy/web/nginx.conf /etc/nginx/template/default.conf
EXPOSE 80
# Configuration is rendered from environment variables at container start and
# every variable is REQUIRED (fail fast, no defaults). VEYORA_API_BASE_URL is
# written into /veyora-config.js (served from the /tmp mount) so the web
# client targets an explicit, operator-chosen API origin instead of guessing
# by port. The full documented set lives in deploy/compose/.env.example.
CMD ["/bin/sh", "-c", "\
  : \"${VEYORA_WEB_LISTEN_PORT:?VEYORA_WEB_LISTEN_PORT is required}\"; \
  : \"${VEYORA_API_UPSTREAM_HOST:?VEYORA_API_UPSTREAM_HOST is required}\"; \
  : \"${VEYORA_API_UPSTREAM_PORT:?VEYORA_API_UPSTREAM_PORT is required}\"; \
  : \"${VEYORA_WEB_PROXY_TIMEOUT_SECONDS:?VEYORA_WEB_PROXY_TIMEOUT_SECONDS is required}\"; \
  : \"${VEYORA_API_BASE_URL:?VEYORA_API_BASE_URL is required (e.g. http://localhost:8080)}\"; \
  : \"${VEYORA_CSP_CONNECT_SRC:='self'}\"; \
  sed -e \"s/__VEYORA_WEB_LISTEN_PORT__/${VEYORA_WEB_LISTEN_PORT}/g\" \
      -e \"s/__VEYORA_API_UPSTREAM_HOST__/${VEYORA_API_UPSTREAM_HOST}/g\" \
      -e \"s/__VEYORA_API_UPSTREAM_PORT__/${VEYORA_API_UPSTREAM_PORT}/g\" \
      -e \"s/__VEYORA_WEB_PROXY_TIMEOUT_SECONDS__/${VEYORA_WEB_PROXY_TIMEOUT_SECONDS}/g\" \
      -e \"s/__VEYORA_CSP_CONNECT_SRC__/${VEYORA_CSP_CONNECT_SRC}/g\" \
      /etc/nginx/template/default.conf > /etc/nginx/conf.d/default.conf && \
  printf 'window.VEYORA_API_BASE_URL = \"%s\";\nwindow.VEYORA_BUILD_COMMIT = \"%s\";\n' \
      \"${VEYORA_API_BASE_URL}\" \"${VEYORA_BUILD_COMMIT:-unknown}\" \
      > /tmp/veyora-config.js && \
  exec nginx -g 'daemon off;'"]
