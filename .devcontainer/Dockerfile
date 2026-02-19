FROM debian:13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
        ca-certificates \
        build-essential \
        pkg-config \
        libssl-dev \
        libsqlite3-dev

# Install mise
RUN curl https://mise.run | sh
ENV PATH="/root/.local/bin:${PATH}"

# Activate mise
RUN echo 'eval "$(mise activate bash)"' >> ~/.bashrc

# Pre-install tools defined in mise.toml so they're cached in the image
COPY mise.toml mise.lock /tmp/mise/
RUN cd /tmp/mise && mise trust && mise install -y && rm -rf /tmp/mise

# Install amp
RUN curl -fsSL https://ampcode.com/install.sh | bash

CMD /bin/bash
