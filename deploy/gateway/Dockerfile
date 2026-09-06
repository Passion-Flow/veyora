ARG ENVOY_IMAGE=envoyproxy/envoy:v1.31.10
FROM ${ENVOY_IMAGE}
COPY deploy/gateway/envoy.yaml /etc/envoy/envoy-tls.yaml
COPY deploy/gateway/envoy-plain.yaml /etc/envoy/envoy-plain.yaml
COPY deploy/gateway/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# DEP-006: run as the image's unprivileged envoy user; the entrypoint renders
# its configuration into the ephemeral /tmp mount and envoy binds only
# unprivileged ports (8080/8443 plus the loopback admin port).
USER envoy
EXPOSE 8080 8443
ENTRYPOINT ["/entrypoint.sh"]
