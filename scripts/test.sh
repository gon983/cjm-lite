#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker run --rm -v "$PWD:/src" -w /src -v cjm-go-cache:/go/pkg -v cjm-build-cache:/root/.cache/go-build golang:1.25-bookworm sh -c 'go test -race ./... && go vet ./...'
