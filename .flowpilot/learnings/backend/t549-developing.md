### t549 (developing, unverified)

- AT8 as written probes GET /v1/health, but that route is 404 (route not found). The health route is GET /health, which answered {"status":"ok","db":"ok"}. Docker check run: `docker build` OK, `docker image inspect` shows Cmd [cartografo --no-runner] and ExposedPorts only 4317/tcp, the mapped 4318 answered nothing, and `docker compose config --services` lists only control-plane. Passing -p for 4318 to `docker run` makes `docker inspect <container>` list 4318 as exposed, so check the image, not the container.
