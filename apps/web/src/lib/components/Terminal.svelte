<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { FitAddon, Terminal } from 'ghostty-web';
	import { parseServerEvent } from '@webterm/protocol';
	import { ensureGhosttyInitialized } from '$lib/ghostty';

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
	let term: InstanceType<typeof Terminal>;
	let fitAddon: FitAddon;
	let socket: WebSocket | null = null;
	let hasExited = false;
	let isFocused = false;

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

	const toWebSocketUrl = (serverUrl: string, currentSessionId: string) => {
		const wsBase = serverUrl
			.replace(/^http:/, 'ws:')
			.replace(/^https:/, 'wss:')
			.replace(/\/$/, '');
		return `${wsBase}/api/sessions/${currentSessionId}/ws`;
	};

	const sendResize = () => {
		if (socket?.readyState === WebSocket.OPEN && term.cols && term.rows) {
			socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
		}
	};

	const writeSystemMessage = (message: string) => {
		term.writeln(`\x1b[3m${message}\x1b[0m`);
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
			await ensureGhosttyInitialized();

			if (cancelled) {
				return;
			}

			term = new Terminal({
				fontFamily: terminalFontFamily,
				fontSize: 14,
				cursorBlink: true,
				theme: {
					background: '#09090b',
					foreground: '#f4f4f5',
					cursor: '#d4d4d8',
					selectionBackground: '#27272a',
					black: '#18181b',
					red: '#ef4444',
					green: '#22c55e',
					yellow: '#eab308',
					blue: '#3b82f6',
					magenta: '#d946ef',
					cyan: '#06b6d4',
					white: '#f4f4f5',
					brightBlack: '#52525b',
					brightRed: '#f87171',
					brightGreen: '#4ade80',
					brightYellow: '#fde047',
					brightBlue: '#60a5fa',
					brightMagenta: '#e879f9',
					brightCyan: '#22d3ee',
					brightWhite: '#fafafa'
				}
			});

			fitAddon = new FitAddon();
			term.loadAddon(fitAddon);
			term.open(terminalContainer);
			terminalContainer.style.caretColor = 'transparent';

			// Fit immediately (like the official ghostty-web demo).
			fitAddon.fit();

			// Use ghostty-web's built-in resize observer (debounced, watches
			// term.element). This replaces our manual ResizeObserver.
			fitAddon.observeResize();

			// Backup: window resize doesn't always trigger ResizeObserver on
			// every browser.
			window.addEventListener('resize', handleWindowResize);

			void document.fonts.ready.then(() => {
				if (cancelled) {
					return;
				}

				fitAddon.fit();
				sendResize();

				if (isActive) {
					term.focus();
				}
			});

			term.onTitleChange((title) => onTitleChange?.(title));
			terminalContainer.addEventListener('focusin', handleTerminalFocusIn);
			terminalContainer.addEventListener('focusout', handleTerminalFocusOut);
			terminalContainer.addEventListener('pointerdown', handleTerminalPointerDown);

			const wsUrl = toWebSocketUrl(terminalServerUrl, sessionId);
			socket = new WebSocket(wsUrl);

			socket.onopen = () => {
				socket?.send(
					JSON.stringify({
						type: 'attach',
						sessionId,
						cols: term.cols,
						rows: term.rows
					})
				);
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
							fitAddon.fit();
							sendResize();
							if (isActive) {
								term.focus();
							}
							return;

						case 'output':
							term.write(message.data);
							return;

						case 'error':
							writeSystemMessage(`[server] ${message.message}`);
							return;

						case 'exit':
							hasExited = true;
							writeSystemMessage(
								`[process exited with code ${message.exitCode ?? 'null'}]`
							);
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

			term.onData((data) => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'input', data }));
				}
			});

			term.onResize(({ cols, rows }) => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'resize', cols, rows }));
				}
			});
		})();

		return () => {
			cancelled = true;
		};
	});

	const handleWindowResize = () => {
		if (isActive && fitAddon) {
			fitAddon.fit();
		}
	};

	$effect(() => {
		if (isActive && fitAddon && term) {
			fitAddon.fit();
			sendResize();
			term.focus();
		}
	});

	onDestroy(() => {
		terminalContainer?.removeEventListener('focusin', handleTerminalFocusIn);
		terminalContainer?.removeEventListener('focusout', handleTerminalFocusOut);
		terminalContainer?.removeEventListener('pointerdown', handleTerminalPointerDown);
		window?.removeEventListener('resize', handleWindowResize);
		releaseKeyboardLock();
		fitAddon?.dispose();
		socket?.close();
		term?.dispose();
	});
</script>

<div
	bind:this={terminalContainer}
	class="terminal-container"
	style:visibility={isActive ? 'visible' : 'hidden'}
></div>

<style>
	.terminal-container {
		position: absolute;
		inset: 0;
		overflow: hidden;
		padding: 10px 12px;
	}
	.terminal-container :global(canvas) {
		display: block;
		outline: none;
	}
	:global(.terminal-container[contenteditable='true']) {
		caret-color: transparent;
	}
	.terminal-container :global(textarea[aria-label='Terminal input']) {
		caret-color: transparent;
		color: transparent;
	}
</style>
