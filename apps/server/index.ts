import { randomUUID } from 'node:crypto';
import { readdir, readlink } from 'node:fs/promises';
import { Data, Effect } from 'effect';
import {
	parseClientEvent,
	type ClientEvent,
	type HealthResponse,
	type ServerEvent,
	type SessionInfo
} from '@webterm/protocol';

const config = {
	host: process.env.TERMINAL_HOST ?? '0.0.0.0',
	port: Number(process.env.TERMINAL_PORT ?? '8787'),
	allowedOriginsRaw:
		process.env.TERMINAL_ALLOWED_ORIGINS ??
		process.env.TERMINAL_ALLOWED_ORIGIN ??
		'http://127.0.0.1:5173,http://localhost:5173,https://term.jr4.in',
	shell: process.env.TERMINAL_SHELL ?? '/bin/bash',
	cwd: process.env.TERMINAL_CWD ?? process.cwd(),
	idleTimeoutMs: Number(process.env.TERMINAL_IDLE_TIMEOUT_MS ?? '900000'),
	defaultCols: 120,
	defaultRows: 36
} as const;

const allowedOrigins = config.allowedOriginsRaw
	.split(',')
	.map((origin) => origin.trim())
	.filter((origin) => origin.length > 0);

const allowAnyOrigin = allowedOrigins.includes('*');

type SocketData = {
	sessionId?: string;
	clientId?: string;
	attached?: boolean;
};

type TerminalSocket = Bun.ServerWebSocket<SocketData>;
type TerminalProcess = ReturnType<typeof Bun.spawn>;

type SessionRecord = {
	id: string;
	shell: string;
	createdAt: number;
	lastDetachedAt: number | null;
	cols: number;
	rows: number;
	process: TerminalProcess;
	ptyPath: string | null;
	outputBuffer: string;
	clients: Map<string, TerminalSocket>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
};

const SESSION_OUTPUT_BUFFER_LIMIT = 64 * 1024;

class SessionNotFound extends Data.TaggedError('SessionNotFound')<{
	readonly sessionId: string;
}> {}

class SessionClosed extends Data.TaggedError('SessionClosed')<{
	readonly sessionId: string;
}> {}

const toSessionInfo = (session: SessionRecord): SessionInfo => ({
	sessionId: session.id,
	shell: session.shell,
	createdAt: session.createdAt,
	lastDetachedAt: session.lastDetachedAt,
	status: session.closed ? 'closed' : session.clients.size > 0 ? 'attached' : 'idle',
	websocketPath: `/api/sessions/${session.id}/ws`
});

const sendEvent = (socket: TerminalSocket, event: ServerEvent) => {
	socket.send(JSON.stringify(event));
};

const broadcast = (session: SessionRecord, event: ServerEvent) => {
	const payload = JSON.stringify(event);

	for (const socket of session.clients.values()) {
		socket.send(payload);
	}
};

const createTerminalProcess = (shell: string) => {
	return Bun.spawn(['script', '-qfec', `${shell} -i`, '/dev/null'], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: config.cwd,
		env: {
			...process.env,
			TERM: 'xterm-256color'
		}
	});
};

const appendOutputBuffer = (session: SessionRecord, chunk: string) => {
	if (chunk.length === 0) {
		return;
	}

	session.outputBuffer += chunk;

	if (session.outputBuffer.length > SESSION_OUTPUT_BUFFER_LIMIT) {
		session.outputBuffer = session.outputBuffer.slice(-SESSION_OUTPUT_BUFFER_LIMIT);
	}
};

const findProcessPtyPath = async (process: TerminalProcess) => {
	const procFdPath = `/proc/${process.pid}/fd`;

	try {
		const fdEntries = await readdir(procFdPath);

		for (const fdEntry of fdEntries) {
			const target = await readlink(`${procFdPath}/${fdEntry}`).catch(() => null);

			if (target !== null && /^\/dev\/pts\/\d+$/.test(target)) {
				return target;
			}
		}
	} catch {
		return null;
	}

	return null;
};

