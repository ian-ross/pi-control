import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerPlanHandoff, PLANNOTATOR_PLAN_APPROVED_CHANNEL } from "../src/plannotator.ts";

type Handler = (data: unknown) => void;

class FakeEventBus {
	readonly handlers = new Map<string, Handler[]>();

	on(channel: string, handler: Handler): () => void {
		const handlers = this.handlers.get(channel) ?? [];
		handlers.push(handler);
		this.handlers.set(channel, handlers);
		return () => {
			this.handlers.set(
				channel,
				(this.handlers.get(channel) ?? []).filter((candidate) => candidate !== handler),
			);
		};
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

interface FakeCommand {
	name: string;
	source: string;
}

function makeTempDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "pi-control-plannotator-")));
}

function createHarness(options: {
	commands?: FakeCommand[];
	ctx?: unknown;
	enabled?: boolean;
	runActive?: boolean;
} = {}) {
	const eventBus = new FakeEventBus();
	const sent: Array<{ content: string; options: Record<string, unknown> | undefined }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		events: eventBus,
		getCommands: () => options.commands ?? [{ name: "skill:plan-to-backlog", source: "skill" }],
		sendUserMessage: (content: string, sendOptions?: Record<string, unknown>) => {
			sent.push({ content, options: sendOptions });
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
	};
	const notifications: Array<{ message: string; type: string | undefined }> = [];
	const ctx = Object.hasOwn(options, "ctx")
		? options.ctx
		: {
				hasUI: true,
				ui: {
					notify: (message: string, type?: string) => notifications.push({ message, type }),
				},
			};
	const unsubscribe = registerPlanHandoff(pi as never, {
		getContext: () => ctx as never,
		isEnabled: () => options.enabled ?? true,
		isRunActive: () => options.runActive ?? false,
	});
	return { eventBus, sent, entries, notifications, unsubscribe };
}

test("dispatches approved plans through the plan-to-backlog skill expansion path", () => {
	const cwd = makeTempDir();
	try {
		writeFileSync(join(cwd, "plan.md"), "# Approved\n\n- [ ] Make task\n");
		const harness = createHarness();

		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "plan.md",
			planContent: "# Approved\n\n- [ ] Make task\n",
			feedback: "Split tests from implementation.",
		});

		assert.equal(harness.sent.length, 1);
		assert.equal(harness.sent[0]!.options?.deliverAs, "followUp");
		assert.equal(harness.sent[0]!.options?.expandPromptTemplates, true);
		assert.match(harness.sent[0]!.content, /^\/skill:plan-to-backlog\b/);
		assert.match(harness.sent[0]!.content, /Split tests from implementation\./);
		assert.match(harness.sent[0]!.content, /# Approved/);
		assert.doesNotMatch(harness.sent[0]!.content, /^\/implement\b/);
		assert.equal(harness.entries.length, 2);
		assert.equal(harness.entries[0]!.customType, "pi-control.plannotator-handoff");
		assert.equal((harness.entries[0]!.data as { status: string }).status, "received");
		assert.equal((harness.entries[1]!.data as { status: string }).status, "queued");
		assert.equal("planContent" in (harness.entries[1]!.data as Record<string, unknown>), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rejects malformed plan-approved events before persistence or dispatch", () => {
	const harness = createHarness();

	harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
		cwd: "/tmp",
		planFilePath: "plan.md",
		planContent: 42,
	});

	assert.equal(harness.sent.length, 0);
	assert.equal(harness.entries.length, 0);
	assert.match(harness.notifications[0]!.message, /malformed/i);
});

test("uses loaded skill commands from getCommands and reports a missing skill without fallback generation", () => {
	const cwd = makeTempDir();
	try {
		writeFileSync(join(cwd, "plan.md"), "approved");
		const harness = createHarness({ commands: [{ name: "plan-to-backlog", source: "extension" }] });

		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "plan.md",
			planContent: "approved",
		});

		assert.equal(harness.sent.length, 0);
		assert.equal(harness.entries.length, 2);
		assert.equal((harness.entries[0]!.data as { status: string }).status, "received");
		assert.equal((harness.entries[1]!.data as { status: string }).status, "unavailable");
		assert.match(harness.notifications[0]!.message, /plan-to-backlog skill is unavailable/i);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("rejects traversal and symlink plan paths outside the event cwd", () => {
	const cwd = makeTempDir();
	const outside = makeTempDir();
	try {
		writeFileSync(join(outside, "plan.md"), "outside");
		symlinkSync(join(outside, "plan.md"), join(cwd, "link.md"));
		const harness = createHarness();

		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "../outside-plan.md",
			planContent: "bad traversal",
		});
		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "link.md",
			planContent: "bad symlink",
		});

		assert.equal(harness.sent.length, 0);
		assert.equal(harness.entries.length, 0);
		assert.equal(harness.notifications.length, 2);
		assert.match(harness.notifications.map((item) => item.message).join("\n"), /outside/i);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("preserves the approved plan instead of generating tasks while a controlled run is active", () => {
	const cwd = makeTempDir();
	try {
		writeFileSync(join(cwd, "plan.md"), "approved");
		const harness = createHarness({ runActive: true });

		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "plan.md",
			planContent: "approved",
		});

		assert.equal(harness.sent.length, 0);
		assert.equal(harness.entries.length, 2);
		assert.equal((harness.entries[1]!.data as { status: string }).status, "blocked-active-run");
		assert.match(harness.notifications[0]!.message, /active controlled run/i);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("persists a receipt when the handoff cannot run because no session context is available", () => {
	const cwd = makeTempDir();
	try {
		writeFileSync(join(cwd, "plan.md"), "approved");
		const harness = createHarness({ ctx: undefined });

		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "plan.md",
			planContent: "approved",
		});

		assert.equal(harness.sent.length, 0);
		assert.equal(harness.entries.length, 2);
		assert.equal((harness.entries[0]!.data as { status: string }).status, "received");
		assert.equal((harness.entries[1]!.data as { status: string }).status, "unavailable");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("does not duplicate exact huge plan file content in the skill prompt", () => {
	const cwd = makeTempDir();
	try {
		const huge = `# Approved\n\n${"x".repeat(70_000)}`;
		writeFileSync(join(cwd, "plan.md"), huge);
		const harness = createHarness();

		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "plan.md",
			planContent: huge,
		});

		assert.equal(harness.sent.length, 1);
		assert.ok(harness.sent[0]!.content.length < 10_000);
		assert.match(harness.sent[0]!.content, /file contents exactly match/i);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("keeps mismatched approved payload content authoritative instead of truncating it", () => {
	const cwd = makeTempDir();
	try {
		const huge = `# Approved payload\n\n${"y".repeat(70_000)}`;
		writeFileSync(join(cwd, "plan.md"), "different on disk");
		const harness = createHarness();

		harness.eventBus.emit(PLANNOTATOR_PLAN_APPROVED_CHANNEL, {
			cwd,
			planFilePath: "plan.md",
			planContent: huge,
		});

		assert.equal(harness.sent.length, 1);
		assert.ok(harness.sent[0]!.content.includes(huge));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
