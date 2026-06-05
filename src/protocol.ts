export interface Project {
  name: string
  path: string
}

export interface AutoAcceptRules {
  // Slack mode: auto-accept keyed by Slack channel → allowed sender ids ("*" = anyone).
  channels: Record<string, { users: string[] }>
  // No-Slack mode: auto-accept keyed by requester identity ("*" = anyone with the token).
  requesters?: string[]
}

// ---------------------------------------------------------------------------
// Daemon ↔ Server
// ---------------------------------------------------------------------------

// Server → Daemon
export type ServerMessage =
  | { type: "task"; taskId: string; prompt: string; workingDir: string; requesterId: string }
  | { type: "confirm_request"; taskId: string; prompt: string; workingDir: string; requesterId: string }
  | { type: "list_projects"; requestId: string }
  | { type: "config_cmd"; requestId: string; args: string[] }
  | { type: "ping" }

// Daemon → Server
export type DaemonMessage =
  | { type: "register"; role: "daemon"; daemonId: string; token: string }
  | { type: "projects"; requestId: string; projects: Project[]; autoAccept: AutoAcceptRules }
  | { type: "config_response"; requestId: string; text: string }
  | { type: "confirm_response"; taskId: string; accepted: boolean }
  | { type: "stream"; taskId: string; chunk: string }
  | { type: "done"; taskId: string }
  | { type: "error"; taskId: string; message: string }
  | { type: "pong" }

// ---------------------------------------------------------------------------
// CLI client ↔ Server (no-Slack mode)
// ---------------------------------------------------------------------------

// Client → Server
export type ClientMessage =
  | { type: "register"; role: "client"; clientId: string; token: string }
  | { type: "list_targets"; requestId: string }
  | { type: "get_projects"; requestId: string; targetDaemonId: string }
  | { type: "task_request"; requestId: string; targetDaemonId: string; projectName: string; workingDir: string; prompt: string }

// Server → Client
export type ServerToClientMessage =
  | { type: "targets"; requestId: string; daemonIds: string[] }
  | { type: "projects"; requestId: string; projects: Project[] }
  | { type: "request_error"; requestId: string; message: string }
  | { type: "task_accepted"; requestId: string; taskId: string }
  | { type: "task_denied"; requestId: string }
  | { type: "stream"; taskId: string; chunk: string }
  | { type: "done"; taskId: string }
  | { type: "error"; taskId: string; message: string }
