export type DraftState = "collecting" | "awaiting_confirmation";
export type RequirementStatus =
  | "待评估"
  | "已排期"
  | "进行中"
  | "待验收"
  | "已完成"
  | "暂缓";

export interface RequirementDraft {
  id: string;
  conversationKey: string;
  requesterId: string;
  requesterName?: string;
  title: string;
  goal?: string;
  scope?: string;
  platforms?: string[];
  acceptanceCriteria?: string;
  desiredDate?: string;
  priority?: string;
  state: DraftState;
  createdAt: string;
  updatedAt: string;
}

export interface Requirement {
  id: string;
  title: string;
  goal: string;
  scope: string;
  acceptanceCriteria: string;
  requesterId: string;
  requesterName?: string;
  platforms: string[];
  desiredDate?: string;
  priority?: string;
  status: RequirementStatus;
  ownerId?: string;
  ownerName?: string;
  progress?: string;
  visibility: "public" | "requester" | "private";
  sourceChatId: string;
  sourceMessageId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationState {
  key: string;
  chatId: string;
  senderId: string;
  senderName?: string;
  threadId?: string;
  draft?: RequirementDraft;
  recentMessages: string[];
  updatedAt: string;
}

export interface IncomingMessage {
  chatId: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  content: string;
  senderType?: "user" | "bot";
  threadId?: string;
}

export interface BotReply {
  text: string;
  replyInThread?: boolean;
}

export interface RequirementStore {
  getConversation(key: string): Promise<ConversationState | undefined>;
  saveConversation(conversation: ConversationState): Promise<void>;
  createRequirement(input: Omit<Requirement, "id" | "createdAt" | "updatedAt">): Promise<Requirement>;
  listRequirements(filter?: { requesterId?: string; status?: RequirementStatus; visibility?: Requirement["visibility"] }): Promise<Requirement[]>;
  updateRequirement(id: string, patch: Partial<Pick<Requirement, "status" | "ownerId" | "ownerName" | "progress" | "desiredDate" | "priority" | "visibility">>): Promise<Requirement | undefined>;
  deleteRequirement(id: string): Promise<boolean>;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}
