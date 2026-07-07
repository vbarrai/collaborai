// A StreamSink is where a task's output goes. The orchestration core is agnostic
// to whether that is a Slack message being edited in place (Slack mode) or a
// WebSocket relay to a connected CLI client (no-Slack mode).
export interface StreamSink {
  append(chunk: string): Promise<void>
  finish(): Promise<void>
  error(message: string): Promise<void>
}
