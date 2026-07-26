export interface TmuxInstallGuide {
	platform: string;
	commands: string[];
	note: string;
}

export interface TmuxStatus {
	available: boolean;
	version: string | null;
	install: TmuxInstallGuide;
}
