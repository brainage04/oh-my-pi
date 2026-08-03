export interface GuiSessionSummary {
	id: string;
	cwd: string;
	title: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	state: "idle" | "streaming" | "queued" | "completed" | "interrupted" | "failed";
	managed: boolean;
	writable: boolean;
}

export interface GuiTranscriptItem {
	id: string;
	timestamp: string;
	kind: "message" | "tool";
	role: "user" | "assistant" | "tool" | "system";
	text: string;
	toolName?: string;
	isError?: boolean;
}

export interface GuiTranscriptPage {
	items: GuiTranscriptItem[];
	nextBefore?: string;
}

export interface GuiBackendEvent {
	event: "message_started" | "message_delta" | "message_completed" | "tool_started" | "tool_completed";
	sessionId: string;
	operationId?: string;
	data: unknown;
}

export interface GuiLiveMessage {
	sessionId: string;
	operationId?: string;
	message: GuiTranscriptItem;
}

export interface GuiBackendIdentity {
	daemonId: string;
	runtimeVersion: string;
}

export interface GuiBackend {
	identity?(): GuiBackendIdentity;
	listSessions(): Promise<GuiSessionSummary[]>;
	createSession(cwd: string, name?: string): Promise<GuiSessionSummary>;
	transcriptPage(sessionId: string, before?: string, limit?: number): Promise<GuiTranscriptPage>;
	prompt(sessionId: string, text: string, operationId: string): Promise<{ agentInvoked: boolean }>;
	shutdownSession(sessionId: string): Promise<void>;
	isManaged(sessionId: string): boolean;
	liveMessages(): GuiLiveMessage[];
	subscribe(listener: (event: GuiBackendEvent) => void): () => void;
	dispose(): Promise<void>;
}

export class GuiBackendError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "GuiBackendError";
	}
}