const resizeSessionPty = (session: SessionRecord) => {
	if (session.ptyPath === null) {
		return;
	}

	const resizeProcess = Bun.spawn(
		[
			'stty',
			'-F',
			session.ptyPath,
			'cols',
			String(session.cols),
			'rows',
			String(session.rows)
		],
		{
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore'
		}
	);

	void resizeProcess.exited.catch(() => {
		// Ignore resize races during session shutdown.
	});
};

const streamTerminalOutput = (session: SessionRecord, stream: ReadableStream<Uint8Array> | null) => {
	if (stream === null) {
		return;
	}

	const decoder = new TextDecoder();
	const reader = stream.getReader();

	void (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();

				if (done) {
					const tail = decoder.decode();
					appendOutputBuffer(session, tail);

					if (!session.closed && tail.length > 0) {
						broadcast(session, {
							type: 'output',
							data: tail
						});
					}

					break;
				}

				const chunk = decoder.decode(value, { stream: true });
				appendOutputBuffer(session, chunk);

				if (!session.closed) {
					broadcast(session, {
						type: 'output',
						data: chunk
					});
				}
			}
		} catch (error) {
			if (!session.closed) {
				console.error('Failed to read terminal stream', error);
			}
		} finally {
			reader.releaseLock();
		}
	})();
};

type TerminalRegistry = {
	readonly createSession: Effect.Effect<SessionInfo, never>;
	readonly getSession: (sessionId: string) => Effect.Effect<SessionInfo, SessionNotFound | SessionClosed>;
	readonly attachClient: (
		sessionId: string,
		clientId: string,
		socket: TerminalSocket,
		initialSize?: { cols: number; rows: number }
	) => Effect.Effect<void, SessionNotFound | SessionClosed>;
	readonly detachClient: (sessionId: string, clientId: string) => Effect.Effect<void>;
	readonly handleMessage: (
		sessionId: string,
		message: ClientEvent
	) => Effect.Effect<void, SessionNotFound | SessionClosed>;
	readonly closeSession: (sessionId: string) => Effect.Effect<void, SessionNotFound | SessionClosed>;
};

