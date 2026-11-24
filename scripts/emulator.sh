#!/usr/bin/env bash
# Starts, stops and checks the local AWS Emulator container for this console.
#   ./scripts/emulator.sh start | stop | status | env
# Publishes the port on 127.0.0.1 only, turns telemetry off and caps memory at 2 GB.
# Emulated state lives in memory: stopping the container wipes it.
set -euo pipefail

NAME="aws-emulator"
IMAGE="aws-emulator"
PORT="${EMULATOR_PORT:-9297}"
if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "EMULATOR_PORT must be a port number, got: $PORT" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$HOME/.aws/emulator"
FILES="$DATA/$PORT"

need_docker() {
  command -v docker >/dev/null 2>&1 || { echo "Docker is not installed or not on PATH." >&2; exit 1; }
}

running() {
  [[ "$(docker ps --filter "name=^${NAME}$" --format '{{.Names}}')" == "$NAME" ]]
}

wait_for_files() {
  for _ in $(seq 1 60); do
    [[ -s "$FILES/ca.pem" && -s "$FILES/emulator_credentials" ]] && return 0
    sleep 1
  done
  echo "The emulator did not write $FILES/ca.pem within 60 s. Check: docker logs $NAME" >&2
  exit 1
}

start() {
  need_docker
  if running; then
    echo "$NAME is already running on https://127.0.0.1:$PORT"
    return 0
  fi
  if [[ -n "$(docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}')" ]]; then
    docker start "$NAME" >/dev/null
  else
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "Building image $IMAGE from docker/Dockerfile.emulator ..."
      docker build -t "$IMAGE" -f "$ROOT/docker/Dockerfile.emulator" "$ROOT/docker"
    fi
    mkdir -p "$DATA"
    # HOME and the mount use the same path as on this Mac, so the config the emulator
    # writes (ca_bundle = ...) points at a file that exists here too.
    docker run -d --name "$NAME" \
      -p "127.0.0.1:$PORT:$PORT" \
      --memory 2g --memory-swap 2g \
      -e HOME="$HOME" -v "$DATA:$DATA" \
      "$IMAGE" -p "$PORT" --telemetry off >/dev/null
  fi
  wait_for_files
  echo "$NAME is running on https://127.0.0.1:$PORT (files in $FILES)"
}

stop() {
  need_docker
  if running; then
    docker stop "$NAME" >/dev/null
    echo "$NAME stopped. Its emulated resources are gone."
  else
    echo "$NAME is not running."
  fi
}

status() {
  need_docker
  if running; then
    docker ps --filter "name=^${NAME}$" --format '{{.Names}}  {{.Status}}  {{.Ports}}'
  else
    echo "$NAME is not running. Start it with: $0 start"
    exit 1
  fi
}

print_env() {
  cat <<ENV
export AWS_ENDPOINT_URL=https://127.0.0.1:$PORT
export AWS_SHARED_CREDENTIALS_FILE=$FILES/emulator_credentials
export AWS_CONFIG_FILE=$FILES/config
export AWS_CA_BUNDLE=$FILES/ca.pem
export AWS_EC2_METADATA_DISABLED=true
export AWS_DISABLE_HOST_PREFIX_INJECTION=true
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
unset AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
ENV
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  env) print_env ;;
  *) echo "Usage: $0 start|stop|status|env   (use: eval \"\$($0 env)\")" >&2; exit 2 ;;
esac
