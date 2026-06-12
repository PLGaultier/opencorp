# Sandbox rootfs (§8): the filesystem every Firecracker microVM boots.
# Built as a container, then exported to an ext4 image by build.sh.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep socat unzip xz-utils \
      python3.12 python3.12-venv \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2t64 \
    && rm -rf /var/lib/apt/lists/*

# Bun (runs agentd), Node 22 + pnpm, uv (python).
RUN curl -fsSL https://bun.sh/install | bash && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && \
    npm i -g pnpm && \
    curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.bun/bin:/root/.local/bin:${PATH}"

# The agentd bundle + the vsock bridge that fronts it.
WORKDIR /opt/agentd
COPY agentd/ /opt/agentd/
COPY agentd-vsock.sh /usr/local/bin/agentd-vsock
RUN chmod +x /usr/local/bin/agentd-vsock && \
    bunx playwright install chromium

ENV VSOCK_PORT=5252
# init: bring up the vsock→agentd bridge as PID 1's child.
CMD ["/usr/local/bin/agentd-vsock"]
