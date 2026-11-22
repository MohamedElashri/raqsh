FROM ubuntu:24.04
COPY ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       at-spi2-core dbus-x11 desktop-file-utils fonts-dejavu-core fonts-noto-core \
       libgl1-mesa-dri libgtk-3-0t64 libwebkit2gtk-4.1-0 mutter python3 python3-gi \
       webkit2gtk-driver x11-utils xauth xclip xvfb \
    && useradd -m desktop-test \
    && rm -rf /var/lib/apt/lists/*
