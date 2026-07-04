<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { WTerm, type TerminalCore, type WTermOptions } from '@wterm/dom';
	import '@wterm/dom/css';
	import { parseServerEvent } from '@webterm/protocol';

	let {
		sessionId,
		isActive = false,
		onTitleChange
	}: {
		sessionId: string;
		isActive?: boolean;
		onTitleChange?: (title: string) => void;
	} = $props();

	let terminalContainer: HTMLElement;
	let term: WTerm | null = null;
	let socket: WebSocket | null = null;
	let hasExited = false;
	let isFocused = false;
	let outputAnimationFrame: number | null = null;
	let pendingTerminalOutput = '';
	let pendingTitleSequence = '';
	let lastSentResize: { cols: number; rows: number } | null = null;

	type KeyboardNavigator = Navigator & {
		keyboard?: {
			lock: (codes?: string[]) => Promise<void>;
			unlock: () => void;
		};
	};

	const terminalServerUrl = env.PUBLIC_TERMINAL_SERVER_URL || 'http://127.0.0.1:8787';
	const terminalFontFamily =
		env.PUBLIC_TERMINAL_FONT_FAMILY ||
		'"JetBrains Mono NFM", "JetBrainsMono Nerd Font", "JetBrains Mono", "CaskaydiaMono Nerd Font", "FiraCode Nerd Font", "SF Mono", Menlo, Monaco, "Courier New", monospace';
	const terminalCorePreference = (env.PUBLIC_TERMINAL_CORE ?? 'builtin').trim().toLowerCase();
	const maxTerminalWriteCharsPerFrame = 64 * 1024;
	const maxTitleSequenceBufferChars = 2048;

	const loadTerminalCore = async (): Promise<TerminalCore | undefined> => {
		if (
			terminalCorePreference === '' ||
			terminalCorePreference === 'builtin' ||
			terminalCorePreference === 'wterm'
		) {
			return undefined;
		}

		if (terminalCorePreference !== 'ghostty') {
			console.warn(`Unknown terminal core "${terminalCorePreference}"; using built-in WTerm core.`);
			return undefined;
		}

		try {
			const { GhosttyCore } = await import('@wterm/ghostty');
			return await GhosttyCore.load();
		} catch (error) {
			console.warn(
				'Failed to load Ghostty terminal core; falling back to built-in WTerm core.',
				error
			);
			return undefined;
		}
	};

	const toWebSocketUrl = (serverUrl: string, currentSessionId: string) => {
		const wsBase = serverUrl
			.replace(/^http:/, 'ws:')
			.replace(/^https:/, 'wss:')
			.replace(/\/$/, '');
		return `${wsBase}/api/sessions/${currentSessionId}/ws`;
	};

	const sendResize = (cols: number, rows: number) => {
		if (socket?.readyState !== WebSocket.OPEN) {
			return;
		}

		if (lastSentResize?.cols === cols && lastSentResize.rows === rows) {
			return;
		}

		lastSentResize = { cols, rows };
		socket.send(JSON.stringify({ type: 'resize', cols, rows }));
	};

	const writeSystemMessage = (message: string) => {
		queueTerminalOutput(`\x1b[3m${message}\x1b[0m\r\n`);
	};

	const updateTitleFromTerminalOutput = (data: string) => {
		let buffer = pendingTitleSequence + data;
		let offset = 0;
		pendingTitleSequence = '';

		while (true) {
			const oscStart = buffer.indexOf('\x1b]', offset);

			if (oscStart === -1) {
				break;
			}

			const belEnd = buffer.indexOf('\x07', oscStart + 2);
			const stEnd = buffer.indexOf('\x1b\\', oscStart + 2);
			const useBel = belEnd !== -1 && (stEnd === -1 || belEnd < stEnd);
			const endIndex = useBel ? belEnd : stEnd;

			if (endIndex === -1) {
				const pendingSequence = buffer.slice(oscStart);
				pendingTitleSequence =
					pendingSequence.length <= maxTitleSequenceBufferChars ? pendingSequence : '';
				return;
			}

			const sequence = buffer.slice(oscStart + 2, endIndex);
			const separatorIndex = sequence.indexOf(';');
			const command = separatorIndex === -1 ? sequence : sequence.slice(0, separatorIndex);

			if (separatorIndex !== -1 && (command === '0' || command === '1' || command === '2')) {
				onTitleChange?.(sequence.slice(separatorIndex + 1));
			}

			offset = endIndex + (useBel ? 1 : 2);
		}

		if (buffer.endsWith('\x1b')) {
			pendingTitleSequence = '\x1b';
		}
	};

	const flushTerminalOutput = () => {
		outputAnimationFrame = null;

		if (!term || pendingTerminalOutput.length === 0) {
			return;
		}

		const chunk = pendingTerminalOutput.slice(0, maxTerminalWriteCharsPerFrame);
		pendingTerminalOutput = pendingTerminalOutput.slice(chunk.length);
		term.write(chunk);

		if (pendingTerminalOutput.length > 0) {
			scheduleTerminalOutputFlush();
		}
	};

	const scheduleTerminalOutputFlush = () => {
		if (outputAnimationFrame !== null) {
			return;
		}

		outputAnimationFrame = requestAnimationFrame(flushTerminalOutput);
	};

	const queueTerminalOutput = (data: string) => {
		if (data.length === 0) {
			return;
		}

		updateTitleFromTerminalOutput(data);
		pendingTerminalOutput += data;
		scheduleTerminalOutputFlush();
	};

	const getKeyboardNavigator = () => {
		if (typeof navigator === 'undefined') {
			return null;
		}

		return navigator as KeyboardNavigator;
	};

	const requestKeyboardLock = async () => {
		const keyboardNavigator = getKeyboardNavigator();

		if (!isFocused || !keyboardNavigator?.keyboard) {
			return;
		}

		try {
			await keyboardNavigator.keyboard.lock();
		} catch {
			// Browser or platform refused keyboard lock.
		}
	};

	const releaseKeyboardLock = () => {
		const keyboardNavigator = getKeyboardNavigator();

		if (keyboardNavigator?.keyboard) {
			keyboardNavigator.keyboard.unlock();
		}
	};

	const handleTerminalFocusIn = () => {
		isFocused = true;
	};

	const handleTerminalFocusOut = () => {
		isFocused = false;
		releaseKeyboardLock();
	};

	const handleTerminalPointerDown = () => {
		isFocused = true;
		void requestKeyboardLock();
	};

	onMount(() => {
		let cancelled = false;

		void (async () => {
			terminalContainer.style.setProperty('--term-font-family', terminalFontFamily);
			const terminalCore = await loadTerminalCore();

			if (cancelled) {
				return;
			}

			const terminalOptions: WTermOptions = {
				...(terminalCore ? { core: terminalCore } : {}),
				cols: 120,
				rows: 36,
				autoResize: true,
				cursorBlink: true,
				onData(data) {
					if (socket?.readyState === WebSocket.OPEN) {
						socket.send(JSON.stringify({ type: 'input', data }));
					}
				},
				onTitle(title) {
					onTitleChange?.(title);
				},
				onResize(cols, rows) {
					sendResize(cols, rows);
				}
			};

			term = new WTerm(terminalContainer, terminalOptions);

			await term.init();

			if (cancelled) {
				return;
			}

			if (isActive) {
				term.focus();
			}

			terminalContainer.addEventListener('focusin', handleTerminalFocusIn);
			terminalContainer.addEventListener('focusout', handleTerminalFocusOut);
			terminalContainer.addEventListener('pointerdown', handleTerminalPointerDown);

			const wsUrl = toWebSocketUrl(terminalServerUrl, sessionId);
			socket = new WebSocket(wsUrl);

			socket.onopen = () => {
				if (!term) {
					return;
				}

				socket?.send(
					JSON.stringify({
						type: 'attach',
						sessionId,
						cols: term.cols,
						rows: term.rows
					})
				);
				lastSentResize = { cols: term.cols, rows: term.rows };
			};

			socket.onmessage = (event) => {
				if (typeof event.data !== 'string') {
					return;
				}

				try {
					const message = parseServerEvent(JSON.parse(event.data));

					if (message === null) {
						writeSystemMessage('[protocol error] Received an unknown server event.');
						return;
					}

					switch (message.type) {
						case 'ready':
							if (isActive) {
								term?.focus();
							}
							return;

						case 'output':
							queueTerminalOutput(message.data);
							return;

						case 'error':
							writeSystemMessage(`[server] ${message.message}`);
							return;

						case 'exit':
							hasExited = true;
							writeSystemMessage(`[process exited with code ${message.exitCode ?? 'null'}]`);
							return;
					}
				} catch (error) {
					console.error('Failed to parse terminal message', error);
					writeSystemMessage('[protocol error] Failed to parse server message.');
				}
			};

			socket.onerror = () => {
				writeSystemMessage('[connection error] Failed to reach terminal server.');
			};

			socket.onclose = () => {
				if (!hasExited) {
					writeSystemMessage('[disconnected from server]');
				}
			};
		})();

		return () => {
			cancelled = true;
		};
	});

	$effect(() => {
		if (isActive && term) {
			term.focus();
		}
	});

	onDestroy(() => {
		if (outputAnimationFrame !== null) {
			cancelAnimationFrame(outputAnimationFrame);
		}
		terminalContainer?.removeEventListener('focusin', handleTerminalFocusIn);
		terminalContainer?.removeEventListener('focusout', handleTerminalFocusOut);
		terminalContainer?.removeEventListener('pointerdown', handleTerminalPointerDown);
		releaseKeyboardLock();
		socket?.close();
		term?.destroy();
	});