const terminalRegistry: TerminalRegistry = (() => {
	const sessions = new Map<string, SessionRecord>();

	const getSessionRecord = (
		sessionId: string
	): Effect.Effect<SessionRecord, SessionNotFound | SessionClosed> => {
		const session = sessions.get(sessionId);

		if (!session) {
			return Effect.fail(new SessionNotFound({ sessionId }));
		}

		if (session.closed) {
			return Effect.fail(new SessionClosed({ sessionId }));
		}

		return Effect.succeed(session);
	};

	const clearIdleTimer = (session: SessionRecord) => {
		if (session.idleTimer !== null) {
			clearTimeout(session.idleTimer);
			session.idleTimer = null;
		}
	};

	const closeRecord = (session: SessionRecord, exitCode: number | null, signal: number | null) => {
		if (session.closed) {
			return;
		}

		session.closed = true;
		clearIdleTimer(session);
		sessions.delete(session.id);
		broadcast(session, {
			type: 'exit',
			exitCode,
			signal
		});
		for (const socket of session.clients.values()) {
			socket.close();
		}
		session.clients.clear();
	};

	const scheduleIdleCleanup = (session: SessionRecord) => {
		clearIdleTimer(session);

		session.idleTimer = setTimeout(() => {
			if (session.clients.size === 0 && !session.closed) {
				session.process.kill();
			}
		}, config.idleTimeoutMs);
	};

	return {
		createSession: Effect.sync(() => {
			const sessionId = randomUUID();
			const shell = config.shell;
			const createdAt = Date.now();
			const terminalProcess = createTerminalProcess(shell);

			const session: SessionRecord = {
				id: sessionId,
				shell,
				createdAt,
				lastDetachedAt: null,
				cols: config.defaultCols,
				rows: config.defaultRows,
				process: terminalProcess,
				ptyPath: null,
				outputBuffer: '',
				clients: new Map(),
				idleTimer: null,
				closed: false
			};

			void findProcessPtyPath(terminalProcess).then((ptyPath) => {
				if (session.closed) {
					return;
				}

				session.ptyPath = ptyPath;

				if (ptyPath !== null) {
					resizeSessionPty(session);
				}
			});

			streamTerminalOutput(session, terminalProcess.stdout);
			streamTerminalOutput(session, terminalProcess.stderr);

			void terminalProcess.exited.then((exitCode) => {
				closeRecord(session, exitCode, null);
			});

			sessions.set(sessionId, session);

			return toSessionInfo(session);
		}),
		getSession: (sessionId: string) => Effect.map(getSessionRecord(sessionId), toSessionInfo),
		attachClient: (sessionId: string, clientId: string, socket: TerminalSocket, initialSize) =>
			Effect.flatMap(getSessionRecord(sessionId), (session) =>
				Effect.sync(() => {
					clearIdleTimer(session);

					if (initialSize) {
						session.cols = initialSize.cols;
						session.rows = initialSize.rows;
						resizeSessionPty(session);

						if (session.ptyPath === null) {
							void findProcessPtyPath(session.process).then((ptyPath) => {
								if (session.closed || ptyPath === null) {
									return;
								}

								session.ptyPath = ptyPath;
								resizeSessionPty(session);
							});
						}
					}

					if (session.outputBuffer.length > 0) {
						sendEvent(socket, {
							type: 'output',
							data: session.outputBuffer
						});
					}

					session.clients.set(clientId, socket);

					sendEvent(socket, {
						type: 'ready',
						sessionId: session.id,
						shell: session.shell,
						cols: session.cols,
						rows: session.rows
					});
				})
			),
		detachClient: (sessionId: string, clientId: string) =>
			Effect.sync(() => {
				const session = sessions.get(sessionId);

				if (!session || session.closed) {
					return;
				}

				session.clients.delete(clientId);
				session.lastDetachedAt = Date.now();

				if (session.clients.size === 0) {
					scheduleIdleCleanup(session);
				}
			}),
		handleMessage: (sessionId: string, message: ClientEvent) =>
			Effect.flatMap(getSessionRecord(sessionId), (session) =>
				Effect.sync(() => {
					switch (message.type) {
						case 'input':
							if (session.process.stdin && typeof session.process.stdin !== 'number') {
								session.process.stdin.write(message.data);
							}
							return;

						case 'resize':
							session.cols = message.cols;
							session.rows = message.rows;
							resizeSessionPty(session);
							return;

						case 'ping':
							return;
					}
				})
			),
		closeSession: (sessionId: string) =>
			Effect.flatMap(getSessionRecord(sessionId), (session) =>
				Effect.sync(() => {
					session.process.kill();
				})
			)
	};
})();

const runTerminalEffect = <T, E>(effect: Effect.Effect<T, E>) => {
	return Effect.runPromise(effect);
};

const corsHeaders = (request: Request) => {
	const requestOrigin = request.headers.get('origin');
	const allowOrigin =
		allowAnyOrigin || requestOrigin === null
			? '*'
			: allowedOrigins.includes(requestOrigin)
				? requestOrigin
				: allowedOrigins[0] ?? '*';

	return {
		'access-control-allow-origin': allowOrigin,
		'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
		'access-control-allow-headers': 'content-type'
	};
};

const jsonResponse = (request: Request, payload: unknown, status = 200) => {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			'content-type': 'application/json',
			...corsHeaders(request)
		}
	});
};

const isAllowedOrigin = (request: Request) => {
	if (allowAnyOrigin) {
		return true;
	}

	const origin = request.headers.get('origin');
	return origin === null || allowedOrigins.includes(origin);
};

const extractSessionId = (pathname: string) => {
	const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/ws)?$/);
	return match?.[1] ?? null;
};

