# syntax=docker/dockerfile:1

# Run the Go toolchain on the Docker builder's native architecture and
# cross-compile the static binary for Cloudflare's target architecture. This
# avoids running the Go assembler under CPU emulation on Apple Silicon.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -tags osusergo,netgo -o /server

FROM --platform=$TARGETPLATFORM alpine
COPY --from=build /server /server
EXPOSE 8080

CMD ["/server", "8080"]
