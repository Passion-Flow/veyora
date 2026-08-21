ARG ENVOY_IMAGE=envoyproxy/envoy:v1.31.10
FROM ${ENVOY_IMAGE}
COPY docker/gateway/envoy.yaml /etc/envoy/envoy-tls.yaml
COPY docker/gateway/envoy-plain.yaml /etc/envoy/envoy-plain.yaml
COPY docker/gateway/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080 8443
ENTRYPOINT ["/entrypoint.sh"]
