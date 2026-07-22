import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerKiroSteering, {
	expandNamedSteeringReferences,
	renderSteeringPrompt,
} from "../src/index.js";
import { parseSteering } from "../src/steering.js";

interface MockPi {
	handlers: Map<string, (...args: any[]) => any>;
	commands: Map<string, any>;
	sentMessages: any[];
	sentUserMessages: any[];
	api: ExtensionAPI;
}

function createMockPi(): MockPi {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const sentMessages: any[] = [];
	const sentUserMessages: any[] = [];
	const api = {
		on: vi.fn((event: string, handler: (...args: any[]) => any) =>
			handlers.set(event, handler),
		),
		registerCommand: vi.fn((name: string, command: any) =>
			commands.set(name, command),
		),
		sendMessage: vi.fn((message: any, options: any) =>
			sentMessages.push({ message, options }),
		),
		sendUserMessage: vi.fn((message: any) => sentUserMessages.push(message)),
	} as unknown as ExtensionAPI;
	return { handlers, commands, sentMessages, sentUserMessages, api };
}

function fixtureFile(
	fileName: string,
	source: string,
	scope: "global" | "workspace" = "workspace",
) {
	return parseSteering(source, {
		absolutePath: `/workspace/.kiro/steering/${fileName}.md`,
		displayPath: `.kiro/steering/${fileName}.md`,
		scope,
	});
}

describe("renderSteeringPrompt", () => {
	it("includes always content and only metadata for conditional steering", async () => {
		const files = [
			fixtureFile("project", "Always body"),
			fixtureFile(
				"react",
				'---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\nReact body',
			),
			fixtureFile(
				"api",
				"---\ninclusion: auto\nname: api-design\ndescription: Use when designing APIs\n---\nAPI body",
			),
			fixtureFile("review", "---\ninclusion: manual\n---\nReview body"),
		];

		const prompt = await renderSteeringPrompt(files, "/workspace");

		expect(prompt).toContain("Always body");
		expect(prompt).toContain("**/*.tsx");
		expect(prompt).toContain("api-design: Use when designing APIs");
		expect(prompt).not.toContain("React body");
		expect(prompt).not.toContain("API body");
		expect(prompt).not.toContain("Review body");
	});
});

describe("expandNamedSteeringReferences", () => {
	it("replaces known manual and auto #names without touching unrelated hashtags", async () => {
		const files = [
			fixtureFile("review", "---\ninclusion: manual\n---\nReview body"),
			fixtureFile(
				"api",
				"---\ninclusion: auto\nname: api-design\ndescription: API rules\n---\nAPI body",
			),
		];

		const expanded = await expandNamedSteeringReferences(
			"Use #review and #api-design but keep #123",
			files,
			"/workspace",
		);

		expect(expanded).toContain("Review body");
		expect(expanded).toContain("API body");
		expect(expanded).toContain("#123");
	});
});

describe("Pi extension integration", () => {
	it("loads trusted steering, expands manual references, and activates fileMatch before writes", async () => {
		const root = await import("node:fs/promises").then(({ mkdtemp }) =>
			mkdtemp(join(process.env.TMPDIR ?? "/tmp", "pi-steering-ext-")),
		);
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		await mkdir(join(home, ".kiro/steering"), { recursive: true });
		await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
		await writeFile(join(home, ".kiro/steering/global.md"), "Global body");
		await writeFile(
			join(workspace, ".kiro/steering/review.md"),
			"---\ninclusion: manual\n---\nReview body",
		);
		await writeFile(
			join(workspace, ".kiro/steering/react.md"),
			'---\ninclusion: fileMatch\nfileMatchPattern: "**/*.tsx"\n---\nReact body',
		);

		const mock = createMockPi();
		registerKiroSteering(mock.api, { homeDir: home });
		const ctx = {
			cwd: workspace,
			isProjectTrusted: () => true,
			ui: { notify: vi.fn() },
		} as any;

		await mock.handlers.get("session_start")?.({}, ctx);
		const beforeResult = await mock.handlers.get("before_agent_start")?.(
			{ systemPrompt: "BASE", prompt: "Update Button.tsx" },
			ctx,
		);
		expect(beforeResult.systemPrompt).toContain("Global body");

		const inputResult = await mock.handlers.get("input")?.(
			{ source: "interactive", text: "Use #review" },
			ctx,
		);
		expect(inputResult.text).toContain("Review body");

		const firstEdit = await mock.handlers.get("tool_call")?.(
			{ toolName: "edit", input: { path: "src/Button.tsx" } },
			ctx,
		);
		expect(firstEdit).toMatchObject({ block: true });
		expect(mock.sentMessages.at(-1)?.message.content).toContain("React body");

		await mock.handlers.get("turn_start")?.({}, ctx);
		const retryEdit = await mock.handlers.get("tool_call")?.(
			{ toolName: "edit", input: { path: "src/Button.tsx" } },
			ctx,
		);
		expect(retryEdit).toBeUndefined();

		expect(mock.commands.has("steering")).toBe(true);
		await mock.commands
			.get("steering")
			.handler("review Check this change", ctx);
		expect(mock.sentUserMessages.at(-1)).toContain("Review body");

		await import("node:fs/promises").then(({ rm }) =>
			rm(root, { recursive: true }),
		);
	});
});
