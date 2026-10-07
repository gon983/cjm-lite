FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=1 go build -trimpath -ldflags='-s -w' -o /app ./cmd/app
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/* && useradd -u 10001 -m app && mkdir /data && chown app:app /data
COPY --from=build /app /app
USER app
ENV DATA_DIR=/data PORT=8080 TZ=America/Argentina/Cordoba
EXPOSE 8080
ENTRYPOINT ["/app"]
CMD ["serve"]
