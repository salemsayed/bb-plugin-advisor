type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Row)
    : null;
}

export const TURN_START_EVENT_TYPES = ["client/turn/requested", "turn/completed"] as const;

export function isCompactionRequest(data: unknown): boolean {
  const input = asRow(data)?.input;
  if (!Array.isArray(input) || input.length !== 1) return false;
  const part = asRow(input[0]);
  if (part?.type !== "text" || !Array.isArray(part.mentions)) return false;
  return part.mentions.some((mention) => {
    const resource = asRow(asRow(mention)?.resource);
    return (
      resource?.kind === "command" &&
      resource.origin === "builtin" &&
      resource.name === "compact"
    );
  });
}

export function compactionUnderWay(newestFirst: readonly unknown[]): boolean {
  for (const candidate of newestFirst) {
    const event = asRow(candidate);
    if (event?.type === "turn/completed") return false;
    if (event?.type === "client/turn/requested" && isCompactionRequest(event.data)) return true;
  }
  return false;
}
