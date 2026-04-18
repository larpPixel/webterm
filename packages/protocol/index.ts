export type SessionStatus = 'idle' | 'attached' | 'closed';

export type SessionInfo = {
	sessionId: string;
	shell: string;
	createdAt: number;
	lastDetachedAt: number | null;
	status: SessionStatus;
	websocketPath: string;
};

export type HealthResponse = {
	status: 'ok';
	host: string;
	port: number;
	shell: string;
	idleTimeoutMs: number;
};

export type ClientEvent =
	| {
			type: 'attach';
			sessionId: string;
			cols?: number;
			rows?: number;
	  }
	| {
			type: 'input';
			data: string;
	  }
	| {
			type: 'resize';
			cols: number;
			rows: number;
	  }
	| {
			type: 'ping';
	  };

export type ServerEvent =
	| {
			type: 'ready';
			sessionId: string;
			shell: string;
			cols: number;
			rows: number;
	  }
	| {
			type: 'output';
			data: string;
	  }
	| {
			type: 'exit';
			exitCode: number | null;
			signal: number | null;
	  }
	| {
			type: 'error';
			message: string;
	  };

const isRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === 'object' && value !== null;
};

export const parseClientEvent = (value: unknown): ClientEvent | null => {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return null;
	}

		switch (value.type) {
			case 'attach':
				if (typeof value.sessionId !== 'string') {
					return null;
				}

				if (
					('cols' in value && typeof value.cols !== 'number') ||
					('rows' in value && typeof value.rows !== 'number')
				) {
					return null;
				}

				return {
					type: 'attach',
					sessionId: value.sessionId,
					cols: typeof value.cols === 'number' ? value.cols : undefined,
					rows: typeof value.rows === 'number' ? value.rows : undefined
				};

		case 'input':
			return typeof value.data === 'string' ? { type: 'input', data: value.data } : null;

		case 'resize':
			return typeof value.cols === 'number' && typeof value.rows === 'number'
				? {
						type: 'resize',
						cols: value.cols,
						rows: value.rows
					}
				: null;

		case 'ping':
			return { type: 'ping' };

		default:
			return null;
	}
};

export const parseServerEvent = (value: unknown): ServerEvent | null => {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return null;
	}

	switch (value.type) {
		case 'ready':
			return typeof value.sessionId === 'string' &&
				typeof value.shell === 'string' &&
				typeof value.cols === 'number' &&
				typeof value.rows === 'number'
				? {
						type: 'ready',
						sessionId: value.sessionId,
						shell: value.shell,
						cols: value.cols,
						rows: value.rows
					}
				: null;

		case 'output':
			return typeof value.data === 'string' ? { type: 'output', data: value.data } : null;

		case 'exit':
			return (typeof value.exitCode === 'number' || value.exitCode === null) &&
				(typeof value.signal === 'number' || value.signal === null)
				? {
						type: 'exit',
						exitCode: value.exitCode,
						signal: value.signal
					}
				: null;

		case 'error':
			return typeof value.message === 'string' ? { type: 'error', message: value.message } : null;

		default:
			return null;
	}
};
