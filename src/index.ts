import { homedir } from "node:os";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	MessageRenderOptions,
	SessionStartEvent,
	Theme,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	discoverSteering,
	expandFileReferences,
	matchFileSteering,
	type SteeringFile,
} from "./steering.js";

const KIRO_STEERING_TYPE = "kiro-steering";

interface ExtensionOptions {
	homeDir?: string;
}

interface SteeringRuntime {
	pi: ExtensionAPI;
	homeDir: string;
	files: SteeringFile[];
	workspaceRoot: string;
	activeFileRules: Set<string>;
	pendingFileRules: Set<string>;
}

interface KiroSteeringDetails {
	steeringFiles: string[];
	targetPath?: string;
	names?: string[];
}

export default function registerKiroSteering(
	pi: ExtensionAPI,
	options: ExtensionOptions = {},
): void {
	const runtime: SteeringRuntime = {
		pi,
		homeDir: options.homeDir ?? homedir(),
		files: [],
		workspaceRoot: "",
		activeFileRules: new Set(),
		pendingFileRules: new Set(),
	};

	pi.registerMessageRenderer(
		KIRO_STEERING_TYPE,
		(
			message: { details?: KiroSteeringDetails },
			_options: MessageRenderOptions,
			theme: Theme,
		) => {
			const details = message.details;
			const files = details?.steeringFiles ?? [];
			const label = theme.fg("customMessageLabel", `[${KIRO_STEERING_TYPE}]`);
			const lines = [label];

			if (details?.targetPath) {
				lines.push(
					theme.fg("customMessageText", `activated for ${details.targetPath}`),
				);
			}

			if (files.length > 0) {
				for (const file of files) {
					lines.push(theme.fg("customMessageText", file));
				}
			} else if (details?.names && details.names.length > 0) {
				for (const name of details.names) {
					lines.push(theme.fg("customMessageText", name));
				}
			} else {
				lines.push(theme.fg("dim", "(no files)"));
			}

			const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
			box.addChild(new Text(lines.join("\n"), 0, 0));
			return box;
		},
	);

	pi.on(
		"session_start",
		async (_event: SessionStartEvent, ctx: ExtensionContext) =>
			startSession(runtime, ctx),
	);
	pi.on(
		"before_agent_start",
		async (event: BeforeAgentStartEvent, ctx: ExtensionContext) =>
			addSteeringPrompt(runtime, event.systemPrompt, ctx),
	);
	pi.on("input", async (event: InputEvent, ctx: ExtensionContext) =>
		expandInput(runtime, event.source, event.text, ctx),
	);
	pi.on("turn_start", () => activatePendingRules(runtime));
	pi.on("tool_call", async (event: ToolCallEvent) =>
		activateMatchingRules(runtime, event.toolName, event.input),
	);

	pi.registerCommand("steering", {
		description: "Include a manual or auto Kiro steering file",
		getArgumentCompletions: (prefix: string) =>
			completeSteeringName(runtime.files, prefix),
		handler: async (args: string, ctx: ExtensionContext) =>
			runSteeringCommand(runtime, args, ctx),
	});
}

async function refresh(
	runtime: SteeringRuntime,
	ctx: ExtensionContext,
): Promise<string[]> {
	runtime.workspaceRoot = ctx.cwd;
	const result = await discoverSteering({
		homeDir: runtime.homeDir,
		workspaceRoot: runtime.workspaceRoot,
		trusted: ctx.isProjectTrusted(),
	});
	runtime.files = result.files;
	return result.errors;
}

async function startSession(
	runtime: SteeringRuntime,
	ctx: ExtensionContext,
): Promise<void> {
	runtime.activeFileRules.clear();
	runtime.pendingFileRules.clear();
	const errors = await refresh(runtime, ctx);
	if (runtime.files.length > 0)
		ctx.ui.notify(
			`Loaded ${runtime.files.length} Kiro steering file(s)`,
			"info",
		);
	if (errors.length > 0)
		ctx.ui.notify(
			`Skipped invalid Kiro steering:\n${errors.join("\n")}`,
			"warning",
		);
}

async function addSteeringPrompt(
	runtime: SteeringRuntime,
	systemPrompt: string,
	ctx: ExtensionContext,
) {
	await refresh(runtime, ctx);
	const steeringPrompt = await renderSteeringPrompt(
		runtime.files,
		runtime.workspaceRoot,
	);
	if (steeringPrompt === "") return;
	return { systemPrompt: `${systemPrompt}\n\n${steeringPrompt}` };
}