</script>

<div
	bind:this={terminalContainer}
	class="terminal-container"
	style:visibility={isActive ? 'visible' : 'hidden'}
></div>

<style>
	.terminal-container {
		--term-bg: #09090b;
		--term-fg: #f4f4f5;
		--term-cursor: #d4d4d8;
		--term-font-size: 14px;
		--term-color-0: #18181b;
		--term-color-1: #ef4444;
		--term-color-2: #22c55e;
		--term-color-3: #eab308;
		--term-color-4: #3b82f6;
		--term-color-5: #d946ef;
		--term-color-6: #06b6d4;
		--term-color-7: #f4f4f5;
		--term-color-8: #52525b;
		--term-color-9: #f87171;
		--term-color-10: #4ade80;
		--term-color-11: #fde047;
		--term-color-12: #60a5fa;
		--term-color-13: #e879f9;
		--term-color-14: #22d3ee;
		--term-color-15: #fafafa;
		position: absolute;
		inset: 0;
		box-sizing: border-box;
		padding: 10px 12px;
		overflow-x: hidden;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-gutter: stable;
		border-radius: 0;
		background: var(--term-bg);
		box-shadow: none;
		outline: none;
	}

	:global(.terminal-container.wterm) {
		overflow-x: hidden;
		overflow-y: auto;
	}

	:global(.terminal-container.wterm ::selection) {
		background: #27272a;
	}

	.terminal-container :global(.term-grid) {
		max-width: 100%;
		overflow: hidden;
	}
</style>
