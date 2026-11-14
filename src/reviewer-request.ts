import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { redactSecrets } from "./evidence.js";

export type ReviewerInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

type ProviderApproval = Extract<
  ReviewerInteraction["payload"],
  { kind: "approval" }
>;

const COMMAND_EXCERPT_CHARS = 120;

function commandExcerpt(command: string): string {
  const line = redactSecrets(command).replace(/\s+/g, " ").trim();
  return line.length > COMMAND_EXCERPT_CHARS
    ? `${line.slice(0, COMMAND_EXCERPT_CHARS - 1)}…`
    : line;
}

function approvalRequested(subject: ProviderApproval["subject"]): string {
  switch (subject.kind) {
    case "command":
      return `a command approval (\`${commandExcerpt(subject.command)}\`)`;
    case "file_change":
      return "a file change approval";
    case "permission_grant":
      return subject.toolName
        ? `a permission grant for ${subject.toolName}`
        : "a permission grant";
    case "plan":
      return "a plan approval";
    case "tool_use":
      return `approval to use ${subject.tool}`;
  }
}

function requested(payload: ReviewerInteraction["payload"]): string {
  if (payload.kind === "approval") return approvalRequested(payload.subject);
  if (payload.kind === "user_question") return "an answer to its question";
  return `input ("${payload.title}")`;
}

export function reviewerRequestReason(
  interaction: ReviewerInteraction,
): string | null {
  if (interaction.status !== "pending") return null;
  return `the reviewer asked for ${requested(interaction.payload)}, which Advisor never gives, so the review was stopped. The request can be read under "Show the reviewer's work" in the Advisor panel`;
}
