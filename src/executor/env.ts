// Worker environment: a minimal allowlisted subset of the parent env plus the team contract.
// Never copy the whole parent env: it may contain the parent session's PI_* metadata,
// the operator's PI_TEAM_* settings and unrelated secrets.

import { ENV_ENROLL_FILE } from "../shared/protocol.ts";
import type { LaunchSpec } from "./types.ts";

export const ENV_LAUNCH_TOKEN = "PI_TEAM_LAUNCH_TOKEN";
/** Non-secret launch metadata (informational; the enrollment file is authoritative). */
export const ENV_AGENT_ID = "PI_TEAM_AGENT_ID";
export const ENV_RUN_ID = "PI_TEAM_RUN_ID";
export const ENV_RESUME = "PI_TEAM_RESUME";

/** Generic process environment needed for a sane shell / toolchain. */
const BASE_KEYS = [
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ",
	"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
	"NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
	"SSH_AUTH_SOCK", // git over ssh inside worktrees
];

/** Pi process configuration (docs/environment-variables.md). Deliberately excludes the
 *  parent session markers PI_SESSION_ID / PI_SESSION_FILE / PI_PROVIDER / PI_MODEL /
 *  PI_REASONING_LEVEL / PI_CODING_AGENT / AI_AGENT. */
const PI_KEYS = [
	"PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_PACKAGE_DIR", "PI_OFFLINE",
	"PI_TELEMETRY", "PI_CACHE_RETENTION", "PI_CODEMODE_MAX_WORKERS",
];

/** Provider credential / config variables read by Pi 1.4.0
 *  (@earendil-works/pi-ai/dist/env-api-keys.js + docs/providers.md). */
const PROVIDER_KEYS = [
	"AI_GATEWAY_API_KEY", "ANT_LING_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_ORGANIZATION_ID",
	"ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID",
	"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE",
	"AWS_REGION", "AWS_DEFAULT_REGION", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN",
	"AZURE_OPENAI_API_KEY", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_RESOURCE_NAME",
	"BASETEN_API_KEY", "CEREBRAS_API_KEY", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
	"COPILOT_GITHUB_TOKEN", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY",
	"GCLOUD_PROJECT", "GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_PROJECT",
	"GROQ_API_KEY", "HF_TOKEN", "KIMI_API_KEY", "META_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY", "MOONSHOT_API_KEY", "NVIDIA_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY",
	"OPENROUTER_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY", "RADIUS_API_KEY",
	"TOGETHER_API_KEY", "TYPESAFE_API_KEY", "XAI_API_KEY", "XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY",
];

export const ENV_ALLOWLIST: readonly string[] = [...BASE_KEYS, ...PI_KEYS, ...PROVIDER_KEYS];

/**
 * Build the worker env.
 * @param extraPrefixes additional parent-env prefixes to pass through (ScriptExecutor: "PI_TEAM_FAKE_").
 */
export function buildWorkerEnv(
	spec: LaunchSpec,
	launchToken: string,
	parent: NodeJS.ProcessEnv = process.env,
	extraPrefixes: readonly string[] = [],
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const k of ENV_ALLOWLIST) {
		const v = parent[k];
		if (typeof v === "string") env[k] = v;
	}
	for (const [k, v] of Object.entries(parent)) {
		if (typeof v === "string" && extraPrefixes.some((p) => k.startsWith(p))) env[k] = v;
	}
	// One Pi version check per worker launch is noise; the parent already checked.
	env.PI_SKIP_VERSION_CHECK = "1";
	env[ENV_ENROLL_FILE] = spec.enroll_file;
	// PI_TEAM_STATE_DIR is deliberately NOT passed (review finding 7): it would point the worker's
	// bash tool straight at operator.token / org.sqlite. Workers reach the controller only via the
	// enrollment file's socket_path. (Same-uid workers can still find the default path: mitigation only.)
	env[ENV_LAUNCH_TOKEN] = launchToken;
	env[ENV_AGENT_ID] = spec.agent_id;
	env[ENV_RUN_ID] = spec.run_id;
	env[ENV_RESUME] = spec.resume ? "1" : "0";
	return env;
}
