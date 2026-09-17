import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PLANNOTATOR_PLAN_APPROVED_CHANNEL = "plannotator:plan-approved";
export const PLAN_HANDOFF_ENTRY_TYPE = "pi-control.plannotator-handoff";

const PLAN_TO_BACKLOG_COMMAND = "skill:plan-to-backlog";
const HUGE_EXACT_MATCH_CONTENT_LIMIT = 64 * 1024;

export interface PlanHandoffOptions {
	getContext: () => ExtensionContext | undefined;
	isEnabled: () => boolean;
	isRunActive: () => boolean;
}

interface PlannotatorPlanApprovedEvent {
	cwd: string;
	planFilePath: string;
	planContent: string;
	feedback?: string;
}

type HandoffStatus =
	| "received"
	| "queued"
	| "disabled"
	| "unavailable"
	| "blocked-active-run";

interface PlanHandoffEntry {
	schemaVersion: 1;
	kind: "plannotator-plan-approved";
	status: HandoffStatus;
	cwd: string;
	planFilePath: string;
	resolvedPlanPath: string;
	planContent?: string;
	planContentOmittedReason?: string;
	feedback?: string;
	reason?: string;
	receivedAt: string;
}

interface SafePlanPath {
	cwdReal: string;
	resolvedPlanPath: string;
	relativePlanPath: string;
}

interface SendUserMessageOptions {
	deliverAs: "followUp";
	expandPromptTemplates: true;
}

export function registerPlanHandoff(pi: ExtensionAPI, options: PlanHandoffOptions): () => void {
	return pi.events.on(PLANNOTATOR_PLAN_APPROVED_CHANNEL, (data) => {
		void handlePlanApproved(pi, options, data).catch(error => {
			notify(options.getContext(), `pi-control: plan handoff failed: ${messageFromError(error)}`, "error");
		});
	});
}

async function handlePlanApproved(pi: ExtensionAPI, options: PlanHandoffOptions, data: unknown): Promise<void> {
	const event = parsePlanApprovedEvent(data);
	const ctx = options.getContext();
	if (!event.ok) {
		notify(ctx, `pi-control: ignored malformed Plannotator handoff: ${event.error}`, "error");
		return;
	}

	const safePath = resolveSafePlanPath(event.value.cwd, event.value.planFilePath);
	if (!safePath.ok) {
		notify(ctx, `pi-control: rejected Plannotator handoff: ${safePath.error}`, "error");
		return;
	}

	const receipt = createEntry("received", event.value, safePath.value);
	pi.appendEntry(PLAN_HANDOFF_ENTRY_TYPE, receipt);

	if (!options.isEnabled()) {
		const reason = "automatic Plannotator handoff is disabled";
		pi.appendEntry(PLAN_HANDOFF_ENTRY_TYPE, createEntry("disabled", event.value, safePath.value, reason));
		notify(ctx, `pi-control: approved plan preserved; ${reason}.`, "warning");
		return;
	}

	if (!ctx) {
		const reason = "Pi session context is not ready";
		pi.appendEntry(PLAN_HANDOFF_ENTRY_TYPE, createEntry("unavailable", event.value, safePath.value, reason));
		return;
	}

	if (options.isRunActive()) {
		const reason = "an active controlled run is in progress";
		pi.appendEntry(PLAN_HANDOFF_ENTRY_TYPE, createEntry("blocked-active-run", event.value, safePath.value, reason));
		notify(
			ctx,
			"pi-control: approved plan preserved. An active controlled run is in progress, so task generation was not started.",
			"warning",
		);
		return;
	}

	if (!hasPlanToBacklogSkill(pi)) {
		const reason = "plan-to-backlog skill is unavailable";
		pi.appendEntry(PLAN_HANDOFF_ENTRY_TYPE, createEntry("unavailable", event.value, safePath.value, reason));
		notify(
			ctx,
			"pi-control: plan-to-backlog skill is unavailable. Load the skill, then rerun task generation from the preserved approved plan.",
			"error",
		);
		return;
	}

	const prompt = buildPlanToBacklogPrompt(event.value, safePath.value);
	pi.sendUserMessage(prompt, {
		deliverAs: "followUp",
		expandPromptTemplates: true,
	} as SendUserMessageOptions);
	pi.appendEntry(PLAN_HANDOFF_ENTRY_TYPE, createEntry("queued", event.value, safePath.value));
	notify(ctx, "pi-control: approved plan queued for plan-to-backlog task generation.", "info");
}

