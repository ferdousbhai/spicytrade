#!/usr/bin/env bash

# Cloudflare Worker names are limited to 63 characters. Prefixes remain explicit
# at each product entrypoint; the timestamp and random suffix prevent one owner's
# manual run from colliding with another concurrent run at the same entrypoint.
readonly TEMPORARY_WORKER_MAX_NAME_LENGTH=63

# Cloudflare's control plane returns transient 5xx on deploys, which can otherwise
# abort a bootstrap run partway through paging the full instrument catalog and cost
# the work already done in that run. Three attempts ten seconds apart bound the added
# delay to ~20s — negligible against a run that already takes minutes — while covering
# a blip that clears in seconds. Deletion in temporary_worker_stop stays unretried on
# purpose: an orphaned Worker must be reported, never hidden behind repeated cleanup.
temporary_worker_api_attempts="${TEMPORARY_WORKER_API_ATTEMPTS:-3}"
temporary_worker_retry_delay_seconds="${TEMPORARY_WORKER_RETRY_DELAY_SECONDS:-10}"

temporary_worker_deployed='false'
temporary_worker_name_value=''
temporary_worker_log=''
temporary_worker_secret=''
temporary_worker_secrets_file=''
temporary_worker_url=''

temporary_worker_name() {
  local prefix="$1"
  local stamp suffix candidate
  stamp="$(date -u +%Y%m%dt%H%M%Sz)"
  suffix="$(openssl rand -hex 4)"
  candidate="${prefix}-${stamp}-${suffix}"
  if (( ${#candidate} > TEMPORARY_WORKER_MAX_NAME_LENGTH )); then
    echo "Temporary Worker name exceeds Cloudflare's ${TEMPORARY_WORKER_MAX_NAME_LENGTH}-character limit: $candidate" >&2
    return 1
  fi
  if [[ ! "$candidate" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; then
    echo "Invalid temporary Worker name: $candidate" >&2
    return 1
  fi
  printf '%s\n' "$candidate"
}

temporary_worker_release_local_files() {
  [[ -z "$temporary_worker_log" ]] || rm -f "$temporary_worker_log"
  [[ -z "$temporary_worker_secret" ]] || rm -f "$temporary_worker_secret"
  [[ -z "$temporary_worker_secrets_file" ]] || rm -f "$temporary_worker_secrets_file"
  temporary_worker_log=''
  temporary_worker_secret=''
  temporary_worker_secrets_file=''
  temporary_worker_url=''
}

# Runs one `cf` step into the shared log, retrying the transport. `mode` is truncate
# for the deploy and append for later steps that must not erase it; the URL reader
# parses the log once the Worker's details are in it. Any redirection a step needs belongs inside the step's
# own function so each attempt re-opens it: a redirect applied here would leave the
# second attempt reading an exhausted descriptor.
temporary_worker_api_retry() {
  local mode="$1"
  local description="$2"
  shift 2
  local attempt=1
  while true; do
    if [[ "$mode" == 'truncate' ]]; then
      if "$@" >"$temporary_worker_log" 2>&1; then return 0; fi
    else
      if "$@" >>"$temporary_worker_log" 2>&1; then return 0; fi
    fi
    if (( attempt >= temporary_worker_api_attempts )); then
      cat "$temporary_worker_log" >&2
      echo "$description failed after $attempt attempts: $temporary_worker_name_value" >&2
      return 1
    fi
    echo "$description attempt $attempt failed; retrying in ${temporary_worker_retry_delay_seconds}s" >&2
    attempt=$(( attempt + 1 ))
    sleep "$temporary_worker_retry_delay_seconds"
  done
}

# A freshly created workers.dev script is not routable the instant its deploy returns:
# the first request can answer with Cloudflare error 1104 (Script not found) for a few
# seconds, which aborted an earlier run after its work had already been done.
# The ops handler answers every unauthenticated request with a plain-text 404 precisely so
# these endpoints stay undiscoverable, so an HTML body is the edge saying the script is not
# there yet rather than the Worker refusing the caller.
temporary_worker_wait_until_routable() {
  local attempt=1 probe status content_type
  while true; do
    probe="$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "$temporary_worker_url" || echo '000 none')"
    status="${probe%% *}"
    content_type="${probe#* }"
    if [[ "$status" != '000' && "$content_type" != text/html* ]]; then return 0; fi
    if (( attempt >= temporary_worker_api_attempts )); then
      echo "Temporary Worker never became routable: $temporary_worker_name_value" >&2
      return 1
    fi
    echo "Temporary Worker not routable yet; retrying in ${temporary_worker_retry_delay_seconds}s" >&2
    attempt=$(( attempt + 1 ))
    sleep "$temporary_worker_retry_delay_seconds"
  done
}

# `cf deploy` reads `cloudflare.config.ts` from the directory it runs in, so each ops
# Worker keeps its config in its own folder and takes this run's name from the
# environment. The token travels with the version (`--secrets-file`), so the Worker is
# never live without it.
temporary_worker_deploy_step() {
  (cd "$1" && SPICE_OPS_WORKER_NAME="$2" npx cf deploy --secrets-file "$temporary_worker_secrets_file")
}

temporary_worker_start() {
  local worker_name="$1"
  local config_dir="$2"
  if [[ "$temporary_worker_deployed" == 'true' ]]; then
    echo "Temporary Worker is already deployed: $temporary_worker_name_value" >&2
    return 1
  fi

  temporary_worker_name_value="$worker_name"
  temporary_worker_log="$(mktemp)"
  temporary_worker_secret="$(mktemp)"
  chmod 600 "$temporary_worker_secret"
  openssl rand -hex 32 >"$temporary_worker_secret"
  temporary_worker_secrets_file="$(mktemp)"
  chmod 600 "$temporary_worker_secrets_file"
  printf 'OPS_AUTH_TOKEN=%s\n' "$(cat "$temporary_worker_secret")" >"$temporary_worker_secrets_file"

  if ! temporary_worker_api_retry truncate 'Temporary Worker deploy' \
    temporary_worker_deploy_step "$config_dir" "$worker_name"; then
    return 1
  fi
  temporary_worker_deployed='true'

  if ! temporary_worker_api_retry append 'Temporary Worker lookup' \
    npx cf workers get "$worker_name"; then
    return 1
  fi

  if ! temporary_worker_url="$(node ops/shared/temporary-worker-url.mjs "$temporary_worker_log" "$worker_name")"; then
    cat "$temporary_worker_log" >&2
    return 1
  fi
  temporary_worker_wait_until_routable
}

temporary_worker_call() {
  local endpoint="$1"
  if [[ "$temporary_worker_deployed" != 'true'
    || -z "$temporary_worker_secret"
    || -z "$temporary_worker_url" ]]; then
    echo 'Temporary Worker is not ready.' >&2
    return 1
  fi
  node ops/shared/call-worker.mjs "$temporary_worker_secret" "$temporary_worker_url" "$endpoint"
}

temporary_worker_stop() {
  local delete_output=''
  local delete_status=0
  if [[ "$temporary_worker_deployed" == 'true' ]]; then
    if ! delete_output="$(npx cf workers delete "$temporary_worker_name_value" --force 2>&1)"; then
      echo "Failed to delete temporary Worker: $temporary_worker_name_value" >&2
      printf '%s\n' "$delete_output" >&2
      delete_status=1
    fi
  fi
  # Do not hide a failed deletion behind repeated cleanup attempts. The exact
  # orphan name was emitted above so an owner can remove it deliberately.
  temporary_worker_deployed='false'
  temporary_worker_release_local_files
  return "$delete_status"
}

temporary_worker_cleanup_on_exit() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  temporary_worker_stop || cleanup_status=$?
  if (( original_status != 0 )); then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}
