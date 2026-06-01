export interface Project {
  name: string
  path: string
}

export interface AutoAcceptRules {
  channels: Record<string, { users: string[] }>
}

// Server → Daemon
export type ServerMessage =
  | { type: "task"; taskId: string; prompt: string; workingDir: string; channel: string; ts: string; requesterId: string }
  | { type: "list_projects"; requestId: string }
  | { type: "config_cmd"; requestId: string; args: string[] }
  | { type: "ping" }

// Daemon → Server
export type DaemonMessage =
  | { type: "register"; slackUserId: string; token: string }
  | { type: "projects"; requestId: string; projects: Project[]; autoAccept: AutoAcceptRules }
  | { type: "config_response"; requestId: string; text: string }
  | { type: "stream"; taskId: string; chunk: string }
  | { type: "done"; taskId: string }
  | { type: "error"; taskId: string; message: string }
  | { type: "pong" }