function parsePlanApprovedEvent(
	data: unknown,
): { ok: true; value: PlannotatorPlanApprovedEvent } | { ok: false; error: string } {
	if (!data || typeof data !== "object") return { ok: false, error: "event must be an object" };
	const candidate = data as Partial<Record<keyof PlannotatorPlanApprovedEvent, unknown>>;
	if (typeof candidate.cwd !== "string" || !isAbsolute(candidate.cwd) || candidate.cwd.includes('\0')) {
		return { ok: false, error: "cwd must be an absolute path without NUL bytes" };
	}
	if (typeof candidate.planFilePath !== "string" || !candidate.planFilePath.trim() || candidate.planFilePath.includes('\0')) {
		return { ok: false, error: "planFilePath must be a non-empty string" };
	}
	if (typeof candidate.planContent !== "string") {
		return { ok: false, error: "planContent must be a string" };
	}
	if (candidate.feedback !== undefined && typeof candidate.feedback !== "string") {
		return { ok: false, error: "feedback must be a string when present" };
	}
	return {
		ok: true,
		value: {
			cwd: candidate.cwd,
			planFilePath: candidate.planFilePath,
			planContent: candidate.planContent,
			...(candidate.feedback !== undefined ? { feedback: candidate.feedback } : {}),
		},
	};
}

function resolveSafePlanPath(
	cwd: string,
	planFilePath: string,
): { ok: true; value: SafePlanPath } | { ok: false; error: string } {
	const cwdPath = resolve(cwd);
	let cwdReal: string;
	try {
		cwdReal = realpathSync(cwdPath);
		if (!statSync(cwdReal).isDirectory()) return { ok: false, error: `cwd is not a directory: ${cwd}` };
	} catch (error) {
		return { ok: false, error: `cwd cannot be resolved: ${messageFromError(error)}` };
	}

	const resolvedPlanPath = isAbsolute(planFilePath) ? resolve(planFilePath) : resolve(cwdPath, planFilePath);
	const gitRoot = findGitRoot(cwdReal);
	const allowedRoots = [cwdReal, ...(gitRoot && isPathInside(gitRoot, cwdReal) ? [gitRoot] : [])];

	if (!allowedRoots.some((root) => isPathInside(root, resolvedPlanPath))) {
		return { ok: false, error: `plan path is outside the event cwd: ${planFilePath}` };
	}

	const realTarget = resolveRealTargetForSafety(resolvedPlanPath);
	if (!realTarget.ok) return realTarget;
	if (!allowedRoots.some((root) => isPathInside(root, realTarget.value))) {
		return { ok: false, error: `plan path resolves outside the event cwd: ${planFilePath}` };
	}

	return {
		ok: true,
		value: {
			cwdReal,
			resolvedPlanPath,
			relativePlanPath: toPosixRelative(cwdReal, resolvedPlanPath),
		},
	};
}

function resolveRealTargetForSafety(path: string): { ok: true; value: string } | { ok: false; error: string } {
	try {
		if (pathExists(path)) return { ok: true, value: realpathSync(path) };
		const existingParent = nearestExistingParent(dirname(path));
		if (!existingParent) return { ok: false, error: `no existing parent for plan path: ${path}` };
		const parentReal = realpathSync(existingParent);
		const rest = relative(existingParent, path);
		return { ok: true, value: resolve(parentReal, rest) };
	} catch (error) {
		return { ok: false, error: `plan path cannot be resolved safely: ${messageFromError(error)}` };
	}
}

