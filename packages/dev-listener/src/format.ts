import type { NormalizedSpanEvent } from "./types.ts";

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
}

/**
 * Multi-line human-readable summary of a span event:
 *
 *     [14:22:01] anthropic claude-3-5-sonnet-latest
 *       span: anthropic.messages.create
 *       trace: 8f3c... / span: 91ab...
 *       tokens: 1200 in / 240 out
 *       duration: 920ms
 *       status: success
 */
export function formatEvent(event: NormalizedSpanEvent): string {
  const header = [
    `[${clock(event.received_at)}]`,
    event.provider,
    event.model || "(no model)",
    event.status === "error" ? "ERROR" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const lines = [header, `  span: ${event.name}`];
  lines.push(`  trace: ${shortId(event.trace_id)} / span: ${shortId(event.span_id)}`);
  if (event.input_tokens > 0 || event.output_tokens > 0) {
    lines.push(`  tokens: ${event.input_tokens} in / ${event.output_tokens} out`);
  }
  lines.push(`  duration: ${event.duration_ms}ms`);
  lines.push(`  status: ${event.status}`);
  if (event.error) lines.push(`  error: ${event.error}`);
  return lines.join("\n");
}
