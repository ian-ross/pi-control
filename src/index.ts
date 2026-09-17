import { CONFIG_DIR_NAME, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ControlController, type ControlDependencies } from './commands.js';
import { ACCEPTANCE_EVIDENCE_MAX_ITEMS, ACCEPTANCE_EVIDENCE_MAX_LENGTH, ACCEPTANCE_SUMMARY_MAX_LENGTH } from './acceptance.js';

const acceptanceToolParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'taskDigest', 'codeDigest', 'summary', 'criteria'],
  properties: {
    taskId: { type: 'string' },
    taskDigest: { type: 'string' },
    codeDigest: { type: 'string' },
    summary: { type: 'string', minLength: 1, maxLength: ACCEPTANCE_SUMMARY_MAX_LENGTH },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'evidence'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['satisfied', 'unsatisfied', 'uncertain'] },
          evidence: { type: 'array', items: { type: 'string', minLength: 1, maxLength: ACCEPTANCE_EVIDENCE_MAX_LENGTH }, minItems: 1, maxItems: ACCEPTANCE_EVIDENCE_MAX_ITEMS },
        },
      },
    },
  },
};
import { isActive } from './state.js';
import { registerPlanHandoff } from './plannotator.js';

const commands: Record<string, string> = {
  implement: 'Claim and implement one Backlog task with scope enforcement and bounded repairs',
  'implement-resume': 'Resume a failed or restored task with a fresh repair budget',
  verify: 'Verify the active task without automatic repair',
  'verify-waive': 'Confirm a reasoned waiver of current failed command checks',
  'scope-show': 'Show original task scope and user additions',
  'scope-add': 'Confirm one run-local scope addition',
  'control-status': 'Show active workflow state and verification freshness',
  'control-abort': 'End enforcement without reverting changes',
  commit: 'Confirm and commit current verified or waived task changes',
};

export function registerControl(pi: ExtensionAPI, deps: ControlDependencies = {}): ControlController {
  const control = new ControlController(pi, CONFIG_DIR_NAME, deps);
  for (const [name, description] of Object.entries(commands)) {
    pi.registerCommand(name, { description, handler: (args, ctx) => control.execute(name, args, ctx) });
  }
  pi.registerTool?.({
    name: 'pi_control_acceptance_review',
    label: 'pi-control acceptance review',
    description: 'Submit the read-only acceptance assessment requested by pi-control. Call only after inspecting the task and verified code state.',
    promptSnippet: 'Submit pi-control acceptance review results',
    promptGuidelines: ['Use pi_control_acceptance_review only for a pi-control read-only acceptance review. It records the final assessment and ends the review turn.'],
    parameters: acceptanceToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return control.receiveAcceptanceTool(params, ctx);
    },
  } as Parameters<ExtensionAPI['registerTool']>[0]);
  pi.on('session_start', (_event, ctx) => control.initialize(ctx));
  pi.on('session_tree', (_event, ctx) => control.initialize(ctx));
  pi.on('agent_settled', (_event, ctx) => control.settled(ctx));
  pi.on('tool_call', event => control.gate(event));
  const unsubscribe = registerPlanHandoff(pi, {
    getContext: () => control.context,
    isEnabled: () => control.config.autoPlanHandoff,
    isRunActive: () => isActive(control.run) || control.busy,
  });
  pi.on('session_shutdown', () => { control.shutdown(); unsubscribe(); });
  return control;
}
export default function piControl(pi: ExtensionAPI): void { registerControl(pi); }
