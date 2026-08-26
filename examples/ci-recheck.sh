#!/usr/bin/env bash
# CI recheck client (J7). Calls run_evals with intent recheck, polls get_eval_report,
# exits with ci_exit. Does not call recommend_models. Does not write app config.
set -euo pipefail

EVALROUTER_URL="${EVALROUTER_URL:-http://127.0.0.1:3000}"
EVALROUTER_API_KEY="${EVALROUTER_API_KEY:?set EVALROUTER_API_KEY}"
PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
EVAL_SET_ID="${EVAL_SET_ID:?set EVAL_SET_ID}"
REC_ID="${REC_ID:?set REC_ID}"
MODEL_ID="${MODEL_ID:?set MODEL_ID}"
KEYS_REF="${KEYS_REF:?set KEYS_REF}"
MAX_EVAL_SPEND_USD="${MAX_EVAL_SPEND_USD:?set MAX_EVAL_SPEND_USD}"
POLL_TIMEOUT_S="${POLL_TIMEOUT_S:-600}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-2}"

auth_header="Authorization: Bearer ${EVALROUTER_API_KEY}"
json_header="Content-Type: application/json"
idem_key="ci-recheck-$(date +%s)-$$"

run_body=$(cat <<EOF
{
  "project_id": "${PROJECT_ID}",
  "eval_set_id": "${EVAL_SET_ID}",
  "max_eval_spend_usd": ${MAX_EVAL_SPEND_USD},
  "keys_ref": "${KEYS_REF}",
  "intent": "recheck",
  "named_model": { "rec_id": "${REC_ID}", "model_id": "${MODEL_ID}" },
  "idempotency_key": "${idem_key}"
}
EOF
)

run_resp=$(curl -sf -X POST "${EVALROUTER_URL}/v1/tools/run_evals" \
  -H "${auth_header}" -H "${json_header}" -d "${run_body}")
run_id=$(printf '%s' "${run_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).run_id)})')

deadline=$(( $(date +%s) + POLL_TIMEOUT_S ))
report=''
ci_exit=1

while [ "$(date +%s)" -lt "${deadline}" ]; do
  report_body=$(cat <<EOF
{"project_id":"${PROJECT_ID}","run_id":"${run_id}"}
EOF
)
  report=$(curl -sf -X POST "${EVALROUTER_URL}/v1/tools/get_eval_report" \
    -H "${auth_header}" -H "${json_header}" -d "${report_body}")
  status=$(printf '%s' "${report}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).status)})')
  if [ "${status}" = "succeeded" ] || [ "${status}" = "partial" ] || [ "${status}" = "failed" ]; then
    ci_exit=$(printf '%s' "${report}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{console.log(JSON.parse(d).ci_exit)})')
    break
  fi
  sleep "${POLL_INTERVAL_S}"
done

if [ -z "${report}" ]; then
  echo "recheck timed out waiting for run ${run_id}" >&2
  exit 1
fi

if [ "${status}" = "queued" ] || [ "${status}" = "running" ]; then
  echo "recheck timed out while status=${status} run_id=${run_id}" >&2
  exit 1
fi

printf '%s\n' "${report}"
exit "${ci_exit}"
