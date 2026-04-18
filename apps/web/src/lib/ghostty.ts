import { init } from 'ghostty-web';

let ghosttyInitPromise: Promise<void> | null = null;

export const ensureGhosttyInitialized = () => {
	ghosttyInitPromise ??= init();
	return ghosttyInitPromise;
};
