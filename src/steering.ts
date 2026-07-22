import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";

export type SteeringInclusion = "always" | "fileMatch" | "manual" | "auto";
export type SteeringScope = "global" | "workspace";

export interface SteeringFile {
	absolutePath: string;
	displayPath: string;
	scope: SteeringScope;
	name: string;
	inclusion: SteeringInclusion;
	patterns: string[];
	description?: string;
	body: string;
}

export interface SteeringLocation {
	absolutePath: string;
	displayPath: string;
	scope: SteeringScope;
}

export interface DiscoveryResult {
	files: SteeringFile[];
	errors: string[];
}

const INCLUSION_MODES = new Set<SteeringInclusion>([
	"always",
	"fileMatch",
	"manual",
	"auto",
]);
const FILE_REFERENCE_PATTERN = /#\[\[file:([^\]]+)\]\]/g;
const DEFAULT_REFERENCE_LIMIT = 50 * 1024;

export function parseSteering(
	source: string,
	location: SteeringLocation,
): SteeringFile {
	const { frontmatter, body } = splitFrontmatter(source);
	const rawInclusion = frontmatter.inclusion ?? "always";

	if (
		typeof rawInclusion !== "string" ||
		!INCLUSION_MODES.has(rawInclusion as SteeringInclusion)
	) {
		throw new Error(`unsupported inclusion mode: ${String(rawInclusion)}`);
	}

	const inclusion = rawInclusion as SteeringInclusion;
	const fileName = basename(location.absolutePath, ".md");
	const patterns = parsePatterns(frontmatter.fileMatchPattern);

	if (inclusion === "fileMatch" && patterns.length === 0) {
		throw new Error("fileMatch steering requires fileMatchPattern");
	}

	const autoName = frontmatter.name;
	const description = frontmatter.description;
	if (inclusion === "auto") {
		if (typeof autoName !== "string" || autoName.trim() === "") {
			throw new Error("auto steering requires name");
		}
		if (typeof description !== "string" || description.trim() === "") {
			throw new Error("auto steering requires description");
		}
	}

	return {
		...location,
		name: inclusion === "auto" ? (autoName as string).trim() : fileName,
		inclusion,
		patterns,
		description:
			typeof description === "string" ? description.trim() : undefined,
		body,
	};
}

export async function discoverSteering(options: {
	homeDir: string;
	workspaceRoot: string;
	trusted: boolean;
}): Promise<DiscoveryResult> {
	const locations: Array<{
		directory: string;
		prefix: string;
		scope: SteeringScope;
	}> = [
		{
			directory: join(options.homeDir, ".kiro", "steering"),
			prefix: "~/.kiro/steering",
			scope: "global",
		},
	];

	if (options.trusted) {
		locations.push({
			directory: join(options.workspaceRoot, ".kiro", "steering"),
			prefix: ".kiro/steering",
			scope: "workspace",
		});
	}

	const files: SteeringFile[] = [];
	const errors: string[] = [];

	for (const location of locations) {
		for (const relativePath of await findMarkdownFiles(location.directory)) {
			const absolutePath = join(location.directory, relativePath);
			const displayPath = `${location.prefix}/${toPosixPath(relativePath)}`;
			try {
				files.push(
					parseSteering(await readFile(absolutePath, "utf8"), {
						absolutePath,
						displayPath,
						scope: location.scope,
					}),
				);
			} catch (error) {
				errors.push(
					`${displayPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	return { files, errors };
}

export function findNamedSteering(
	files: SteeringFile[],
	name: string,
): SteeringFile | undefined {
	let match: SteeringFile | undefined;
	for (const file of files) {
		if (file.name === name) match = file;
	}
	return match;
}

export function matchFileSteering(
	files: SteeringFile[],
	targetPath: string,
	workspaceRoot: string,
): SteeringFile[] {
	const absoluteTarget = resolve(workspaceRoot, targetPath);
	const relativeTarget = relative(workspaceRoot, absoluteTarget);
	if (
		relativeTarget === "" ||
		relativeTarget === ".." ||
		relativeTarget.startsWith(`..${sep}`) ||
		isAbsolute(relativeTarget)
	) {
		return [];
	}

	const normalizedTarget = toPosixPath(relativeTarget);
	return files.filter(
		(file) =>
			file.inclusion === "fileMatch" &&
			file.patterns.some((pattern) =>
				minimatch(normalizedTarget, pattern, { dot: true, matchBase: true }),
			),
	);
}

export async function expandFileReferences(
	body: string,
	workspaceRoot: string,
	maxBytes = DEFAULT_REFERENCE_LIMIT,
): Promise<string> {
	const matches = [...body.matchAll(FILE_REFERENCE_PATTERN)];
	if (matches.length === 0) return body;

	let result = "";
	let cursor = 0;
	for (const match of matches) {
		const index = match.index ?? 0;
		result += body.slice(cursor, index);
		result += await expandReference(match[1].trim(), workspaceRoot, maxBytes);
		cursor = index + match[0].length;
	}
	return result + body.slice(cursor);
}

function splitFrontmatter(source: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
		return { frontmatter: {}, body: source };
	}

	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new Error("frontmatter is not closed");

	const parsed = parseYaml(match[1]);
	if (
		parsed !== null &&
		(typeof parsed !== "object" || Array.isArray(parsed))
	) {
		throw new Error("frontmatter must be a YAML mapping");
	}

	return {
		frontmatter: (parsed ?? {}) as Record<string, unknown>,
		body: source.slice(match[0].length),
	};
}

function parsePatterns(value: unknown): string[] {
	if (typeof value === "string" && value.trim() !== "") return [value];
	if (
		Array.isArray(value) &&
		value.every((item) => typeof item === "string" && item.trim() !== "")
	) {
		return value;
	}
	return [];
}

async function findMarkdownFiles(
	directory: string,
	prefix = "",
): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}

	const files: string[] = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const relativePath = prefix ? join(prefix, entry.name) : entry.name;
		if (entry.isDirectory())
			files.push(
				...(await findMarkdownFiles(join(directory, entry.name), relativePath)),
			);
		else if (entry.isFile() && entry.name.endsWith(".md"))
			files.push(relativePath);
	}
	return files;
}

async function expandReference(
	reference: string,
	workspaceRoot: string,
	maxBytes: number,
): Promise<string> {
	if (isAbsolute(reference))
		return `[Kiro file reference rejected: ${reference} is outside the workspace]`;

	const absolutePath = resolve(workspaceRoot, reference);
	const relativePath = relative(workspaceRoot, absolutePath);
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return `[Kiro file reference rejected: ${reference} is outside the workspace]`;
	}

	try {
		const fileStats = await stat(absolutePath);
		if (!fileStats.isFile())
			return `[Kiro file reference unavailable: ${reference} is not a file]`;
		const content = await readFile(absolutePath);
		const truncated = content.byteLength > maxBytes;
		const text = content.subarray(0, maxBytes).toString("utf8");
		const suffix = truncated ? `\n[truncated after ${maxBytes} bytes]` : "";
		return `<kiro-file-reference path=${JSON.stringify(toPosixPath(relativePath))}>\n${text}${suffix}\n</kiro-file-reference>`;
	} catch (error) {
		const message =
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? "not found"
				: "unreadable";
		return `[Kiro file reference unavailable: ${reference} ${message}]`;
	}
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}
