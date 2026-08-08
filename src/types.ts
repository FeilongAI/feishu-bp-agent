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
  pendingBaseFieldDelete?: PendingBaseFieldDelete;
  recentMessages: string[];
  updatedAt: string;
}

export interface PendingBaseFieldDelete {
  fieldId: string;
  fieldName: string;
  requestedById: string;
  requestedAt: string;
  expiresAt: string;
}

export interface IncomingMessage {
  chatId: string;
  chatType?: "p2p" | "group";
  tenantKey?: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  content: string;
  senderType?: "user" | "bot";
  threadId?: string;
  mentions?: Array<{ id: string; name?: string }>;
}

export interface BotReply {
  text: string;
  replyInThread?: boolean;
}

export interface ProcessedMessageClaim {
  claimed: boolean;
  reply?: BotReply;
  status?: "processing" | "completed" | "failed";
}

export interface AdminAuditEvent {
  actorId: string;
  action: string;
  resourceId?: string;
  payload?: unknown;
  result: "success" | "denied" | "failed";
}

export interface BaseOutboxItem {
  id: number;
  requirementId: string;
  operation: "upsert" | "delete";
  payload: Requirement | { id: string };
  attempts: number;
  lockToken: string;
}

export interface BaseOutboxStore {
  claimBaseOutbox(limit: number): Promise<BaseOutboxItem[]>;
  releaseBaseOutboxLease(lockToken: string): Promise<void>;
  getBaseRecordId(requirementId: string): Promise<string | undefined>;
  completeBaseOutbox(item: BaseOutboxItem, recordId?: string): Promise<void>;
  failBaseOutbox(item: BaseOutboxItem, error: string, retryAt: Date): Promise<void>;
}

export interface RequirementStore {
  getConversation(key: string): Promise<ConversationState | undefined>;
  saveConversation(conversation: ConversationState): Promise<void>;
  createRequirement(input: Omit<Requirement, "id" | "createdAt" | "updatedAt">): Promise<Requirement>;
  listRequirements(filter?: { requesterId?: string; status?: RequirementStatus; visibility?: Requirement["visibility"] }): Promise<Requirement[]>;
  updateRequirement(id: string, patch: Partial<Pick<Requirement, "status" | "ownerId" | "ownerName" | "progress" | "desiredDate" | "priority" | "visibility">>): Promise<Requirement | undefined>;
  deleteRequirement(id: string): Promise<boolean>;
  claimMessage(messageId: string, conversationKey: string): Promise<ProcessedMessageClaim>;
  completeMessage(messageId: string, reply: BotReply): Promise<void>;
  failMessage(messageId: string, errorCode: string): Promise<void>;
  withConversationLock<T>(conversationKey: string, operation: (store: RequirementStore) => Promise<T>): Promise<T>;
  recordAudit(event: AdminAuditEvent): Promise<void>;
  healthCheck(): Promise<void>;
  close(): Promise<void>;
}
