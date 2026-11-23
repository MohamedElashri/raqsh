#!/bin/sh
set -eu

cd -- "$(dirname -- "$0")/.."
nida check site
nida build site "$@"
install -m 644 install.sh site/public/install.sh