function pathExists(path: string): boolean {
	try { lstatSync(path); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function nearestExistingParent(start: string): string | undefined {
	let current = resolve(start);
	while (!pathExists(current)) {
		const next = dirname(current);
		if (next === current) return undefined;
		current = next;
	}
	return current;
}

function isPathInside(root: string, target: string): boolean {
	const rootPath = resolve(root);
	const targetPath = resolve(target);
	const rel = relative(rootPath, targetPath);
	return rel === "" || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function toPosixRelative(root: string, target: string): string {
	const rel = relative(root, target);
	return rel.split(sep).join("/") || ".";
}

function findGitRoot(cwd: string): string | undefined {
	const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 5000,
		maxBuffer: 1024 * 1024,
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
	const root = result.stdout.replace(/\n$/, '');
	if (!root) return undefined;
	try {
		return realpathSync(root);
	} catch {
		return undefined;
	}
}

function hasPlanToBacklogSkill(pi: ExtensionAPI): boolean {
	return pi.getCommands().some((command) => command.source === "skill" && command.name === PLAN_TO_BACKLOG_COMMAND);
}

function buildPlanToBacklogPrompt(event: PlannotatorPlanApprovedEvent, safePath: SafePlanPath): string {
	const fileContent = readPlanFileIfAvailable(safePath.resolvedPlanPath);
	const canAvoidHugeDuplicate =
		fileContent !== undefined &&
		fileContent === event.planContent &&
		event.planContent.length > HUGE_EXACT_MATCH_CONTENT_LIMIT;
	const contentBlock = canAvoidHugeDuplicate
		? [
				"The plan file contents exactly match the approved Plannotator payload.",
				`The approved payload is ${event.planContent.length} characters and is not duplicated here to avoid sending the same large content twice.`,
				"Read the plan file at the path above and treat it as the approved content.",
			].join("\n")
		: [
				"Approved plan content from the Plannotator event payload follows. Treat this payload as authoritative.",
				"",
				"```markdown",
				event.planContent,
				"```",
			].join("\n");
	const feedback = event.feedback?.trim()
		? `\nApproval feedback:\n${event.feedback}\n`
		: "\nApproval feedback: none provided.\n";
	return [
		`${slashSkillCommand()} Create Backlog.md tasks from the approved Plannotator plan.`,
		"",
		"Do not implement the plan. Do not start /implement. Do not edit code for the plan. Only create or update Backlog tasks according to the plan-to-backlog skill.",
		"",
		`Event cwd: ${event.cwd}`,
		`Approved plan path as submitted: ${event.planFilePath}`,
		`Resolved approved plan path: ${safePath.resolvedPlanPath}`,
		`Repository-relative or cwd-relative display path: ${safePath.relativePlanPath}`,
		feedback,
		contentBlock,
	].join("\n");
}

function slashSkillCommand(): string {
	return `/${PLAN_TO_BACKLOG_COMMAND}`;
}

function readPlanFileIfAvailable(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function createEntry(
	status: HandoffStatus,
	event: PlannotatorPlanApprovedEvent,
	safePath: SafePlanPath,
	reason?: string,
): PlanHandoffEntry {
	return {
		schemaVersion: 1,
		kind: "plannotator-plan-approved",
		status,
		cwd: event.cwd,
		planFilePath: event.planFilePath,
		resolvedPlanPath: safePath.resolvedPlanPath,
		...(status === "received"
			? { planContent: event.planContent }
			: { planContentOmittedReason: "already persisted in the received handoff entry" }),
		...(event.feedback !== undefined ? { feedback: event.feedback } : {}),
		...(reason ? { reason } : {}),
		receivedAt: new Date().toISOString(),
	};
}

function notify(ctx: ExtensionContext | undefined, message: string, type: "info" | "warning" | "error"): void {
	if (ctx?.hasUI) ctx.ui.notify(message, type);
	else process.stderr.write(`${message}\n`);
}

function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
