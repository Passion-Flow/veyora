# Static web client image — packages the frontend/web client.
# Build context must be the repository root so both the client sources and
# the deployment-owned nginx configuration are available:
#   docker build -f deployment/web/Dockerfile .
ARG NGINX_IMAGE=nginx:1.29.5-alpine
FROM ${NGINX_IMAGE}
COPY frontend/web/index.html /usr/share/nginx/html/
COPY frontend/web/assets/ /usr/share/nginx/html/assets/
COPY frontend/web/src/ /usr/share/nginx/html/src/
COPY frontend/web/locales/ /usr/share/nginx/html/locales/
COPY deployment/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
# Configuration is rendered from environment variables at container start and
# every variable is REQUIRED (fail fast, no defaults). VEYORA_API_BASE_URL is
# written into /veyora-config.js so the web client targets an explicit,
# operator-chosen API origin instead of guessing by port. The full documented
# set lives in .env.example.
CMD ["/bin/sh", "-c", "\
  : \"${VEYORA_WEB_LISTEN_PORT:?VEYORA_WEB_LISTEN_PORT is required}\"; \
  : \"${VEYORA_API_UPSTREAM_HOST:?VEYORA_API_UPSTREAM_HOST is required}\"; \
  : \"${VEYORA_API_UPSTREAM_PORT:?VEYORA_API_UPSTREAM_PORT is required}\"; \
  : \"${VEYORA_WEB_PROXY_TIMEOUT_SECONDS:?VEYORA_WEB_PROXY_TIMEOUT_SECONDS is required}\"; \
  : \"${VEYORA_API_BASE_URL:?VEYORA_API_BASE_URL is required (e.g. http://localhost:8080)}\"; \
  : \"${VEYORA_CSP_CONNECT_SRC:='self'}\"; \
  sed -i -e \"s/__VEYORA_WEB_LISTEN_PORT__/${VEYORA_WEB_LISTEN_PORT}/g\" \
         -e \"s/__VEYORA_API_UPSTREAM_HOST__/${VEYORA_API_UPSTREAM_HOST}/g\" \
         -e \"s/__VEYORA_API_UPSTREAM_PORT__/${VEYORA_API_UPSTREAM_PORT}/g\" \
         -e \"s/__VEYORA_WEB_PROXY_TIMEOUT_SECONDS__/${VEYORA_WEB_PROXY_TIMEOUT_SECONDS}/g\" \
         -e \"s/__VEYORA_CSP_CONNECT_SRC__/${VEYORA_CSP_CONNECT_SRC}/g\" \
         /etc/nginx/conf.d/default.conf && \
  printf 'window.VEYORA_API_BASE_URL = \"%s\";\n' \"${VEYORA_API_BASE_URL}\" \
      > /usr/share/nginx/html/veyora-config.js && \
  exec nginx -g 'daemon off;'"]
