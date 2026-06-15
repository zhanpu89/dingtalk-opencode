export interface DingTalkSendBody {
  msgtype: string;
  text?: { content: string };
  markdown?: { title: string; text: string };
}

export interface OpenCodePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: string;
  [key: string]: unknown;
}

export interface OpenCodeMessageResponse {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export interface OpenCodeSession {
  id: string;
  title?: string;
  [key: string]: unknown;
}

export interface OpenCodeSessionListResponse {
  id: string;
  title?: string;
  [key: string]: unknown;
}

export interface SummaryResult {
  summary: string;
  changedFiles: string[];
  toolNames: string[];
  fullLength: number;
}
