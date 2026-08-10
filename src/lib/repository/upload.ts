export type WorkspaceUploadCandidate = {
	file: File;
	relativePath: string;
};

export type WorkspaceUploadSelection = {
	candidates: WorkspaceUploadCandidate[];
	skippedGitFiles: number;
};

export class WorkspaceUploadSelectionError extends Error {}

function normalizeUploadPath(path: string): string {
	const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
	const segments = normalized.split('/').filter(Boolean);
	if (
		segments.length === 0
		|| segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\0'))
	) {
		throw new WorkspaceUploadSelectionError('One of the selected files has an invalid path.');
	}
	return segments.join('/');
}

function isGitMetadataPath(path: string): boolean {
	return path.split('/').some((segment) => segment.toLowerCase() === '.git');
}

function validateUploadSelection(candidates: WorkspaceUploadCandidate[]): WorkspaceUploadSelection {
	const validCandidates: WorkspaceUploadCandidate[] = [];
	let skippedGitFiles = 0;

	for (const candidate of candidates) {
		const relativePath = normalizeUploadPath(candidate.relativePath);
		if (isGitMetadataPath(relativePath)) {
			skippedGitFiles += 1;
			continue;
		}
		validCandidates.push({ file: candidate.file, relativePath });
	}

	if (validCandidates.length === 0) {
		throw new WorkspaceUploadSelectionError(
			skippedGitFiles > 0 ? 'Git metadata cannot be added.' : 'Choose at least one file.'
		);
	}
	return { candidates: validCandidates, skippedGitFiles };
}

export function uploadSelectionFromFiles(files: Iterable<File>): WorkspaceUploadSelection {
	return validateUploadSelection(Array.from(files, (file) => ({
		file,
		relativePath: file.webkitRelativePath || file.name
	})));
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function directoryEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
	const reader = entry.createReader();
	const entries: FileSystemEntry[] = [];
	while (true) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (batch.length === 0) return entries;
		entries.push(...batch);
	}
}

async function collectEntry(
	entry: FileSystemEntry,
	parentPath: string,
	candidates: WorkspaceUploadCandidate[]
): Promise<void> {
	const relativePath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
	if (entry.isFile) {
		candidates.push({ file: await fileFromEntry(entry as FileSystemFileEntry), relativePath });
		return;
	}
	if (!entry.isDirectory) return;
	for (const child of await directoryEntries(entry as FileSystemDirectoryEntry)) {
		await collectEntry(child, relativePath, candidates);
	}
}

export async function uploadSelectionFromDataTransfer(dataTransfer: DataTransfer): Promise<WorkspaceUploadSelection> {
	const candidates: WorkspaceUploadCandidate[] = [];
	for (const item of Array.from(dataTransfer.items)) {
		if (item.kind !== 'file') continue;
		const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
		if (entry) {
			await collectEntry(entry, '', candidates);
			continue;
		}
		const file = item.getAsFile();
		if (file) candidates.push({ file, relativePath: file.name });
	}
	if (candidates.length === 0) {
		for (const file of Array.from(dataTransfer.files)) {
			candidates.push({ file, relativePath: file.name });
		}
	}
	return validateUploadSelection(candidates);
}

export function dataTransferHasUploadFiles(dataTransfer: DataTransfer | null): boolean {
	return Boolean(dataTransfer && Array.from(dataTransfer.types).includes('Files'));
}

export function workspaceUploadPath(directory: string, relativePath: string): string {
	const normalizedDirectory = directory ? normalizeUploadPath(directory) : '';
	const normalizedRelativePath = normalizeUploadPath(relativePath);
	return normalizedDirectory ? `${normalizedDirectory}/${normalizedRelativePath}` : normalizedRelativePath;
}
