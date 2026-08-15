#!/usr/bin/env bash
set -e

TEST_RUN_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-test.XXXXXXXX")"
readonly TEST_RUN_ROOT

cleanup() {
    local status=$?
    trap - EXIT HUP INT TERM
    if [[ -n "$TEST_RUN_ROOT" && -d "$TEST_RUN_ROOT" && "${TEST_RUN_ROOT##*/}" == pi-test.* ]]; then
        if ! rm -rf -- "$TEST_RUN_ROOT"; then
            echo "Failed to remove isolated test state: $TEST_RUN_ROOT" >&2
            if [[ $status -eq 0 ]]; then
                status=1
            fi
        fi
    else
        echo "Refusing to remove unexpected test state path: $TEST_RUN_ROOT" >&2
        if [[ $status -eq 0 ]]; then
            status=1
        fi
    fi
    return "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export HOME="$TEST_RUN_ROOT/home"
export PI_ADAPTATIVE_CODING_AGENT_DIR="$TEST_RUN_ROOT/agent"
export PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR="$TEST_RUN_ROOT/sessions"
export TMPDIR="$TEST_RUN_ROOT/tmp"
export TMP="$TEST_RUN_ROOT/tmp"
export TEMP="$TEST_RUN_ROOT/tmp"
export XDG_CONFIG_HOME="$TEST_RUN_ROOT/xdg/config"
export XDG_CACHE_HOME="$TEST_RUN_ROOT/xdg/cache"
export XDG_DATA_HOME="$TEST_RUN_ROOT/xdg/data"
mkdir -p \
    "$HOME" \
    "$PI_ADAPTATIVE_CODING_AGENT_DIR" \
    "$PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR" \
    "$TMPDIR" \
    "$XDG_CONFIG_HOME" \
    "$XDG_CACHE_HOME" \
    "$XDG_DATA_HOME"

if [[ "${OS:-}" == "Windows_NT" ]]; then
    export USERPROFILE="$HOME"
    export APPDATA="$HOME/AppData/Roaming"
    export LOCALAPPDATA="$HOME/AppData/Local"
    mkdir -p "$APPDATA" "$LOCALAPPDATA"
fi

# Skip local LLM tests (ollama, lmstudio)
export PI_NO_LOCAL_LLM=1

# Unset API keys (see packages/ai/src/stream.ts getEnvApiKey)
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset ANTHROPIC_AUTH_TOKEN
unset OPENAI_API_KEY
unset AZURE_OPENAI_API_KEY
unset DEEPSEEK_API_KEY
unset GEMINI_API_KEY
unset GOOGLE_CLOUD_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset MOONSHOT_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset FIREWORKS_API_KEY
unset TOGETHER_API_KEY
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_GATEWAY_ID
unset XIAOMI_API_KEY
unset XIAOMI_TOKEN_PLAN_CN_API_KEY
unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
unset QWEN_TOKEN_PLAN_API_KEY
unset QWEN_TOKEN_PLAN_CN_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_BEDROCK_SKIP_AUTH
unset AWS_ENDPOINT_URL_BEDROCK_RUNTIME
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset BEDROCK_EXTENSIVE_MODEL_TEST
unset SAKANA_API_KEY
unset FUGU_API_KEY
unset FUGU_BASE_URL
unset PI_RUN_SCRATCH
unset PI_LOCAL_MODEL_BENCH
unset PI_LOCAL_MODEL_BENCH_MODELS

# Prevent inherited Node/npm options from rehydrating cleared credentials in child processes.
unset NODE_OPTIONS
unset npm_config_node_options
unset NPM_CONFIG_NODE_OPTIONS

if [ "$#" -gt 0 ]; then
    echo "Running targeted test(s) with isolated state: $*"
    node ./node_modules/vitest/dist/cli.js --run --bail=1 "$@"
else
    echo "Running tests with isolated state and without API keys..."
    npm run build
    npm test
fi
