import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	discoverSteering,
	expandFileReferences,
	findNamedSteering,
	matchFileSteering,
	parseSteering,
} from "../src/steering.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-steering-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	const { rm } = await import("node:fs/promises");
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("parseSteering", () => {
	it("treats a markdown file without frontmatter as always included", () => {
		const steering = parseSteering("# Project rules\n\nUse pnpm.\n", {
			absolutePath: "/workspace/.kiro/steering/project.md",
			displayPath: ".kiro/steering/project.md",
			scope: "workspace",
		});

		expect(steering.inclusion).toBe("always");
		expect(steering.name).toBe("project");
		expect(steering.body).toBe("# Project rules\n\nUse pnpm.\n");
	});

	it("parses fileMatch arrays only when frontmatter starts at the first byte", () => {
		const steering = parseSteering(
			'---\ninclusion: fileMatch\nfileMatchPattern: ["**/*.ts", "**/*.tsx"]\n---\n# TypeScript rules\n',
			{
				absolutePath: "/workspace/.kiro/steering/typescript.md",
				displayPath: ".kiro/steering/typescript.md",
				scope: "workspace",
			},
		);

		expect(steering.inclusion).toBe("fileMatch");
		expect(steering.patterns).toEqual(["**/*.ts", "**/*.tsx"]);
		expect(steering.body).toBe("# TypeScript rules\n");
	});

	it("rejects auto steering without its required name and description", () => {
		expect(() =>
			parseSteering("---\ninclusion: auto\nname: api-design\n---\nRules", {
				absolutePath: "/workspace/.kiro/steering/api.md",
				displayPath: ".kiro/steering/api.md",
				scope: "workspace",
			}),
		).toThrow("description");
	});
});

describe("discoverSteering", () => {
	it("discovers nested global and trusted workspace markdown files", async () => {
		const root = await makeTemporaryDirectory();
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		await mkdir(join(home, ".kiro/steering/shared"), { recursive: true });
		await mkdir(join(workspace, ".kiro/steering/frontend"), {
			recursive: true,
		});
		await writeFile(
			join(home, ".kiro/steering/shared/review.md"),
			"Global review",
		);
		await writeFile(
			join(workspace, ".kiro/steering/frontend/review.md"),
			"Workspace review",
		);
		await writeFile(join(workspace, ".kiro/steering/ignored.txt"), "Ignored");

		const result = await discoverSteering({
			homeDir: home,
			workspaceRoot: workspace,
			trusted: true,
		});

		expect(result.errors).toEqual([]);
		expect(
			result.files.map((file) => `${file.scope}:${file.displayPath}`),
		).toEqual([
			"global:~/.kiro/steering/shared/review.md",
			"workspace:.kiro/steering/frontend/review.md",
		]);
		expect(findNamedSteering(result.files, "review")?.scope).toBe("workspace");
	});

	it("does not read workspace steering for an untrusted project", async () => {
		const root = await makeTemporaryDirectory();
		const home = join(root, "home");
		const workspace = join(root, "workspace");
		await mkdir(join(home, ".kiro/steering"), { recursive: true });
		await mkdir(join(workspace, ".kiro/steering"), { recursive: true });
		await writeFile(join(home, ".kiro/steering/global.md"), "Global");
		await writeFile(
			join(workspace, ".kiro/steering/workspace.md"),
			"Workspace",
		);

		const result = await discoverSteering({
			homeDir: home,
			workspaceRoot: workspace,
			trusted: false,
		});

		expect(result.files.map((file) => file.name)).toEqual(["global"]);
	});
});

describe("matchFileSteering", () => {
	it("matches Kiro glob patterns against workspace-relative paths", () => {
		const steering = parseSteering(
			'---\ninclusion: fileMatch\nfileMatchPattern: "*.tsx"\n---\nReact rules',
			{
				absolutePath: "/workspace/.kiro/steering/react.md",
				displayPath: ".kiro/steering/react.md",
				scope: "workspace",
			},
		);

		expect(
			matchFileSteering([steering], "/workspace/src/Button.tsx", "/workspace"),
		).toEqual([steering]);
		expect(
			matchFileSteering([steering], "/workspace/src/button.ts", "/workspace"),
		).toEqual([]);
		expect(
			matchFileSteering([steering], "/outside/Button.tsx", "/workspace"),
		).toEqual([]);
	});
});

describe("expandFileReferences", () => {
	it("inlines live workspace file references", async () => {
		const workspace = await makeTemporaryDirectory();
		await mkdir(join(workspace, "docs"));
		await writeFile(join(workspace, "docs/api.md"), "# API contract\n");

		const expanded = await expandFileReferences(
			"Follow #[[file:docs/api.md]]",
			workspace,
		);

		expect(expanded).toContain('<kiro-file-reference path="docs/api.md">');
		expect(expanded).toContain("# API contract");
	});

	it("does not read file references outside the workspace", async () => {
		const workspace = await makeTemporaryDirectory();

		const expanded = await expandFileReferences(
			"#[[file:../secret.txt]]",
			workspace,
		);

		expect(expanded).toContain("outside the workspace");
	});
});