async function expandInput(
	runtime: SteeringRuntime,
	source: string,
	text: string,
	ctx: ExtensionContext,
) {
	if (source === "extension") return { action: "continue" as const };
	await refresh(runtime, ctx);
	const referenced = collectNamedSteeringReferences(text, runtime.files);
	if (referenced.length === 0) return { action: "continue" as const };

	// Keep the user-visible text short (#name). Inject full bodies as a
	// compact custom message so the TUI only shows file names.
	const rendered = await Promise.all(
		referenced.map((file) => renderSteeringFile(file, runtime.workspaceRoot)),
	);
	const content = rendered.join("\n\n");
	await sendSteeringMessage(runtime, content, {
		steeringFiles: referenced.map((file) => file.displayPath),
		names: referenced.map((file) => file.name),
	});
	return { action: "continue" as const };
}

function activatePendingRules(runtime: SteeringRuntime): void {
	for (const path of runtime.pendingFileRules)
		runtime.activeFileRules.add(path);
	runtime.pendingFileRules.clear();
}

async function activateMatchingRules(
	runtime: SteeringRuntime,
	toolName: string,
	input: unknown,
) {
	const path = toolPath(input);
	if (path === undefined) return;

	const inactiveRules: SteeringFile[] = [];
	for (const file of matchFileSteering(
		runtime.files,
		path,
		runtime.workspaceRoot,
	)) {
		if (!runtime.activeFileRules.has(file.absolutePath))
			inactiveRules.push(file);
	}
	if (inactiveRules.length === 0) return;

	const newlyPending: SteeringFile[] = [];
	for (const file of inactiveRules) {
		if (!runtime.pendingFileRules.has(file.absolutePath))
			newlyPending.push(file);
	}
	if (newlyPending.length > 0) {
		for (const file of newlyPending)
			runtime.pendingFileRules.add(file.absolutePath);
		await sendSteeringMessage(
			runtime,
			await renderActivatedRules(newlyPending, runtime.workspaceRoot, path),
			{
				targetPath: path,
				steeringFiles: newlyPending.map((file) => file.displayPath),
			},
			{ deliverAs: "steer" },
		);
	}

	if (toolName === "edit" || toolName === "write") {
		return {
			block: true as const,
			reason: `Kiro fileMatch steering was added for ${path}. Retry this mutation on the next turn.`,
		};
	}
}

function completeSteeringName(files: SteeringFile[], prefix: string) {
	const items: Array<{ value: string; label: string; description?: string }> =
		[];
	for (const file of namedSteeringByName(files).values()) {
		if (file.name.startsWith(prefix)) {
			items.push({
				value: file.name,
				label: file.name,
				description: file.description,
			});
		}
	}
	return items.length > 0 ? items : null;
}

