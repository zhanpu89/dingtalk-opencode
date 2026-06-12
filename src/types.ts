export interface DingTalkCallbackBody {
  msgtype: string;
  text?: { content: string };
  markdown?: { text: string; title: string };
  msgId: string;
  createAt: number;
  conversationId: string;
  conversationType: string;
  conversationTitle: string;
  senderId: string;
  senderNick: string;
  senderCorpId: string;
  chatbotUserId: string;
  isInAtList: boolean;
  sessionWebhook: string;
}

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
