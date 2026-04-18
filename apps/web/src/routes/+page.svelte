<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import type { SessionInfo } from '@webterm/protocol';
	import { Plus, TerminalSquare, X } from 'lucide-svelte';
	import Terminal from '$lib/components/Terminal.svelte';

	const terminalServerUrl = env.PUBLIC_TERMINAL_SERVER_URL || 'http://127.0.0.1:8787';

	type Tab = {
		sessionId: string;
		title: string;
	};

	let tabs = $state<Tab[]>([]);
	let activeSessionId = $state<string | null>(null);
	let errorMessage = $state<string | null>(null);
	let isCreating = $state(false);

	async function createTab() {
		if (isCreating) {
			return;
		}

		isCreating = true;
		errorMessage = null;

		try {
			const response = await fetch(`${terminalServerUrl}/api/sessions`, { method: 'POST' });

			if (!response.ok) {
				errorMessage = `Failed to create session (${response.status})`;
				return;
			}

			const session = (await response.json()) as SessionInfo;
			tabs = [...tabs, { sessionId: session.sessionId, title: 'terminal' }];
			activeSessionId = session.sessionId;
		} catch (error) {
			console.error('Failed to create terminal session', error);
			errorMessage = 'Failed to reach terminal server.';
		} finally {
			isCreating = false;
		}
	}

	async function closeTab(sessionId: string) {
		const previousTabs = tabs;
		const removedIndex = previousTabs.findIndex((tab) => tab.sessionId === sessionId);
		const remainingTabs = previousTabs.filter((tab) => tab.sessionId !== sessionId);

		tabs = remainingTabs;

		if (activeSessionId === sessionId) {
			const fallbackIndex = Math.max(0, removedIndex - 1);
			activeSessionId =
				remainingTabs[fallbackIndex]?.sessionId ?? remainingTabs[0]?.sessionId ?? null;
		}

		try {
			await fetch(`${terminalServerUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
		} catch (error) {
			console.error('Failed to close terminal session', error);
		}
	}

	function updateTabTitle(sessionId: string, nextTitle: string) {
		const tabIndex = tabs.findIndex((tab) => tab.sessionId === sessionId);

		if (tabIndex === -1) {
			return;
		}

		const cleanTitle = nextTitle.replace(/^.*:/, '').trim().toLowerCase() || 'terminal';
		tabs[tabIndex].title = cleanTitle;
	}

	onMount(() => {
		if (tabs.length === 0) {
			void createTab();
		}
	});
</script>

<svelte:head>
	<title>Webterm</title>
</svelte:head>

<div class="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 font-sans text-zinc-300">
	<header
		class="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-900 bg-zinc-950 px-2 select-none"
	>
		<div class="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto">
			{#each tabs as tab (tab.sessionId)}
				<div
					class="group flex h-8 max-w-[220px] min-w-[150px] items-center gap-1 rounded-md px-1 transition-colors {activeSessionId ===
					tab.sessionId
						? 'bg-zinc-900 text-zinc-100 shadow-sm'
						: 'text-zinc-500 hover:bg-zinc-900'}"
				>
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm"
						onclick={() => (activeSessionId = tab.sessionId)}
					>
						<TerminalSquare
							size={14}
							class={activeSessionId === tab.sessionId ? 'text-lime-400' : 'text-zinc-600'}
						/>
						<span class="truncate">{tab.title}</span>
					</button>
					<button
						type="button"
						class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition hover:bg-zinc-800 hover:text-zinc-200 {activeSessionId ===
						tab.sessionId
							? 'opacity-100'
							: 'opacity-0 group-hover:opacity-100'}"
						title="Close terminal"
						onclick={() => closeTab(tab.sessionId)}
					>
						<X size={12} />
					</button>
				</div>
			{/each}
		</div>

		<button
			type="button"
			class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-300 disabled:opacity-50"
			onclick={createTab}
			disabled={isCreating}
			title="New terminal"
		>
			<Plus size={16} />
		</button>
	</header>

	{#if errorMessage}
		<div class="border-b border-rose-950 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
			{errorMessage}
		</div>
	{/if}

	<main class="relative flex-1 overflow-hidden bg-zinc-950">
		{#if tabs.length === 0}
			<div class="flex h-full w-full flex-col items-center justify-center gap-4 text-zinc-600">
				<TerminalSquare size={40} strokeWidth={1.25} />
				<p class="text-sm">No active sessions</p>
				<button
					type="button"
					class="rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
					onclick={createTab}
				>
					New terminal
				</button>
			</div>
		{/if}

		{#each tabs as tab (tab.sessionId)}
			<div
				class="absolute inset-0 h-full w-full"
				style:z-index={activeSessionId === tab.sessionId ? 10 : 0}
				style:visibility={activeSessionId === tab.sessionId ? 'visible' : 'hidden'}
			>
				<Terminal
					sessionId={tab.sessionId}
					isActive={activeSessionId === tab.sessionId}
					onTitleChange={(title) => updateTabTitle(tab.sessionId, title)}
				/>
			</div>
		{/each}
	</main>
</div>

<style>
	/* Hide scrollbar for tab list */
	.no-scrollbar::-webkit-scrollbar {
		display: none;
	}
	.no-scrollbar {
		-ms-overflow-style: none;
		scrollbar-width: none;
	}
</style>
