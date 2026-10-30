// Tool names (no typebox import, so plain-node tests and commands can use it).
export const TOOL_NAMES = [
	"team_send_message",
	"team_delegate_task",
	"team_request_expansion",
	"team_review_expansion",
	"team_get_tree",
	"team_get_inbox",
	"team_report_progress",
	"team_complete_task",
	"team_get_models",
	"team_register_model",
	"team_create_member",
	"team_watch",
	"team_get_budget",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