const server = Bun.serve<SocketData>({
	hostname: config.host,
	port: config.port,
	fetch(request, server) {
		const url = new URL(request.url);

		if (url.pathname === '/' && request.method === 'GET') {
			return jsonResponse(request, {
				service: 'webterm-server',
				status: 'ok',
				endpoints: {
					health: '/health',
					createSession: 'POST /api/sessions',
					getSession: 'GET /api/sessions/:sessionId',
					closeSession: 'DELETE /api/sessions/:sessionId',
					websocket: 'GET /api/sessions/:sessionId/ws'
				}
			});
		}

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: corsHeaders(request)
			});
		}

		if (!isAllowedOrigin(request)) {
			return jsonResponse(request, { message: 'Origin is not allowed' }, 403);
		}

		if (url.pathname === '/health' && request.method === 'GET') {
			const payload: HealthResponse = {
				status: 'ok',
				host: config.host,
				port: config.port,
				shell: config.shell,
				idleTimeoutMs: config.idleTimeoutMs
			};

			return jsonResponse(request, payload);
		}

		if (url.pathname === '/api/sessions' && request.method === 'POST') {
			return runTerminalEffect(
				Effect.map(terminalRegistry.createSession, (session) => jsonResponse(request, session, 201))
			).catch((error) => {
				console.error('Failed to create session', error);
				return jsonResponse(request, { message: 'Failed to create session' }, 500);
			});
		}

		const sessionId = extractSessionId(url.pathname);

		if (sessionId && request.method === 'GET' && !url.pathname.endsWith('/ws')) {
			return runTerminalEffect(
				Effect.map(terminalRegistry.getSession(sessionId), (session) => jsonResponse(request, session))
			).catch((error) => {
				if (error instanceof SessionNotFound || error instanceof SessionClosed) {
					return jsonResponse(request, { message: 'Session not found' }, 404);
				}

				console.error('Failed to fetch session', error);
				return jsonResponse(request, { message: 'Failed to fetch session' }, 500);
			});
		}

		if (sessionId && request.method === 'DELETE') {
			return runTerminalEffect(
				Effect.map(terminalRegistry.closeSession(sessionId), () => {
					return new Response(null, {
						status: 204,
						headers: corsHeaders(request)
					});
				})
			).catch((error) => {
				if (error instanceof SessionNotFound || error instanceof SessionClosed) {
					return jsonResponse(request, { message: 'Session not found' }, 404);
				}

				console.error('Failed to close session', error);
				return jsonResponse(request, { message: 'Failed to close session' }, 500);
			});
		}

		if (sessionId && url.pathname.endsWith('/ws')) {
			const upgraded = server.upgrade(request, {
				data: {}
			});

			if (upgraded) {
				return undefined;
			}

			return jsonResponse(request, { message: 'WebSocket upgrade failed' }, 400);
		}

		return jsonResponse(request, { message: 'Not found' }, 404);
	},
	websocket: {
		open(socket) {
			socket.data.clientId = randomUUID();
			socket.data.attached = false;
		},
		message(socket, rawMessage) {
			const messageText = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();

			let parsedValue: unknown;

			try {
				parsedValue = JSON.parse(messageText);
			} catch {
				sendEvent(socket, {
					type: 'error',
					message: 'WebSocket payload must be valid JSON'
				});
				return;
			}

			const message = parseClientEvent(parsedValue);

			if (message === null) {
				sendEvent(socket, {
					type: 'error',
					message: 'WebSocket payload did not match the terminal protocol'
				});
				return;
			}

			if (!socket.data.attached) {
				if (message.type !== 'attach' || !socket.data.clientId) {
					sendEvent(socket, {
						type: 'error',
						message: 'First WebSocket message must attach to a session'
					});
					return;
				}

				void runTerminalEffect(
					terminalRegistry.attachClient(message.sessionId, socket.data.clientId, socket, {
						cols: message.cols ?? config.defaultCols,
						rows: message.rows ?? config.defaultRows
					})
				).then(() => {
					socket.data.sessionId = message.sessionId;
					socket.data.attached = true;
				}).catch((error) => {
					console.error('Failed to attach client', error);
					sendEvent(socket, {
						type: 'error',
						message: 'Session is unavailable'
					});
					socket.close();
				});
				return;
			}

			if (!socket.data.sessionId) {
				sendEvent(socket, {
					type: 'error',
					message: 'Socket is missing an attached session id'
				});
				return;
			}

			void runTerminalEffect(terminalRegistry.handleMessage(socket.data.sessionId, message)).catch(
				(error) => {
					console.error('Failed to process socket message', error);
					sendEvent(socket, {
						type: 'error',
						message: 'Failed to process terminal input'
					});
				}
			);
		},
		close(socket) {
			if (socket.data.sessionId && socket.data.clientId) {
				void runTerminalEffect(
					terminalRegistry.detachClient(socket.data.sessionId, socket.data.clientId)
				);
			}
		}
	}
});

console.log(`terminal server listening on http://${server.hostname}:${server.port}`);