async function runSteeringCommand(
	runtime: SteeringRuntime,
	args: string,
	ctx: ExtensionContext,
): Promise<void> {
	await refresh(runtime, ctx);
	const trimmed = args.trim();
	const name = trimmed.split(/\s+/, 1)[0];
	const available = namedSteeringByName(runtime.files);

	if (name === "") {
		const names = [...available.keys()].join(", ");
		ctx.ui.notify(
			names === ""
				? "No manual or auto Kiro steering files found"
				: `Kiro steering: ${names}`,
			"info",
		);
		return;
	}

	const file = available.get(name);
	if (file === undefined) {
		ctx.ui.notify(`Unknown Kiro steering: ${name}`, "warning");
		return;
	}

	const request = trimmed.slice(name.length).trim();
	const content = await renderSteeringFile(file, runtime.workspaceRoot);
	const message =
		request === "" ? content : `${content}\n\nUser request: ${request}`;
	await sendSteeringMessage(
		runtime,
		message,
		{
			steeringFiles: [file.displayPath],
			names: [file.name],
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
}

export async function renderSteeringPrompt(
	files: SteeringFile[],
	workspaceRoot: string,
): Promise<string> {
	if (files.length === 0) return "";

	const sections = [
		"## Kiro Steering",
		"These instructions come from Kiro steering files. Workspace steering has priority over conflicting global steering.",
	];
	const alwaysFiles = files.filter((file) => file.inclusion === "always");
	if (alwaysFiles.length > 0) {
		sections.push(
			"### Always included",
			...(await Promise.all(
				alwaysFiles.map((file) => renderSteeringFile(file, workspaceRoot)),
			)),
		);
	}

	const fileMatchFiles = files.filter((file) => file.inclusion === "fileMatch");
	if (fileMatchFiles.length > 0) {
		sections.push(
			"### Conditional file steering",
			"Before working with a matching file, load and follow its steering file. The extension also activates these rules when file tools expose a matching path.",
			...fileMatchFiles.map(
				(file) =>
					`- ${file.absolutePath} → ${file.patterns.map((pattern) => JSON.stringify(pattern)).join(", ")}`,
			),
		);
	}

	const namedFiles = [...namedSteeringByName(files).values()];
	const autoFiles = namedFiles.filter((file) => file.inclusion === "auto");
	if (autoFiles.length > 0) {
		sections.push(
			"### Auto steering",
			"When the request matches a description below, read the listed steering file before proceeding.",
			...autoFiles.map(
				(file) => `- ${file.name}: ${file.description} (${file.absolutePath})`,
			),
		);
	}

	const manualFiles = namedFiles.filter((file) => file.inclusion === "manual");
	if (manualFiles.length > 0) {
		sections.push(
			"### Manual steering",
			`Available through #name or /steering <name>: ${manualFiles.map((file) => file.name).join(", ")}`,
		);
	}

	return sections.join("\n\n");
}

export async function expandNamedSteeringReferences(
	text: string,
	files: SteeringFile[],
	workspaceRoot: string,
): Promise<string> {
	const namedFiles = namedSteeringByName(files);
	const matches = [...text.matchAll(/#([A-Za-z0-9][A-Za-z0-9-]*)/g)].filter(
		(match) => namedFiles.has(match[1]),
	);
	if (matches.length === 0) return text;

	let result = "";
	let cursor = 0;
	for (const match of matches) {
		const file = namedFiles.get(match[1]);
		if (file === undefined) continue;
		const index = match.index ?? 0;
		result += text.slice(cursor, index);
		result += await renderSteeringFile(file, workspaceRoot);
		cursor = index + match[0].length;
	}
	return result + text.slice(cursor);
}

/** Collect named steering references in text without expanding bodies. */
export function collectNamedSteeringReferences(
	text: string,
	files: SteeringFile[],
): SteeringFile[] {
	const namedFiles = namedSteeringByName(files);
	const found = new Map<string, SteeringFile>();
	for (const match of text.matchAll(/#([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
		const file = namedFiles.get(match[1]);
		if (file !== undefined) found.set(file.name, file);
	}
	return [...found.values()];
}

async function renderActivatedRules(
	files: SteeringFile[],
	workspaceRoot: string,
	targetPath: string,
): Promise<string> {
	const rendered = await Promise.all(
		files.map((file) => renderSteeringFile(file, workspaceRoot)),
	);
	return `Kiro fileMatch steering activated for ${targetPath}:\n\n${rendered.join("\n\n")}`;
}

async function renderSteeringFile(
	file: SteeringFile,
	workspaceRoot: string,
): Promise<string> {
	const body = await expandFileReferences(file.body, workspaceRoot);
	return `<kiro-steering scope=${JSON.stringify(file.scope)} file=${JSON.stringify(file.displayPath)}>\n${body}\n</kiro-steering>`;
}

async function sendSteeringMessage(
	runtime: SteeringRuntime,
	content: string,
	details: KiroSteeringDetails,
	options?: {
		deliverAs?: "steer" | "followUp" | "nextTurn";
		triggerTurn?: boolean;
	},
): Promise<void> {
	runtime.pi.sendMessage(
		{
			customType: KIRO_STEERING_TYPE,
			content,
			display: true,
			details,
		},
		options,
	);
}

function namedSteeringByName(files: SteeringFile[]): Map<string, SteeringFile> {
	const byName = new Map<string, SteeringFile>();
	for (const file of files) {
		if (file.inclusion === "manual" || file.inclusion === "auto")
			byName.set(file.name, file);
	}
	return byName;
}

function toolPath(input: unknown): string | undefined {
	if (input === null || typeof input !== "object") return undefined;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" ? path.replace(/^@/, "") : undefined;
}
